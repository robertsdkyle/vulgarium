/**
 * Party Box — the TV view. Renders the shared `room` and `audience`
 * entities plus the TV-only `host` entity. Never sees anyone's private data.
 */
import { esc, promptHTML } from '/js/realtime.js';

let els = null;
let api = null;
let countdownTimer = null;
let countdownFor = null;
let lastScene = '';

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
        <div class="prompt-card"><p class="prompt-text">${promptHTML(room.prompt)}</p></div>
        <div class="answer-list">
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
      const ranked = [...room.answers].sort((a, b) => b.votes.length - a.votes.length);
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      els.stage.innerHTML = `
        <div class="prompt-card"><p class="prompt-text">${promptHTML(room.prompt)}</p></div>
        <div class="answer-list">
          ${ranked.length ? ranked.map((a, i) => `
            <div class="answer-row ${top && top[0] === a.id ? 'aud-fav' : ''}" style="animation-delay:${i * 0.12}s">
              <span>${esc(a.text)}</span>
              <span class="who">${esc(a.name || '')}</span>
              <span class="votes">${a.votes.length ? esc(a.votes.join(', ')) : '—'}${counts[a.id] ? `<br><span class="aud">${counts[a.id]} audience</span>` : ''}</span>
            </div>`).join('') : '<p class="hint">Not enough answers this round.</p>'}
        </div>
        ${top ? '<p class="hint">Highlighted: the audience favorite.</p>' : ''}
        ${goneNote}`;
      controls([skip(room.round >= room.totalRounds ? 'Skip to final scores' : 'Skip to next round')]);
      return;
    }

    case 'SCORES': {
      const ranked = [...room.players].sort((a, b) => b.score - a.score);
      els.stage.innerHTML = `
        <h1 class="winner">${esc(ranked[0] ? ranked[0].name : '')} wins</h1>
        <div class="scoreboard">
          ${ranked.map((p, i) => `
            <div class="score-row">
              <span class="rank">${i + 1}</span>
              <span>${avatar(p)}${esc(p.name)}</span>
              <span class="pts">${p.score}</span>
            </div>`).join('')}
        </div>`;
      controls([{ id: 'again', label: 'Back to lobby', op: 'host/restart', ghost: true }]);
    }
  }
}
