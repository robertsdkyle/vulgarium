/**
 * Party Box — the TV view. Renders the shared `room` and `audience`
 * entities plus the TV-only `host` entity. Never sees anyone's private data.
 */
import { esc, promptHTML } from '/js/realtime.js';
import { confetti, confettiFrom, playRoundWin, playFanfare } from '/js/celebrate.js';

let els = null;
let api = null;
let countdownTimer = null;
let countdownFor = null;
let lastScene = '';
let celebrated = '';   // scene we last threw confetti for, so re-renders don't repeat it

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
const names = (list) => list.length <= 2 ? list.join(' & ') : `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;

/** Fire a celebration once per scene, after the reveal animation has played. */
function celebrateOnce(key, fn, delay = 0) {
  if (celebrated === key) return;
  celebrated = key;
  setTimeout(fn, delay);
}

export function mount(e, a) { els = e; api = a; }

const codeTiles = (code) => `<div class="code-tiles">${code.split('').map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
const avatar = (p) => p.avatar ? `<span class="av" style="--av:${esc(p.avatar.color)}">${esc(p.avatar.glyph)}</span>` : '';

/** A player chip. Disconnected players stay visible, dimmed, with a note. */
function chip(p, { ready = false, extra = '' } = {}) {
  const cls = ['chip', ready ? 'ready' : '', p.connected ? '' : 'gone'].join(' ');
  return `<div class="${cls}">${avatar(p)}<span>${esc(p.name)}</span>${p.isVIP ? '<span class="vip" title="VIP">VIP</span>' : ''}${
    p.connected ? '' : '<span class="gone-note">reconnecting…</span>'}${extra}</div>`;
}

function runCountdown(deadline) {
  if (deadline === countdownFor) return;
  countdownFor = deadline;
  clearInterval(countdownTimer);
  if (!deadline) { els.timer.hidden = true; return; }
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - api.now()) / 1000));
    els.timerNum.textContent = left;
    els.timer.hidden = false;
    els.timer.classList.toggle('urgent', left <= 5);
    if (left <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function controls(buttons) {
  els.controls.innerHTML = buttons.map((b) =>
    `<button class="btn-big ${b.ghost ? 'ghost' : ''}" id="${b.id}" ${b.disabled ? 'disabled' : ''}>${esc(b.label)}</button>`).join('');
  for (const b of buttons) document.getElementById(b.id).onclick = (ev) => { ev.currentTarget.disabled = true; api.send(b.op, b.payload); };
}

export function render({ room, host, audience }) {
  if (!els || !room || !host) return;
  // Same scene re-rendered (someone answered, a vote came in): skip the
  // entrance animations so the screen doesn't flicker.
  const scene = room.phase + ':' + room.round;
  els.stage.classList.toggle('settled', scene === lastScene);
  lastScene = scene;

  els.roundLabel.textContent = room.phase === 'LOBBY' || room.phase === 'SCORES'
    ? `Room ${host.code}` : `Round ${room.round} of ${room.totalRounds}`;
  els.audCount.hidden = !room.audienceCount;
  els.audCount.textContent = `+${room.audienceCount} in the audience`;
  runCountdown(room.deadline);

  const live = room.players.filter((p) => p.connected);
  const gone = room.players.filter((p) => !p.connected);
  const goneNote = gone.length && room.phase !== 'LOBBY'
    ? `<p class="hint">${gone.map((p) => esc(p.name)).join(', ')} ${gone.length === 1 ? 'is' : 'are'} reconnecting — their seat is saved.</p>` : '';

  const skip = (label) => ({ id: 'skip', label, op: 'host/skip', ghost: true, disabled: !host.canSkip });

  switch (room.phase) {
    case 'LOBBY': {
      const lob = room.lobby || {};
      els.stage.innerHTML = `
        <div class="lobby-grid">
          <div class="join-block">
            <p class="eyebrow">On your phone, open</p>
            <p class="url"><em>${esc((host.joinUrl || location.origin).replace(/^https?:\/\//, ''))}</em></p>
            <p class="eyebrow">and enter the code</p>
            ${codeTiles(host.code)}
          </div>
          ${host.qr ? `<div class="qr-block"><img class="qr" src="${host.qr}" alt="Scan to join"><p class="eyebrow">or scan to join</p></div>` : ''}
        </div>
        <div class="roster">
          ${room.players.length ? room.players.map((p) => chip(p, { ready: p.connected })).join('')
            : '<p class="hint">Waiting for players<span class="waiting-dots"></span></p>'}
        </div>
        ${live.length && lob.personalOn ? `<p class="hint">${lob.setupDone} of ${live.length} answered their question — the rest can still play.</p>` : ''}
        ${lob.vipName ? `<p class="hint">${esc(lob.vipName)} is the VIP and can start from their phone.</p>` : ''}`;
      controls([
        { id: 'personal', label: host.personalOn ? 'Personal prompts: on' : 'Personal prompts: off', op: 'host/personal', payload: { on: !host.personalOn }, ghost: true },
        { id: 'house', label: host.houseOn ? 'House answers: on' : 'House answers: off', op: 'host/house', payload: { on: !host.houseOn }, ghost: true },
        { id: 'start', label: host.canStart ? `Start with ${live.length}` : `Need ${lob.minPlayers || 2} players`, op: 'host/start', disabled: !host.canStart },
      ]);
      return;
    }

    case 'PICKING': {
      const pick = room.pick || { choices: [] };
      const picker = room.players.find((p) => p.id === pick.pickerId);
      els.stage.innerHTML = `
        <div class="prompt-card picking">
          <p class="eyebrow">Round ${room.round}</p>
          <p class="prompt-text">${picker ? avatar(picker) : ''}${esc(pick.pickerName || 'Someone')} is picking a category<span class="waiting-dots"></span></p>
        </div>
        <div class="choice-grid">
          ${pick.choices.map((c) => `<div class="choice ${c.disabled ? 'disabled' : ''}">${esc(c.label)}${c.disabled ? '<small>already played</small>' : ''}</div>`).join('')}
        </div>
        ${goneNote}`;
      controls([skip('Pick for them')]);
      return;
    }

    case 'WRITING':
      els.stage.innerHTML = `
        <div class="prompt-card">
          ${room.category ? `<p class="eyebrow">${esc(room.category)}</p>` : room.personalRound ? '<p class="eyebrow">Personal</p>' : ''}
          <p class="prompt-text">${promptHTML(room.prompt)}</p>
        </div>
        <div class="roster">${room.players.map((p) => chip(p, { ready: p.hasAnswered })).join('')}</div>
        <p class="hint">Answer on your phone. Lit up means you're in.</p>
        ${goneNote}`;
      controls([
        ...(host.canSwap ? [{ id: 'swap', label: 'Different prompt', op: 'host/swap', ghost: true }] : []),
        skip('Skip to voting'),
      ]);
      return;

    case 'VOTING': {
      const counts = (audience && audience.counts) || {};
      els.stage.innerHTML = `
        <div class="prompt-card ${room.answers.length > 4 ? 'compact' : ''}"><p class="prompt-text">${promptHTML(room.prompt)}</p></div>
        <div class="answer-list ${room.answers.length > 8 ? 'many lots' : room.answers.length > 4 ? 'many' : ''}">
          ${room.answers.map((a, i) => `<div class="answer-row" style="animation-delay:${i * 0.08}s"><span>${esc(a.text)}</span>${
            counts[a.id] ? `<span class="aud">${counts[a.id]} 👏</span>` : ''}</div>`).join('')}
        </div>
        <div class="roster">${room.players.map((p) => chip(p, { ready: p.hasVoted })).join('')}</div>
        ${goneNote}`;
      controls([skip('Skip to results')]);
      return;
    }

    case 'RESULTS': {
      const counts = (audience && audience.counts) || {};
      // Round winners first, then by votes; the box sinks below players on a tie.
      const ranked = [...room.answers].sort((a, b) =>
        (b.winner - a.winner) || (b.votes.length - a.votes.length) || (a.isHouse - b.isHouse));
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const winners = ranked.filter((a) => a.winner);
      const houseTop = ranked.find((a) => a.isHouse && a.votes.length && a.votes.length >= Math.max(0, ...winners.map((w) => w.votes.length)));
      const banner = winners.length
        ? `<p class="round-banner">🏆 ${esc(names(winners.map((w) => w.name)))} ${winners.length > 1 ? 'tie for' : 'takes'} the round!</p>`
        : '';
      els.stage.innerHTML = `
        <div class="prompt-card ${ranked.length > 4 ? 'compact' : ''}"><p class="prompt-text">${promptHTML(room.prompt)}</p></div>
        ${banner}
        <div class="answer-list ${ranked.length > 8 ? 'many lots' : ranked.length > 4 ? 'many' : ''}">
          ${ranked.length ? ranked.map((a, i) => `
            <div class="answer-row ${a.winner ? 'round-win' : ''} ${top && top[0] === a.id ? 'aud-fav' : ''} ${a.isHouse ? 'house' : ''}" data-id="${esc(a.id)}" style="animation-delay:${i * 0.12}s">
              <span>${a.winner ? '<span class="win-badge">★ Winner</span>' : ''}${esc(a.text)}</span>
              <span class="who">${a.isHouse ? '📦 ' : ''}${esc(a.name || '')}${a.points ? ` <span class="gain">+${a.points}</span>` : ''}</span>
              <span class="votes">${a.votes.length ? (a.isHouse ? 'fooled ' : '') + esc(a.votes.join(', ')) : '—'}${counts[a.id] ? `<br><span class="aud">👏 ${counts[a.id]} audience</span>` : ''}</span>
            </div>`).join('') : '<p class="hint">Nobody answered this round.</p>'}
        </div>
        ${room.voteSkipped && ranked.length ? '<p class="hint">Not enough answers to vote on this round.</p>' : ''}
        ${houseTop ? `<p class="hint">📦 The box fooled ${esc(names(houseTop.votes))}!</p>` : ranked.some((a) => a.isHouse) ? '<p class="hint">📦 = planted by the box. Anyone who picked one got fooled.</p>' : ''}
        ${top ? '<p class="hint">👏 = the audience favorite.</p>' : ''}
        ${goneNote}`;
      if (winners.length) {
        celebrateOnce(`results:${room.round}`, () => {
          for (const w of winners) confettiFrom(els.stage.querySelector(`.answer-row[data-id="${CSS.escape(w.id)}"]`), 60);
          playRoundWin();
        }, 450);
      }
      controls([skip(room.round >= room.totalRounds ? 'Skip to final scores' : 'Skip to next round')]);
      return;
    }

    case 'SCORES': {
      const standings = room.standings || [...room.players].sort((a, b) => b.score - a.score).map((p, i) => ({ ...p, rank: i + 1, winner: i === 0 }));
      const champs = standings.filter((p) => p.winner);
      const tie = champs.length > 1;
      els.stage.innerHTML = `
        <div class="final">
          <div class="winner-hero">
            <p class="eyebrow">${tie ? "It's a tie!" : 'And the winner is'}</p>
            <div class="crown" aria-hidden="true">👑</div>
            <div class="hero-names">
              ${champs.map((c) => `<div class="hero-name">${avatar(c)}<span>${esc(c.name)}</span></div>`).join('')}
            </div>
            <p class="hero-pts">${champs[0] ? champs[0].score : 0} points</p>
          </div>
          <div class="scoreboard final-board ${standings.length > 6 ? 'tight' : ''}">
            ${standings.map((p, i) => `
              <div class="score-row ${p.winner ? 'is-winner' : ''}" style="animation-delay:${0.4 + i * 0.08}s">
                <span class="rank">${MEDALS[p.rank] || ordinal(p.rank)}</span>
                <span class="who">${avatar(p)}${esc(p.name)}</span>
                <span class="pts">${p.score}<small> pts</small></span>
              </div>`).join('')}
          </div>
        </div>`;
      celebrateOnce('scores', () => {
        confetti({ amount: 220 });
        confettiFrom(els.stage.querySelector('.winner-hero'), 90);
        playFanfare();
        setTimeout(() => confetti({ amount: 140 }), 1300);
      }, 250);
      controls([{ id: 'again', label: 'Back to lobby', op: 'host/restart', ghost: true }]);
    }
  }
}
