/**
 * PARTY BOX — the game (server side, authoritative)
 *
 *   LOBBY -> [PICKING] -> WRITING -> VOTING -> RESULTS -> … x3 -> SCORES
 *
 * This module owns the rules and the clock. It never touches a socket: it
 * mutates its own state, then calls ctx.sync(), and the core turns views()
 * into versioned entities for each client. Phones and the TV only render.
 *
 * PICKING: each normal round, one player (rotating) chooses the category from
 * a few options. Categories already played this game come back `disabled`, so
 * a game still spans different topics. If the picker stalls, the timer picks.
 * Personal-prompt rounds skip it — the prompt is about someone in the room.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { QUESTIONS: SETUP_QUESTIONS, buildPersonal } = require(path.join(ROOT, 'personal'));
const SEEDS = require(path.join(ROOT, 'seeds'));
const { GROUP_NAMES, dealPrompt } = require('./dealer');
const { makeHouseAnswers } = require('./house');
const { pickPersonalRounds } = require('./schedule');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

const ROUNDS = 3;
const POINTS_PER_VOTE = 100;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const SEEDS_PER_PLAYER = env('SEEDS_PER_PLAYER', 5);
const PERSONAL_ROUNDS = env('PERSONAL_ROUNDS', 2);
const PICKING_ON = env('PICKING', 1) !== 0;
const PICK_CHOICES = 4;
// House answers: decoys the game adds to every vote (see house.js). The vote
// is topped up to at least MIN_CHOICES options, with 1–2 decoys per round.
const HOUSE_ON = env('HOUSE', 1) !== 0;
const MIN_CHOICES = 3;
const MAX_HOUSE = 2;
// A player who drops (screen lock, reload) still "holds" the round this long,
// so the room doesn't race ahead while their phone reconnects. After that the
// phase timer covers them.
const DROP_HOLD_MS = env('DROP_HOLD', 30) * 1000;

const TIMERS = {
  PICKING: env('T_PICKING', 12),
  WRITING: env('T_WRITING', 60),
  VOTING: env('T_VOTING', 25),
  RESULTS: env('T_RESULTS', 12),
};

// One look per seat. Shapes as well as colours, so it still works for
// colour-blind players and on a washed-out TV.
const AVATARS = [
  { color: '#ff5e7a', glyph: '●' }, { color: '#45e0b0', glyph: '▲' },
  { color: '#ffc64a', glyph: '■' }, { color: '#8b7fff', glyph: '◆' },
  { color: '#7fd4ff', glyph: '★' }, { color: '#ff9a3c', glyph: '✚' },
  { color: '#c65cff', glyph: '♥' }, { color: '#8fe36b', glyph: '♣' },
  { color: '#ff4fa3', glyph: '♠' }, { color: '#f6f0e4', glyph: '☀' },
];

const rid = () => Math.random().toString(36).slice(2, 8);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function create(ctx) {
  const s = {
    phase: 'LOBBY',
    round: 0,
    prompt: null,
    category: null,        // the category a player picked, if any
    personalRound: false,
    deadline: null,
    timer: null,
    personalOn: true,
    houseOn: HOUSE_ON,
    spareSeeds: [],        // seeds nobody was dealt this round (house answers use them)
    voteSkipped: false,    // the round had no answers to vote on
    roundWinners: [],      // answer ids that topped this round's vote (ties share)
    personalRounds: new Set(),
    personalUsed: new Set(),
    usedPersonalFrames: new Set(),
    bk: { usedPrompts: new Set(), usedGroups: new Set(), usedSources: new Set() },
    seats: new Map(),      // userId -> per-player game data
    pick: null,            // { picker: userId, choices: [{id,label,disabled}] }
    pickedBy: new Set(),   // who has picked this game, for rotation
    answers: [],           // built at VOTING: [{id, author, text}]
    audienceVotes: new Map(), // audience userId -> answer id (this round)
  };

  // ---------------------------------------------------------------- helpers
  const member = (uid) => ctx.member(uid);
  const isConnected = (uid) => { const m = member(uid); return !!(m && m.conn); };
  const seatList = () =>
    ctx.players().map((m) => ({ m, p: s.seats.get(m.userId) })).filter((x) => x.p).sort((a, b) => a.m.joinedAt - b.m.joinedAt);
  const connectedSeats = () => seatList().filter((x) => x.m.conn);
  const vipId = () => { const first = seatList()[0]; return first ? first.m.userId : null; };

  function clearTimer() {
    clearTimeout(s.timer);
    s.timer = null;
    s.deadline = null;
  }
  function startTimer(seconds, fn) {
    clearTimer();
    s.deadline = Date.now() + seconds * 1000;
    s.timer = setTimeout(() => { s.timer = null; s.deadline = null; fn(); }, seconds * 1000);
  }

  // --------------------------------------------------------------- flow
  function startGame() {
    s.round = 0;
    for (const p of s.seats.values()) p.score = 0;
    s.personalRounds = new Set();
    s.personalUsed = new Set();
    s.pickedBy = new Set();
    const eligible = connectedSeats().filter((x) => x.p.allowPersonal);
    // How many and which rounds are personal is randomised per game, leaning
    // away from round 1 — see schedule.js.
    if (s.personalOn) s.personalRounds = pickPersonalRounds({ rounds: ROUNDS, max: PERSONAL_ROUNDS, eligible: eligible.length });
    startRound();
  }

  function personalPrompt() {
    if (!(s.personalOn && s.personalRounds.has(s.round))) return null;
    const targets = connectedSeats().filter((x) => x.p.allowPersonal && !s.personalUsed.has(x.m.userId));
    if (!targets.length) return null; // everyone opted out or already had a turn
    const t = targets[Math.floor(Math.random() * targets.length)];
    s.personalUsed.add(t.m.userId);
    const built = buildPersonal({ name: t.m.name, setupQ: t.p.setupQ, setupA: t.p.setupA }, s.usedPersonalFrames);
    s.usedPersonalFrames.add(built.frame);
    return built.text;
  }

  function startRound() {
    s.round += 1;
    s.prompt = null;
    s.category = null;
    s.pick = null;
    s.answers = [];
    s.voteSkipped = false;
    s.roundWinners = [];
    s.audienceVotes = new Map();
    for (const p of s.seats.values()) {
      p.answer = null;
      p.votedFor = null;
      p.seeds = [];
      p.lastRound = null;
    }

    const personal = personalPrompt();
    s.personalRound = !!personal;
    if (personal) {
      s.prompt = personal;
      return enterWriting();
    }
    if (PICKING_ON && connectedSeats().length) return enterPicking();
    s.prompt = dealPrompt(s.bk).text;
    enterWriting();
  }

  function enterPicking() {
    const live = connectedSeats();
    let pool = live.filter((x) => !s.pickedBy.has(x.m.userId));
    if (!pool.length) { s.pickedBy = new Set(); pool = live; }
    const picker = pool[0].m.userId;
    s.pickedBy.add(picker);

    // Mostly fresh categories, plus one already-played one shown disabled so
    // the picker can see why it's off the table.
    const fresh = shuffle(GROUP_NAMES.filter((g) => !s.bk.usedGroups.has(g)));
    const used = shuffle(GROUP_NAMES.filter((g) => s.bk.usedGroups.has(g)));
    const labels = used.length
      ? [...fresh.slice(0, PICK_CHOICES - 1), used[0]]
      : fresh.slice(0, PICK_CHOICES);
    s.pick = {
      picker,
      choices: shuffle(labels).map((label, i) => ({ id: 'c' + i, label, disabled: s.bk.usedGroups.has(label) })),
    };
    s.phase = 'PICKING';
    startTimer(TIMERS.PICKING, autoPick);
    ctx.touch();
    ctx.sync();
  }

  function choose(choice) {
    if (s.phase !== 'PICKING' || !s.pick) return;
    s.category = choice.label;
    s.prompt = dealPrompt(s.bk, choice.label).text;
    enterWriting();
  }

  function autoPick() {
    if (s.phase !== 'PICKING' || !s.pick) return;
    const open = s.pick.choices.filter((c) => !c.disabled);
    choose(open[Math.floor(Math.random() * open.length)]);
  }

  function enterWriting() {
    s.phase = 'WRITING';
    // Private hands, off one shuffled deck, so nobody shares a scrap.
    const deck = shuffle([...SEEDS]);
    for (const p of s.seats.values()) p.seeds = deck.splice(0, SEEDS_PER_PLAYER);
    s.spareSeeds = deck;
    startTimer(TIMERS.WRITING, enterVoting);
    ctx.touch();
    ctx.sync();
  }

  function enterVoting() {
    if (s.phase !== 'WRITING') return;
    clearTimer();
    // Answers get fresh opaque ids and a shuffled order, so nothing on the
    // wire links an answer to its author until the reveal.
    const real = [...s.seats.entries()].filter(([, p]) => p.answer).map(([uid, p]) => ({ id: rid(), author: uid, text: p.answer }));
    // The box plants its decoys. With house answers on, even a round where
    // only one person answered still gets a vote.
    const houseCount = s.houseOn && real.length ? Math.min(MAX_HOUSE, Math.max(1, MIN_CHOICES - real.length)) : 0;
    const house = makeHouseAnswers(houseCount, s.spareSeeds, real.map((a) => a.text))
      .map((text) => ({ id: rid(), author: 'house', text }));
    s.answers = shuffle([...real, ...house]);
    s.phase = 'VOTING';
    if (s.answers.length < 2) { s.voteSkipped = true; return enterResults(); }
    startTimer(TIMERS.VOTING, enterResults);
    ctx.touch();
    ctx.sync();
  }

  function enterResults() {
    if (s.phase !== 'WRITING' && s.phase !== 'VOTING') return;
    clearTimer();
    for (const [, p] of s.seats) {
      if (!p.votedFor) continue;
      const a = s.answers.find((x) => x.id === p.votedFor);
      const author = a && s.seats.get(a.author);
      if (author) author.score += POINTS_PER_VOTE;
    }
    const tally = (a) => [...s.seats.values()].filter((v) => v.votedFor === a.id).length;
    const playerAnswers = s.answers.filter((a) => a.author !== 'house');
    const best = Math.max(0, ...playerAnswers.map(tally));
    s.roundWinners = best > 0 ? playerAnswers.filter((a) => tally(a) === best).map((a) => a.id) : [];
    for (const [uid, p] of s.seats) {
      const mine = s.answers.find((a) => a.author === uid);
      const votes = mine ? [...s.seats.values()].filter((v) => v.votedFor === mine.id).length : 0;
      const picked = p.votedFor && s.answers.find((a) => a.id === p.votedFor);
      p.lastRound = {
        votes,
        points: votes * POINTS_PER_VOTE,
        answered: !!p.answer,
        fooled: !!(picked && picked.author === 'house'),
        roundWinner: !!(mine && s.roundWinners.includes(mine.id)),
        noVote: s.voteSkipped,
      };
    }
    s.phase = 'RESULTS';
    startTimer(TIMERS.RESULTS, advanceFromResults);
    ctx.touch();
    ctx.sync();
  }

  function advanceFromResults() {
    if (s.phase !== 'RESULTS') return;
    clearTimer();
    if (s.round >= ROUNDS) {
      s.phase = 'SCORES';
      ctx.touch();
      ctx.sync();
    } else {
      startRound();
    }
  }

  function skip() {
    if (s.phase === 'PICKING') autoPick();
    else if (s.phase === 'WRITING') enterVoting();
    else if (s.phase === 'VOTING') enterResults();
    else if (s.phase === 'RESULTS') advanceFromResults();
  }

  function backToLobby() {
    clearTimer();
    s.phase = 'LOBBY';
    s.round = 0;
    s.prompt = null;
    s.category = null;
    s.pick = null;
    s.answers = [];
    s.bk = { usedPrompts: new Set(), usedGroups: new Set(), usedSources: new Set() };
    s.personalRounds = new Set();
    s.personalUsed = new Set();
    for (const p of s.seats.values()) {
      p.score = 0; p.answer = null; p.votedFor = null; p.seeds = []; p.lastRound = null;
    }
    // Anyone still gone gives up their seat for the next game.
    for (const { m } of seatList()) if (!m.conn) ctx.release(m.userId);
    ctx.sync();
  }

  // Advance early once every player still holding the round is done:
  // everyone connected, plus anyone who dropped less than DROP_HOLD_MS ago
  // (a screen lock or reload shouldn't skip their turn). Players gone longer
  // don't hold up the room; the phase timer covers them.
  function maybeAdvance() {
    const now = Date.now();
    const live = seatList().filter((x) => x.m.conn || (x.m.goneAt && now - x.m.goneAt < DROP_HOLD_MS));
    if (!live.some((x) => x.m.conn)) return;
    if (s.phase === 'PICKING' && s.pick && !s.seats.has(s.pick.picker)) autoPick();
    else if (s.phase === 'WRITING' && live.every((x) => x.p.answer)) enterVoting();
    else if (s.phase === 'VOTING' && live.every((x) => x.p.votedFor)) enterResults();
  }

  function autoAnswer(p) {
    // Lean on the player's own hand first: those scraps were dealt to them,
    // so it still reads as "their" answer. Fall back to the whole bank.
    const hand = p.seeds && p.seeds.length ? p.seeds : SEEDS;
    return hand[Math.floor(Math.random() * hand.length)];
  }

  // --------------------------------------------------------------- messages
  const ok = { ok: true };
  const no = (error) => ({ ok: false, error });

  function onMessage(actor, op, data) {
    // ---- the TV ----
    if (actor.role === 'host') {
      switch (op) {
        case 'host/start':
          if (s.phase !== 'LOBBY') return no('not-in-lobby');
          if (connectedSeats().length < MIN_PLAYERS) return no('need-players');
          startGame();
          return ok;
        case 'host/skip':
          skip();
          return ok;
        case 'host/restart':
          backToLobby();
          return ok;
        case 'host/house':
          s.houseOn = !!data.on;
          ctx.sync();
          return ok;
        case 'host/personal':
          s.personalOn = !!data.on;
          ctx.sync();
          return ok;
        case 'host/swap': {
          if (s.phase !== 'WRITING') return no('not-writing');
          if ([...s.seats.values()].some((p) => p.answer)) return no('already-answered');
          s.prompt = s.category ? dealPrompt(s.bk, s.category).text : s.personalRound ? s.prompt : dealPrompt(s.bk).text;
          startTimer(TIMERS.WRITING, enterVoting);
          ctx.sync();
          return ok;
        }
      }
      return no('unknown-opcode');
    }

    // ---- the audience: can only add to the shared counters ----
    if (actor.role === 'audience') {
      if (op !== 'audience/vote') return no('not-allowed');
      if (s.phase !== 'VOTING') return no('not-voting');
      if (s.audienceVotes.has(actor.userId)) return no('already-voted');
      if (!s.answers.some((a) => a.id === data.id)) return no('bad-choice');
      s.audienceVotes.set(actor.userId, data.id);
      ctx.syncSoon();
      return ok;
    }

    // ---- players ----
    const p = s.seats.get(actor.userId);
    if (!p) return no('not-seated');
    switch (op) {
      case 'lobby/setup': {
        if (s.phase !== 'LOBBY') return no('not-in-lobby');
        if (typeof data.allowPersonal === 'boolean') p.allowPersonal = data.allowPersonal;
        if (data.answer !== undefined) p.setupA = String(data.answer || '').trim().slice(0, 60) || null;
        ctx.sync();
        return ok;
      }
      case 'lobby/start':
        if (vipId() !== actor.userId) return no('not-vip');
        if (s.phase !== 'LOBBY') return no('not-in-lobby');
        if (connectedSeats().length < MIN_PLAYERS) return no('need-players');
        startGame();
        return ok;
      case 'lobby/restart':
        if (vipId() !== actor.userId) return no('not-vip');
        if (s.phase !== 'SCORES') return no('not-finished');
        backToLobby();
        return ok;
      case 'pick/choose': {
        if (s.phase !== 'PICKING' || !s.pick) return no('not-picking');
        if (s.pick.picker !== actor.userId) return no('not-your-pick');
        const c = s.pick.choices.find((x) => x.id === data.id);
        if (!c) return no('bad-choice');
        if (c.disabled) return no('choice-disabled');
        choose(c);
        return ok;
      }
      case 'write/answer': {
        if (s.phase !== 'WRITING') return no('not-writing');
        if (p.answer) return no('already-answered');
        const clean = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (!clean) return no('empty');
        p.answer = clean;
        ctx.sync();
        maybeAdvance();
        return ok;
      }
      case 'write/auto': {
        if (s.phase !== 'WRITING') return no('not-writing');
        if (p.answer) return no('already-answered');
        p.answer = autoAnswer(p);
        ctx.sync();
        maybeAdvance();
        return ok;
      }
      case 'vote/cast': {
        if (s.phase !== 'VOTING') return no('not-voting');
        if (p.votedFor) return no('already-voted');
        const a = s.answers.find((x) => x.id === data.id);
        if (!a) return no('bad-choice');
        if (a.author === actor.userId) return no('own-answer');
        p.votedFor = a.id;
        ctx.sync();
        maybeAdvance();
        return ok;
      }
    }
    return no('unknown-opcode');
  }

  // --------------------------------------------------------------- seats
  function onJoin(m) {
    if (m.role !== 'player') return;
    const usedIdx = new Set([...s.seats.values()].map((p) => p.index));
    let index = 0;
    while (usedIdx.has(index)) index++;
    // A setup question nobody else in the room has, so answers vary.
    const taken = new Set([...s.seats.values()].map((p) => p.setupQ));
    const free = SETUP_QUESTIONS.map((_, i) => i).filter((i) => !taken.has(i));
    const bag = free.length ? free : SETUP_QUESTIONS.map((_, i) => i);
    s.seats.set(m.userId, {
      index,
      score: 0,
      answer: null,
      votedFor: null,
      seeds: [],
      lastRound: null,
      setupQ: bag[Math.floor(Math.random() * bag.length)],
      setupA: null,
      allowPersonal: true,
    });
  }
  function onReconnect() {}
  function onDisconnect() {
    // Once their hold runs out, they stop blocking an early advance.
    const t = setTimeout(maybeAdvance, DROP_HOLD_MS + 50);
    if (t.unref) t.unref();
  }
  function onRemove(m) {
    s.seats.delete(m.userId);
    s.audienceVotes.delete(m.userId);
    maybeAdvance();
  }

  // --------------------------------------------------------------- views
  function views() {
    const seats = seatList();
    // Standard competition ranking: equal scores share a place (1, 1, 3…).
    const rankOf = (score) => 1 + seats.filter((x) => x.p.score > score).length;
    const live = seats.filter((x) => x.m.conn);
    const vip = vipId();
    const pickerName = s.pick ? (member(s.pick.picker) || {}).name || '' : '';
    const pickerSeat = s.pick ? member(s.pick.picker) : null;
    const canStart = s.phase === 'LOBBY' && live.length >= MIN_PLAYERS;

    let answers = [];
    if (s.phase === 'VOTING') answers = s.answers.map((a) => ({ id: a.id, text: a.text }));
    else if (s.phase === 'RESULTS') {
      answers = s.answers.map((a) => {
        if (a.author === 'house') {
          const fooled = seats.filter((x) => x.p.votedFor === a.id).map((x) => x.m.name);
          return { id: a.id, text: a.text, name: 'The Box', authorId: null, isHouse: true, votes: fooled };
        }
        const author = member(a.author);
        const voters = seats.filter((x) => x.p.votedFor === a.id).map((x) => x.m.name);
        return {
          id: a.id, text: a.text, name: author ? author.name : '(left)', authorId: author ? author.id : null,
          votes: voters, points: voters.length * POINTS_PER_VOTE, winner: s.roundWinners.includes(a.id),
        };
      });
    }

    const room = {
      phase: s.phase,
      round: s.round,
      totalRounds: ROUNDS,
      prompt: s.phase === 'PICKING' ? null : s.prompt,
      category: s.category,
      voteSkipped: s.phase === 'RESULTS' && s.voteSkipped,
      personalRound: s.personalRound,
      deadline: s.deadline,
      durations: TIMERS,
      hostConnected: ctx.hostConnected(),
      players: seats.map(({ m, p }) => ({
        id: m.id,
        index: p.index,
        name: m.name,
        avatar: AVATARS[p.index % AVATARS.length],
        score: p.score,
        connected: !!m.conn,
        isVIP: m.userId === vip,
        hasAnswered: !!p.answer,
        hasVoted: !!p.votedFor,
      })),
      lobby: s.phase === 'LOBBY'
        ? {
            personalOn: s.personalOn,
            houseOn: s.houseOn,
            setupDone: live.filter((x) => x.p.setupA || !x.p.allowPersonal).length,
            minPlayers: MIN_PLAYERS,
            maxPlayers: MAX_PLAYERS,
            canStart,
            vipName: vip ? member(vip).name : null,
          }
        : null,
      pick: s.phase === 'PICKING' && s.pick
        ? { pickerId: pickerSeat ? pickerSeat.id : null, pickerName, choices: s.pick.choices }
        : null,
      answers,
      // Final standings, best first. Everyone tied for the top score is a winner.
      standings: s.phase === 'SCORES'
        ? [...seats].sort((a, b) => b.p.score - a.p.score).map(({ m, p }) => ({
            id: m.id, name: m.name, avatar: AVATARS[p.index % AVATARS.length], score: p.score,
            rank: rankOf(p.score), winner: rankOf(p.score) === 1,
          }))
        : null,
      audienceCount: ctx.audience().filter((m) => m.conn).length,
    };

    const counts = {};
    for (const id of s.audienceVotes.values()) counts[id] = (counts[id] || 0) + 1;
    const audience = { round: s.round, open: s.phase === 'VOTING', counts, total: s.audienceVotes.size };

    const host = {
      canStart,
      canSkip: ['PICKING', 'WRITING', 'VOTING', 'RESULTS'].includes(s.phase),
      canSwap: s.phase === 'WRITING' && ![...s.seats.values()].some((p) => p.answer),
      personalOn: s.personalOn,
      houseOn: s.houseOn,
    };

    const players = {};
    for (const { m, p } of seats) {
      const isVIP = m.userId === vip;
      const q = SETUP_QUESTIONS[p.setupQ];
      const mine = s.answers.find((a) => a.author === m.userId);
      players[m.userId] = {
        id: m.id,
        index: p.index,
        name: m.name,
        avatar: AVATARS[p.index % AVATARS.length],
        score: p.score,
        isVIP,
        permissions: {
          canStartGame: isVIP && canStart,
          canRestart: isVIP && s.phase === 'SCORES',
          canSetup: s.phase === 'LOBBY',
          canPick: s.phase === 'PICKING' && !!s.pick && s.pick.picker === m.userId,
          canWrite: s.phase === 'WRITING' && !p.answer,
          canVote: s.phase === 'VOTING' && !p.votedFor && s.answers.some((a) => a.author !== m.userId),
        },
        setup: s.phase === 'LOBBY' && q
          ? { ask: q.ask, hint: q.hint, stem: q.stem, answer: p.setupA, allowPersonal: p.allowPersonal }
          : null,
        prompt: s.phase === 'WRITING' || s.phase === 'VOTING' ? s.prompt : null,
        seeds: s.phase === 'WRITING' && !p.answer ? p.seeds : [],
        answer: p.answer,
        // The server leaves your own answer out — the phone never has to.
        choices: s.phase === 'VOTING' ? s.answers.filter((a) => a.author !== m.userId).map((a) => ({ id: a.id, text: a.text })) : [],
        votedFor: p.votedFor,
        myAnswerId: mine ? mine.id : null,
        lastRound: s.phase === 'RESULTS' ? p.lastRound : null,
        place: s.phase === 'SCORES' ? rankOf(p.score) : null,
        tied: s.phase === 'SCORES' && seats.filter((x) => x.p.score === p.score).length > 1,
      };
    }

    const audienceMembers = {};
    for (const m of ctx.audience()) {
      audienceMembers[m.userId] = {
        id: m.id,
        name: m.name,
        votedFor: s.audienceVotes.get(m.userId) || null,
        canVote: s.phase === 'VOTING' && !s.audienceVotes.has(m.userId) && s.answers.length >= 2,
      };
    }

    return { room, audience, host, players, audienceMembers };
  }

  return {
    status: () => ({ phase: s.phase, inProgress: s.phase !== 'LOBBY', acceptingPlayers: s.phase === 'LOBBY' }),
    onJoin,
    onReconnect,
    onDisconnect,
    onRemove,
    onMessage,
    views,
    destroy: clearTimer,
  };
}

module.exports = {
  type: 'party-box',
  title: 'Party Box',
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  audience: true,
  create,
};
