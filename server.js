/**
 * PARTY BOX — server
 *
 * Two views, one server:
 *   /host  -> the TV screen (creates the room, shows the code, shows everything public)
 *   /      -> the phone controller (joins with the code, private input)
 *
 * GAME LOOP (fill-in-the-blank, anonymous answers, popular vote):
 *   LOBBY -> WRITING -> VOTING -> RESULTS -> (next round) -> SCORES
 *
 * IDENTITY MODEL — the important part
 * ---------------------------------------------------------------------------
 * A player is identified by a `pid` token their own browser holds, NOT by their
 * socket. Sockets die constantly over the internet: screen locks, wifi-to-
 * cellular handoff, walking past a thick wall. If identity were the socket,
 * every one of those would cost the player their seat and their score.
 *
 * So: the server issues a pid on join, the client stashes it, and on reconnect
 * the client presents the pid to reclaim its seat. Same idea for the host, via
 * a hostToken. Votes reference pids too, so a vote survives its voter dropping.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Be patient before declaring a socket dead — many mobile "drops" are just a
  // few seconds of nothing, and riding those out beats a full reconnect.
  pingInterval: 25000,
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const ROUNDS = 3;
const POINTS_PER_VOTE = 100;
const MAX_PLAYERS = 10;

const TIMERS = {
  WRITING: Number(process.env.T_WRITING) || 60,
  VOTING: Number(process.env.T_VOTING) || 25,
  RESULTS: Number(process.env.T_RESULTS) || 12,
};

// Grace periods. A dropped host shouldn't kill a game in progress, and a
// dropped player shouldn't lose their seat over a screen lock.
const HOST_GRACE_MS = (Number(process.env.HOST_GRACE) || 120) * 1000;
const PLAYER_GRACE_MS = (Number(process.env.PLAYER_GRACE) || 900) * 1000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // hard ceiling on an abandoned room
const SWEEP_MS = 60 * 1000;

// Rate limits — cheap insurance against someone hammering the server.
const MAX_ROOMS_PER_IP = 15;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_EVENTS_PER_SOCKET = 60;
const EVENT_WINDOW_MS = 10 * 1000;

// ---------------------------------------------------------------------------
// Prompts live in their own file so they're easy to find and edit.
// Open prompts.js — that's the whole game.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE POOL
// Hand-written prompts (prompts.js) plus everything the frames in
// templates.js expand into. Every entry carries its category and its source,
// which is what lets the dealer below guarantee a spread of topics.
// ---------------------------------------------------------------------------
const RAW_PROMPTS = require('./prompts');
const { expand: expandTemplates } = require('./templates');
// Prompts built around the people in the room — see personal.js for the
// rule that keeps them affectionate rather than cruel.
const { QUESTIONS: SETUP_QUESTIONS, buildPersonal } = require('./personal');
// How many rounds of a game use a personal prompt. One is plenty: they land
// hardest as a surprise, and every round being about the room gets tiring.
const PERSONAL_ROUNDS = Number(process.env.PERSONAL_ROUNDS ?? 2);

const POOL = [
  ...Object.entries(RAW_PROMPTS.GROUPS || { Misc: RAW_PROMPTS }).flatMap(([group, items]) =>
    items.map((text) => ({ text, group, source: 'written' }))
  ),
  ...expandTemplates(),
];

const GROUP_NAMES = [...new Set(POOL.map((p) => p.group))];

// ---------------------------------------------------------------------------
// Cross-session freshness
// Rooms are in-memory, so without this the same laptop would serve the same
// early prompts every game night. We keep a rolling list of what's been used
// on disk and skip those until the pool is mostly spent, then start over.
// Best-effort in every direction: if the file can't be read or written, the
// game just deals without the history.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const USED_FILE = process.env.USED_FILE || path.join(__dirname, '.used-prompts.json');
const USED_CAP = Math.floor(POOL.length * 0.7); // recycle before we run dry

let usedPrompts = [];
try {
  const disk = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
  if (Array.isArray(disk)) usedPrompts = disk.filter((t) => typeof t === 'string');
} catch (_) { /* first run, or no writable disk — fine */ }

let saveQueued = false;
function rememberUsed(text) {
  usedPrompts.push(text);
  if (usedPrompts.length > USED_CAP) usedPrompts = usedPrompts.slice(-Math.floor(USED_CAP / 2));
  if (saveQueued) return;
  saveQueued = true;
  // Batch writes — a game generates a handful of these in quick succession.
  setTimeout(() => {
    saveQueued = false;
    try { fs.writeFileSync(USED_FILE, JSON.stringify(usedPrompts)); } catch (_) {}
  }, 2000).unref();
}

/**
 * Deal one prompt for a room.
 *
 * Blend is enforced HERE rather than by keeping the categories the same size.
 * Each round picks a category the room hasn't used this game, so a three-round
 * game always spans three topics even though religion holds 21 prompts and
 * family holds 14. It also avoids reusing a template frame within a game, so
 * you never get two prompts cut from the same cloth back to back.
 */
function dealPrompt(room) {
  const freshGroups = GROUP_NAMES.filter((g) => !room.usedGroups.has(g));
  const groupPool = freshGroups.length ? freshGroups : GROUP_NAMES;

  const eligible = (relaxUsed, relaxSource) =>
    POOL.filter(
      (p) =>
        groupPool.includes(p.group) &&
        !room.usedPrompts.has(p.text) &&
        (relaxSource || p.source === 'written' || !room.usedSources.has(p.source)) &&
        (relaxUsed || !usedPrompts.includes(p.text))
    );

  // Widen the net step by step rather than ever failing to deal.
  let candidates = eligible(false, false);
  if (!candidates.length) candidates = eligible(true, false);
  if (!candidates.length) candidates = eligible(true, true);
  if (!candidates.length) candidates = POOL.filter((p) => !room.usedPrompts.has(p.text));
  if (!candidates.length) candidates = POOL;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  room.usedGroups.add(pick.group);
  room.usedPrompts.add(pick.text);
  if (pick.source !== 'written') room.usedSources.add(pick.source);
  rememberUsed(pick.text);
  return pick;
}
// Short scraps of raw material dealt privately to each player each round, to
// give whoever is staring at an empty box something to push off from.
const SEEDS = require('./seeds');
const SEEDS_PER_PLAYER = Number(process.env.SEEDS_PER_PLAYER) || 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const rooms = new Map();    // code -> room
const sockets = new Map();  // socket.id -> { code, pid }   (pid === 'host' for the TV)

app.set('trust proxy', true);
app.use(express.static(__dirname + '/public'));
app.get('/host', (req, res) => res.sendFile(__dirname + '/public/host.html'));
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const token = () => crypto.randomBytes(16).toString('hex');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeCode() {
  // No vowels (avoids accidental words), no I/O/0/1 (avoids squinting at the TV)
  const letters = 'BCDFGHJKLMNPQRSTVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostToken: token(),
    hostSocketId: null,
    hostGoneAt: null,
    phase: 'LOBBY',
    players: [],  // { pid, name, score, answer, votedFor, socketId, connected, goneAt }
    prompt: null,
    round: 0,
    personalOn: true,          // host can switch personal prompts off entirely
    personalRounds: new Set(),  // which round numbers are personal this game
    personalUsed: new Set(),    // players already targeted, so nobody repeats
    usedPersonalFrames: new Set(), // frames spent this session, for variety
    // Per-game freshness bookkeeping, consumed by dealPrompt().
    usedPrompts: new Set(),   // never repeat a prompt inside one game
    usedGroups: new Set(),    // and never repeat a category — this is the blend
    usedSources: new Set(),   // nor two prompts from the same template frame
    deadline: null,
    timerHandle: null,
    qr: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function touch(room) { room.lastActivity = Date.now(); }

function destroyRoom(room, reason) {
  clearTimer(room);
  io.to(room.code).emit('room:closed', { reason });
  for (const p of room.players) if (p.socketId) sockets.delete(p.socketId);
  if (room.hostSocketId) sockets.delete(room.hostSocketId);
  rooms.delete(room.code);
}

// ---------------------------------------------------------------------------
// Timers — the server holds the real clock and broadcasts a deadline, so every
// screen counts toward the same moment and a late joiner sees the right time.
// ---------------------------------------------------------------------------
function clearTimer(room) {
  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerHandle = null;
  room.deadline = null;
}

function startTimer(room, seconds, onExpire) {
  clearTimer(room);
  room.deadline = Date.now() + seconds * 1000;
  room.timerHandle = setTimeout(() => {
    room.deadline = null;
    room.timerHandle = null;
    onExpire();
  }, seconds * 1000);
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------
function broadcast(room) {
  const publicState = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: ROUNDS,
    prompt: room.prompt,
    deadline: room.deadline || null,
    durations: TIMERS,
    qr: room.qr || null,
    joinUrl: room.joinUrl || null,
    hostConnected: !!room.hostSocketId,
    personalOn: room.personalOn,
    setupDone: room.players.filter((p) => p.setupA || !p.allowPersonal).length,
    players: room.players.map((p) => ({
      pid: p.pid,
      name: p.name,
      score: p.score,
      hasAnswered: p.answer !== null,
      hasVoted: p.votedFor !== null,
      connected: p.connected,
    })),
    answers:
      room.phase === 'VOTING' || room.phase === 'RESULTS'
        ? room.players
            .filter((p) => p.answer)
            .map((p) => ({
              pid: p.pid,
              name: room.phase === 'RESULTS' ? p.name : null, // anonymous while voting
              text: p.answer,
              votes:
                room.phase === 'RESULTS'
                  ? room.players.filter((v) => v.votedFor === p.pid).map((v) => v.name)
                  : [],
            }))
        : [],
  };

  if (room.hostSocketId) io.to(room.hostSocketId).emit('state', { ...publicState, view: 'host' });

  for (const p of room.players) {
    if (!p.socketId || !p.connected) continue;
    io.to(p.socketId).emit('state', {
      ...publicState,
      view: 'player',
      // `you` is the only per-player payload, so seeds stay private here —
      // they must never reach publicState or the whole room sees every hand.
      you: {
        pid: p.pid,
        name: p.name,
        score: p.score,
        answer: p.answer,
        votedFor: p.votedFor,
        seeds: room.phase === 'WRITING' ? p.seeds || [] : [],
        // Their lobby question, so the phone knows what to ask.
        setupAsk: p.setupQ != null && SETUP_QUESTIONS[p.setupQ] ? SETUP_QUESTIONS[p.setupQ].ask : null,
        setupHint: p.setupQ != null && SETUP_QUESTIONS[p.setupQ] ? SETUP_QUESTIONS[p.setupQ].hint : null,
        setupStem: p.setupQ != null && SETUP_QUESTIONS[p.setupQ] ? SETUP_QUESTIONS[p.setupQ].stem : null,
        setupA: p.setupA,
        allowPersonal: p.allowPersonal,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Phase transitions — each callable by "everyone's done", a timer, or a skip
// ---------------------------------------------------------------------------
/**
 * Pick this round's prompt: personal if the round was flagged for it and there
 * is somebody who hasn't been targeted yet, otherwise a normal deal.
 */
function dealRoundPrompt(room) {
  if (room.personalOn && room.personalRounds.has(room.round)) {
    const targets = room.players.filter(
      (p) => p.connected && p.allowPersonal && !room.personalUsed.has(p.pid)
    );
    if (targets.length) {
      const target = targets[Math.floor(Math.random() * targets.length)];
      room.personalUsed.add(target.pid);
      const built = buildPersonal(target, room.usedPersonalFrames);
      room.usedPersonalFrames.add(built.frame);
      return built.text;
    }
    // Everyone opted out or already got their turn — fall through quietly.
  }
  return dealPrompt(room).text;
}

function startRound(room) {
  room.round += 1;
  room.prompt = dealRoundPrompt(room);
  room.phase = 'WRITING';

  // Deal each player their own private handful of seeds, off one shuffled deck
  // so no two people in a round get the same scrap. Same reason CAH deals
  // separate hands: shared material would converge everyone's answers.
  const deck = shuffle([...SEEDS]);
  for (const p of room.players) {
    p.answer = null;
    p.votedFor = null;
    p.seeds = deck.splice(0, SEEDS_PER_PLAYER);
  }

  startTimer(room, TIMERS.WRITING, () => enterVoting(room));
  touch(room);
  broadcast(room);
}

function enterVoting(room) {
  if (room.phase !== 'WRITING') return;
  clearTimer(room);
  room.phase = 'VOTING';
  // Nothing to vote on with fewer than two answers — skip ahead so the game
  // can't stall on a room full of people who didn't type.
  if (room.players.filter((p) => p.answer).length < 2) return enterResults(room);
  startTimer(room, TIMERS.VOTING, () => enterResults(room));
  touch(room);
  broadcast(room);
}

function enterResults(room) {
  if (room.phase !== 'WRITING' && room.phase !== 'VOTING') return;
  clearTimer(room);
  for (const voter of room.players) {
    if (!voter.votedFor) continue;
    const target = room.players.find((p) => p.pid === voter.votedFor);
    if (target) target.score += POINTS_PER_VOTE;
  }
  room.phase = 'RESULTS';
  startTimer(room, TIMERS.RESULTS, () => advanceFromResults(room));
  touch(room);
  broadcast(room);
}

function advanceFromResults(room) {
  if (room.phase !== 'RESULTS') return;
  clearTimer(room);
  if (room.round >= ROUNDS) {
    room.phase = 'SCORES';
    touch(room);
    broadcast(room);
  } else {
    startRound(room);
  }
}

// Advance early only when every *connected* player is done. Someone who
// dropped doesn't hold up the room — the phase timer covers them.
function maybeAdvance(room) {
  const active = room.players.filter((p) => p.connected);
  if (active.length === 0) return;
  if (room.phase === 'WRITING' && active.every((p) => p.answer)) enterVoting(room);
  else if (room.phase === 'VOTING' && active.every((p) => p.votedFor)) enterResults(room);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const ipHistory = new Map(); // ip -> [timestamps of room creations]

function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

function allowRoomCreate(socket) {
  const ip = clientIp(socket);
  const now = Date.now();
  const hits = (ipHistory.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= MAX_ROOMS_PER_IP) return false;
  hits.push(now);
  ipHistory.set(ip, hits);
  return true;
}

function throttled(socket) {
  const now = Date.now();
  if (now - socket._winStart > EVENT_WINDOW_MS) {
    socket._winStart = now;
    socket._winCount = 0;
  }
  socket._winCount += 1;
  return socket._winCount > MAX_EVENTS_PER_SOCKET;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
function roomOfSocket(socket) {
  const ref = sockets.get(socket.id);
  return ref ? rooms.get(ref.code) || null : null;
}

function isHost(socket) {
  const ref = sockets.get(socket.id);
  return !!ref && ref.pid === 'host';
}

function playerOfSocket(socket) {
  const ref = sockets.get(socket.id);
  if (!ref || ref.pid === 'host') return null;
  const room = rooms.get(ref.code);
  return room ? room.players.find((p) => p.pid === ref.pid) || null : null;
}

/**
 * Work out the URL phones should be sent to.
 *
 * The TV reports the address it was opened at. If that's localhost, encoding
 * it into a QR is worse than useless: a phone scanning "localhost:3000" tries
 * to reach ITSELF and fails with no clue why. So we swap in this machine's
 * network address whenever the TV is on a loopback address.
 *
 * A deployed server reports a real hostname and is left alone.
 */
function joinBase(origin) {
  let base = origin || `http://${lanAddress()}:${PORT}`;
  try {
    const u = new URL(base);
    if (['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(u.hostname)) {
      const lan = lanAddress();
      if (lan && lan !== 'localhost') {
        u.hostname = lan;
        base = u.origin;
      }
    }
  } catch (_) { /* malformed origin — fall through with what we have */ }
  return base.replace(/\/+$/, '');
}

async function makeQr(room, origin) {
  const base = joinBase(origin);
  // Remember it so the TV can display the same address it encodes.
  room.joinUrl = base;
  try {
    room.qr = await QRCode.toDataURL(`${base}/?c=${room.code}`, {
      margin: 1, width: 320, color: { dark: '#14102e', light: '#f6f0e4' },
    });
  } catch (_) {
    room.qr = null; // QR is a convenience; the typed code still works
  }
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket._winStart = Date.now();
  socket._winCount = 0;

  socket.use((packet, next) => {
    if (throttled(socket)) return next(new Error('slow down'));
    next();
  });
  socket.on('error', () => {});

  // ---- Host (the TV) ----

  socket.on('host:create', async ({ origin } = {}, ack) => {
    if (!allowRoomCreate(socket)) {
      return ack && ack({ ok: false, error: 'Too many rooms from this connection. Wait a few minutes.' });
    }
    const room = createRoom();
    room.hostSocketId = socket.id;
    sockets.set(socket.id, { code: room.code, pid: 'host' });
    socket.join(room.code);
    await makeQr(room, origin);
    // The host token lets the TV reclaim this room after a reload or a drop.
    ack && ack({ ok: true, code: room.code, hostToken: room.hostToken });
    broadcast(room);
  });

  socket.on('host:resume', async ({ code, hostToken, origin } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room || room.hostToken !== hostToken) {
      return ack && ack({ ok: false, error: 'That room is gone.' });
    }
    // Another tab already holds the TV — drop the old socket rather than fight.
    if (room.hostSocketId && room.hostSocketId !== socket.id) sockets.delete(room.hostSocketId);
    room.hostSocketId = socket.id;
    room.hostGoneAt = null;
    sockets.set(socket.id, { code: room.code, pid: 'host' });
    socket.join(room.code);
    if (!room.qr) await makeQr(room, origin);
    touch(room);
    ack && ack({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('host:start', () => {
    const room = roomOfSocket(socket);
    if (!room || !isHost(socket)) return;
    if (room.players.filter((p) => p.connected).length < 2) return;
    room.round = 0;
    for (const p of room.players) p.score = 0;
    // Decide up front which rounds are personal, so they arrive as a surprise
    // rather than always landing on round one.
    room.personalRounds = new Set();
    room.personalUsed = new Set();
    const eligible = room.players.filter((p) => p.connected && p.allowPersonal);
    if (room.personalOn && eligible.length) {
      const slots = shuffle(Array.from({ length: ROUNDS }, (_, i) => i + 1));
      for (const r of slots.slice(0, Math.min(PERSONAL_ROUNDS, eligible.length))) {
        room.personalRounds.add(r);
      }
    }
    startRound(room);
  });

  socket.on('host:personal', ({ on } = {}) => {
    const room = roomOfSocket(socket);
    if (!room || !isHost(socket)) return;
    room.personalOn = !!on;
    touch(room);
    broadcast(room);
  });

  socket.on('host:skip', () => {
    const room = roomOfSocket(socket);
    if (!room || !isHost(socket)) return;
    if (room.phase === 'WRITING') enterVoting(room);
    else if (room.phase === 'VOTING') enterResults(room);
    else if (room.phase === 'RESULTS') advanceFromResults(room);
  });

  socket.on('host:restart', () => {
    const room = roomOfSocket(socket);
    if (!room || !isHost(socket)) return;
    clearTimer(room);
    room.phase = 'LOBBY';
    room.round = 0;
    room.prompt = null;
    // A new game gets a clean slate, so it can draw from every category again.
    room.usedPrompts = new Set();
    room.usedGroups = new Set();
    room.usedSources = new Set();
    // Setup answers survive into the next game; only the targeting resets.
    room.personalRounds = new Set();
    room.personalUsed = new Set();
    for (const p of room.players) {
      p.score = 0;
      p.answer = null;
      p.votedFor = null;
    }
    // Clear out anyone who wandered off before the next game starts.
    room.players = room.players.filter((p) => p.connected);
    touch(room);
    broadcast(room);
  });

  // Deal a different prompt for the current round. For when the room groans at
  // one, or it lands wrong for the crowd. Only allowed before anyone has
  // committed an answer, so nobody loses work.
  socket.on('host:swapPrompt', () => {
    const room = roomOfSocket(socket);
    if (!room || !isHost(socket)) return;
    if (room.phase !== 'WRITING') return;
    if (room.players.some((p) => p.answer)) return;
    // Let the dealer pick again; this round's category is already marked used,
    // so a swap tends to land on a different topic too.
    room.prompt = dealRoundPrompt(room);
    startTimer(room, TIMERS.WRITING, () => enterVoting(room));
    touch(room);
    broadcast(room);
  });

  // ---- Player (the phone) ----

  socket.on('player:join', ({ code, name } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return ack && ack({ ok: false, error: 'No room with that code.' });
    if (room.phase !== 'LOBBY') return ack && ack({ ok: false, error: 'That game already started.' });

    const clean = String(name || '').trim().slice(0, 14) || 'Player';
    if (room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase() && p.connected)) {
      return ack && ack({ ok: false, error: 'That name is taken. Try another.' });
    }
    if (room.players.filter((p) => p.connected).length >= MAX_PLAYERS) {
      return ack && ack({ ok: false, error: 'This room is full.' });
    }

    const player = {
      pid: token(),
      name: clean,
      score: 0,
      answer: null,
      votedFor: null,
      seeds: [],
      setupQ: null,     // index into SETUP_QUESTIONS, assigned on join
      setupA: null,     // their answer, if they gave one
      allowPersonal: true,  // they can opt out of being a target

      socketId: socket.id,
      connected: true,
      goneAt: null,
    };
    // Give them a setup question the room hasn't used yet, so answers vary.
    const taken = new Set(room.players.map((p) => p.setupQ).filter((q) => q != null));
    const free = SETUP_QUESTIONS.map((_, i) => i).filter((i) => !taken.has(i));
    const bag = free.length ? free : SETUP_QUESTIONS.map((_, i) => i);
    player.setupQ = bag[Math.floor(Math.random() * bag.length)];

    room.players.push(player);
    sockets.set(socket.id, { code: room.code, pid: player.pid });
    socket.join(room.code);
    touch(room);
    // The pid is this player's claim on the seat — the phone stores it and
    // presents it again if the connection drops.
    ack && ack({ ok: true, pid: player.pid, code: room.code, name: player.name });
    broadcast(room);
  });

  // Reclaim a seat mid-game after a drop. This is the whole point of the pid.
  socket.on('player:resume', ({ code, pid } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return ack && ack({ ok: false, error: 'That room is gone.' });
    const player = room.players.find((p) => p.pid === pid);
    if (!player) return ack && ack({ ok: false, error: 'Your seat expired.' });

    if (player.socketId && player.socketId !== socket.id) sockets.delete(player.socketId);
    player.socketId = socket.id;
    player.connected = true;
    player.goneAt = null;
    sockets.set(socket.id, { code: room.code, pid: player.pid });
    socket.join(room.code);
    touch(room);
    ack && ack({ ok: true, pid: player.pid, code: room.code, name: player.name });
    broadcast(room);
    maybeAdvance(room); // they may have been the last one the room waited on
  });

  // The lobby question. Optional in both directions: they can skip answering,
  // and they can decline to be named at all.
  socket.on('player:setup', ({ answer, allowPersonal } = {}, ack) => {
    const room = roomOfSocket(socket);
    const player = playerOfSocket(socket);
    if (!room || !player) return ack && ack({ ok: false });
    if (typeof allowPersonal === 'boolean') player.allowPersonal = allowPersonal;
    if (answer !== undefined) {
      const clean = String(answer || '').trim().slice(0, 60);
      player.setupA = clean || null;
    }
    touch(room);
    ack && ack({ ok: true });
    broadcast(room);
  });

  socket.on('player:answer', ({ text } = {}) => {
    const room = roomOfSocket(socket);
    const player = playerOfSocket(socket);
    if (!room || !player || room.phase !== 'WRITING' || player.answer) return;
    const clean = String(text || '').trim().slice(0, 90);
    if (!clean) return;
    player.answer = clean;
    touch(room);
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('player:vote', ({ targetId } = {}) => {
    const room = roomOfSocket(socket);
    const player = playerOfSocket(socket);
    if (!room || !player || room.phase !== 'VOTING' || player.votedFor) return;
    if (targetId === player.pid) return; // no voting for yourself
    if (!room.players.some((p) => p.pid === targetId && p.answer)) return;
    player.votedFor = targetId;
    touch(room);
    broadcast(room);
    maybeAdvance(room);
  });

  // ---- Disconnect: mark, don't delete ----

  socket.on('disconnect', () => {
    const ref = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (!ref) return;
    const room = rooms.get(ref.code);
    if (!room) return;

    if (ref.pid === 'host') {
      // Don't tear the room down — the TV might just be reloading. The sweep
      // collects it if the host never comes back.
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        room.hostGoneAt = Date.now();
      }
      broadcast(room);
      return;
    }

    const player = room.players.find((p) => p.pid === ref.pid);
    if (!player || player.socketId !== socket.id) return; // superseded by a newer socket
    player.connected = false;
    player.goneAt = Date.now();
    player.socketId = null;

    // In the lobby there's nothing worth preserving, so drop them outright.
    if (room.phase === 'LOBBY') room.players = room.players.filter((p) => p.pid !== ref.pid);

    broadcast(room);
    maybeAdvance(room); // they may have been the last one holding up the round
  });
});

// ---------------------------------------------------------------------------
// Sweep — the only thing between a long-running server and a slow memory leak.
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (!room.hostSocketId && room.hostGoneAt && now - room.hostGoneAt > HOST_GRACE_MS) {
      destroyRoom(room, 'The host disconnected.');
      continue;
    }
    if (now - room.lastActivity > ROOM_IDLE_MS) {
      destroyRoom(room, 'Room expired.');
      continue;
    }
    // Players who dropped and never came back stop counting as seat-holders.
    const before = room.players.length;
    room.players = room.players.filter(
      (p) => p.connected || (p.goneAt && now - p.goneAt < PLAYER_GRACE_MS)
    );
    if (room.players.length !== before) {
      broadcast(room);
      maybeAdvance(room);
    }
  }
  for (const [ip, hits] of ipHistory) {
    const live = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) ipHistory.set(ip, live);
    else ipHistory.delete(ip);
  }
}, SWEEP_MS).unref();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
/**
 * Find the address phones should actually use.
 *
 * The naive version — first non-internal IPv4 — picks whatever the OS happens
 * to list first, which on a Mac is regularly a VPN tunnel (utun*), an AirDrop
 * adapter (awdl0), or a Docker bridge. Phones can't reach any of those, so the
 * game would print an address that silently goes nowhere.
 *
 * So: throw out interfaces that are never the answer, then rank what's left.
 * Returns the best guess; `lanCandidates()` exposes the rest for the boot
 * message, because a wrong guess is much easier to recover from when the
 * alternatives are printed right there.
 */
const VIRTUAL_IFACE = /^(utun|tun|tap|awdl|llw|bridge|docker|veth|vboxnet|vmnet|zt|wg|ham|anpi)/i;

function lanCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      // Rank: real Wi-Fi/Ethernet names first, then by how likely the range is
      // to be a home network a phone shares.
      let score = 0;
      if (/^en\d/.test(name)) score += 100;      // macOS Wi-Fi / Ethernet
      if (/^(eth|wlan|wl)\d/.test(name)) score += 100; // Linux equivalents
      if (a.address.startsWith('192.168.')) score += 50;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 30;
      else if (a.address.startsWith('10.')) score += 20;
      if (name === 'en0') score += 10;           // the usual Wi-Fi on a Mac
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function lanAddress() {
  const best = lanCandidates()[0];
  return best ? best.address : 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  // Hosts set these; locally none of them exist.
  const hostedUrl =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) ||
    (process.env.FLY_APP_NAME && `https://${process.env.FLY_APP_NAME}.fly.dev`) ||
    null;
  const hosted = !!hostedUrl || !!process.env.RENDER || !!process.env.FLY_APP_NAME;

  console.log('\n  PARTY BOX is running\n');

  if (hosted) {
    // Deployed: there's no LAN and no "same Wi-Fi" — everyone comes in over
    // the internet, so printing a local address would just mislead.
    console.log(`  Listening on port ${PORT}.`);
    if (hostedUrl) {
      console.log(`\n    TV / laptop   ->  ${hostedUrl}/host`);
      console.log(`    Phones        ->  ${hostedUrl}\n`);
    } else {
      console.log('  Open /host on your public URL for the TV screen,');
      console.log('  and the root URL on phones.\n');
    }
    return;
  }

  const all = lanCandidates();
  const ip = all.length ? all[0].address : 'localhost';
  if (!all.length) {
    console.log('  No network address found — this machine may be offline.');
    console.log(`  You can still open http://localhost:${PORT}/host on this computer,`);
    console.log('  but phones will not be able to reach it.\n');
    return;
  }
  // Point the TV at the network address too, not localhost: the QR code and
  // the join address shown on screen are built from whatever the TV page was
  // opened at, and "localhost" means "this phone" to a phone.
  console.log('  Open BOTH of these in a web browser (not in this terminal):\n');
  console.log(`    TV / laptop   ->  http://${ip}:${PORT}/host`);
  console.log(`    Phones        ->  http://${ip}:${PORT}\n`);
  if (all.length > 1) {
    console.log('  If phones cannot reach that, try one of these instead:');
    for (const c of all.slice(1)) console.log(`    http://${c.address}:${PORT}   (${c.name})`);
    console.log('');
  }
  console.log('  Phones must be on the same Wi-Fi as this computer.');
  console.log('  Cafe, hotel and apartment Wi-Fi usually block this — deploy instead.\n');
});
