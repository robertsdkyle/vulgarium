/**
 * Party Box — phone controller.
 *
 * A dumb renderer: it never decides what happens next. It draws whatever the
 * `room` entity (shared) and this player's `player:<id>` entity (private)
 * say, and only shows a control when the server's `permissions` grant it.
 * Every button is a request; the server's next entity update is the answer.
 *
 * Loaded on demand by the phone shell (public/js/phone.js) for rooms whose
 * game type is "party-box".
 */
import { esc, promptHTML } from '/js/realtime.js';

let el = null;
let api = null;
let mainKey = '';
let footHtml = '';
// The half-typed answer survives a refresh mid-round (sessionStorage is per
// tab, so it never leaks to another player on a shared device).
const DRAFT_KEY = 'pb.draft';
let draft = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) || { round: -1, text: '' }; } catch (_) { return { round: -1, text: '' }; } })();
const saveDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) {} };
let lastView = null;
// After a refused request, rebuild the main area so its buttons come back.
const repaint = () => {
  const err = $('pb-err') ? $('pb-err').textContent : '';
  mainKey = '';
  if (lastView) render(lastView);
  if ($('pb-err')) $('pb-err').textContent = err; // keep the reason visible
};

const ERRORS = {
  offline: 'Not connected — hang on a second and try again.',
  timeout: 'The server didn\'t answer. Try again.',
  'already-answered': 'You already sent one.',
  'already-voted': 'Your vote is already in.',
  'own-answer': 'That one\'s yours — pick another.',
  'choice-disabled': 'That category was already played.',
  'need-players': 'Need at least two players.',
  empty: 'Write something first.',
};

export function mount(root, a) {
  el = root;
  api = a;
  mainKey = '';
  footHtml = '';
  el.innerHTML = `<div id="pb-main" class="stack"></div><div id="pb-foot" class="stack"></div><p class="error" id="pb-err" aria-live="polite"></p>`;
}

export function unmount() {
  if (api) api.countdown(null);
  if (el) el.innerHTML = '';
  el = null;
}

// ---------------------------------------------------------------------------
// Painting. The main area is rebuilt only when its key changes, so a
// broadcast caused by someone else (another player answering) never wipes a
// half-typed answer. The footer holds nothing typeable and can update freely.
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function paint(key, html, bind) {
  if (key === mainKey) return;
  mainKey = key;
  $('pb-main').innerHTML = html;
  $('pb-err').textContent = '';
  if (bind) bind();
}

function foot(html, bind) {
  if (html === footHtml) return;
  footHtml = html;
  $('pb-foot').innerHTML = html;
  if (bind) bind();
}

const status = (title, sub = '', dots = false) =>
  `<p class="status"><strong>${esc(title)}</strong>${esc(sub)}${dots ? '<span class="waiting-dots"></span>' : ''}</p>`;

/** Send, keeping the button from double-firing; surface refusals. */
async function request(btn, op, payload) {
  if (btn) btn.disabled = true;
  const r = await api.send(op, payload);
  if (!r.ok) {
    if (btn && document.body.contains(btn)) btn.disabled = false;
    const errEl = $('pb-err');
    if (errEl) errEl.textContent = ERRORS[r.error] || 'That didn\'t work.';
  }
  return r;
}

function bindClick(id, fn) { const b = $(id); if (b) b.onclick = () => fn(b); }

// ---------------------------------------------------------------------------
export function render(view) {
  const { role, room, me, audience } = view;
  lastView = view;
  if (!el || !room) return;
  if (role === 'audience') return renderAudience(room, me, audience);
  if (!me) { paint('noseat', status('Hold on', 'Finding your seat', true)); foot(''); return; }

  const perm = me.permissions || {};
  const active = perm.canPick || perm.canWrite || perm.canVote;
  api.countdown(active ? room.deadline : null, room.durations && room.durations[room.phase]);

  switch (room.phase) {
    case 'LOBBY': return lobby(room, me, perm);
    case 'PICKING': return picking(room, me, perm);
    case 'WRITING': return writing(room, me, perm);
    case 'VOTING': return voting(room, me, perm);
    case 'RESULTS': return results(room, me);
    case 'SCORES': return scores(room, me, perm);
  }
}

// ---- LOBBY ----------------------------------------------------------------
function lobby(room, me, perm) {
  const s = me.setup || {};
  const answered = !!s.answer;
  const opted = s.allowPersonal !== false;

  if (!opted) {
    paint('lobby:out', `
      ${status("You're in", 'Your name is off the list for personal prompts.')}
      <button class="btn-vote" id="optin">Actually, use my name</button>`,
    () => bindClick('optin', (b) => request(b, 'lobby/setup', { allowPersonal: true })));
  } else if (answered || !s.ask) {
    paint(`lobby:done:${s.answer}`, `
      ${status("You're in", 'Watch the TV — the game starts when everyone\'s here.')}
      ${answered ? `<p class="ph-lab">Your answer: ${esc(s.answer)}</p>
      <button class="btn-vote" id="redo">Change it</button>` : ''}
      <button class="btn-vote" id="optout">Leave me out of personal prompts</button>`,
    () => {
      bindClick('redo', (b) => request(b, 'lobby/setup', { answer: '' }));
      bindClick('optout', (b) => request(b, 'lobby/setup', { allowPersonal: false, answer: '' }));
    });
  } else {
    // The stem sits in front of the input so people finish a sentence rather
    // than start one — that's what keeps answers slotting into the frames.
    paint(`lobby:ask:${s.ask}`, `
      <p class="ph-lab">One question before we start</p>
      <p class="prompt-text">${esc(s.ask)}</p>
      <div class="stem-field">
        <span class="stem">${esc(s.stem || '')}</span>
        <input id="setup" maxlength="60" autocomplete="off" autocapitalize="none" placeholder="${esc(s.hint || '')}">
      </div>
      <p class="hint-sm">Finish the sentence. It becomes a prompt about you later — everyone else fills in the blank.</p>
      <button class="btn-go" id="setupSend">Lock it in</button>
      <button class="btn-vote" id="skip">Skip this</button>`,
    () => {
      const input = $('setup');
      const send = () => { const v = input.value.trim(); if (v) request($('setupSend'), 'lobby/setup', { answer: v }); };
      $('setupSend').onclick = send;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      bindClick('skip', (b) => request(b, 'lobby/setup', { answer: '' }));
    });
  }

  const n = room.players.filter((p) => p.connected).length;
  const lob = room.lobby || {};
  if (perm.canStartGame) {
    foot(`<button class="btn-go btn-xl" id="start">Everybody's in — start</button>
          <p class="hint-sm">You're the VIP. ${n} players connected.</p>`,
    () => bindClick('start', (b) => request(b, 'lobby/start')));
  } else if (me.isVIP) {
    foot(`<p class="hint-sm vip">You're the VIP — you can start once ${lob.minPlayers || 2} players are in.</p>`);
  } else {
    foot(`<p class="hint-sm">Waiting for ${esc(lob.vipName || 'the VIP')} to start · ${n} connected</p>`);
  }
}

// ---- PICKING --------------------------------------------------------------
function picking(room, me, perm) {
  foot('');
  const pick = room.pick || { choices: [] };
  if (!perm.canPick) {
    paint(`pickwait:${room.round}:${pick.pickerName}`,
      status(`${pick.pickerName || 'Someone'} is picking`, 'a category for this round', true));
    return;
  }
  paint(`pick:${room.round}:${pick.choices.map((c) => c.id + c.disabled).join()}`, `
    <p class="eyebrow">Round ${room.round} · your pick</p>
    <p class="prompt-text">Choose a category</p>
    <div class="vote-list">
      ${pick.choices.map((c) => `
        <button class="btn-choice" data-id="${esc(c.id)}" ${c.disabled ? 'disabled' : ''}>
          ${esc(c.label)}${c.disabled ? '<span class="tag">played</span>' : ''}
        </button>`).join('')}
    </div>`,
  () => {
    el.querySelectorAll('.btn-choice').forEach((b) => {
      b.onclick = () => {
        el.querySelectorAll('.btn-choice').forEach((x) => (x.disabled = true));
        request(null, 'pick/choose', { id: b.dataset.id }).then((r) => { if (!r.ok) repaint(); });
      };
    });
  });
}

// ---- WRITING --------------------------------------------------------------
function writing(room, me, perm) {
  foot('');
  if (!perm.canWrite) {
    paint(`locked:${room.round}`, `
      ${status('Answer locked in', 'Waiting on everyone else', true)}
      ${me.answer ? `<p class="ph-lab mine">"${esc(me.answer)}"</p>` : ''}`);
    return;
  }
  const draftId = `${room.round}:${room.prompt}`;
  if (draft.round !== draftId) { draft = { round: draftId, text: '' }; saveDraft(); }
  const prompt = me.prompt || room.prompt;
  const seeds = me.seeds || [];
  // Keyed on the prompt too: the TV can swap it before anyone answers, and a
  // draft written for the old prompt is cleared along with it.
  paint(`write:${room.round}:${prompt}`, `
    ${room.category ? `<p class="eyebrow">${esc(room.category)}</p>` : ''}
    <p class="prompt-text">${promptHTML(prompt)}</p>
    <div class="field">
      <textarea id="ans" rows="3" maxlength="90" placeholder="Make it good"></textarea>
    </div>
    ${seeds.length ? `
    <div class="seeds">
      <p class="ph-lab">Stuck? Borrow one</p>
      <div class="seed-chips">${seeds.map((w) => `<button class="seed" type="button">${esc(w)}</button>`).join('')}</div>
    </div>` : ''}
    <div class="btn-row">
      <button class="btn-go" id="send">Send it</button>
      <button class="btn-auto" id="auto" title="Let the game write one for you">Write one for me</button>
    </div>`,
  () => {
    const ta = $('ans');
    ta.value = draft.text;
    ta.addEventListener('input', () => { draft.text = ta.value; saveDraft(); });
    // Tapping a seed drops it in at the cursor, so it can be stacked or
    // bolted onto your own idea. It stays your answer.
    el.querySelectorAll('.seed').forEach((chip) => {
      chip.onclick = () => {
        const word = chip.textContent;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        const before = ta.value.slice(0, start);
        const pad = before && !/\s$/.test(before) ? ' ' : '';
        ta.value = (before + pad + word + ta.value.slice(end)).slice(0, 90);
        draft.text = ta.value;
        saveDraft();
        const caret = Math.min((before + pad + word).length, 90);
        ta.focus();
        ta.setSelectionRange(caret, caret);
        chip.classList.add('used');
      };
    });
    const send = () => { const text = ta.value.trim(); if (text) request($('send'), 'write/answer', { text }); };
    $('send').onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    bindClick('auto', (b) => request(b, 'write/auto'));
  });
}

// ---- VOTING ---------------------------------------------------------------
function voting(room, me, perm) {
  foot('');
  if (perm.canVote) {
    // The server already left this player's own answer out of `choices`.
    paint(`vote:${room.round}:${me.choices.map((c) => c.id).join()}`, `
      <p class="prompt-text">${promptHTML(me.prompt || room.prompt)}</p>
      <p class="eyebrow">Pick your favorite</p>
      <div class="vote-list">
        ${me.choices.map((c) => `<button class="btn-vote" data-id="${esc(c.id)}">${esc(c.text)}</button>`).join('')}
      </div>`,
    () => {
      el.querySelectorAll('.btn-vote').forEach((b) => {
        b.onclick = () => {
          el.querySelectorAll('.btn-vote').forEach((x) => (x.disabled = true));
          b.classList.add('picked');
          request(null, 'vote/cast', { id: b.dataset.id }).then((r) => { if (!r.ok) repaint(); });
        };
      });
    });
    return;
  }
  if (me.votedFor) {
    paint(`voted:${room.round}`, status('Vote cast', 'Waiting on everyone else', true));
    return;
  }
  paint(`votewait:${room.round}`, status('Voting', 'Watch the TV'));
}

// ---- RESULTS / SCORES ------------------------------------------------------
function results(room, me) {
  foot('');
  const lr = me.lastRound;
  let line = 'Look at the TV.';
  if (lr && lr.answered) line = lr.votes ? `Your answer got ${lr.votes} vote${lr.votes === 1 ? '' : 's'} · +${lr.points}` : 'No votes for yours this time.';
  else if (lr) line = 'You sat that one out.';
  paint(`results:${room.round}:${line}`, status('Results are up', line));
}

function scores(room, me, perm) {
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  paint(`scores:${me.place}:${me.score}`, status(me.place === 1 ? 'You won!' : `You finished ${ord(me.place)}`, `${me.score} points.`));
  if (perm.canRestart) foot(`<button class="btn-go btn-xl" id="again">Play again</button>`, () => bindClick('again', (b) => request(b, 'lobby/restart')));
  else foot(`<p class="hint-sm">Waiting for the VIP to start another game.</p>`);
}

// ---- AUDIENCE --------------------------------------------------------------
// The audience can do exactly one thing: add to the shared vote counters.
function renderAudience(room, me, audience) {
  const canVote = !!(me && me.canVote);
  api.countdown(canVote ? room.deadline : null, room.durations && room.durations[room.phase]);
  if (room.phase === 'VOTING' && canVote) {
    paint(`aud-vote:${room.round}:${room.answers.map((a) => a.id).join()}`, `
      <p class="eyebrow">Audience vote</p>
      <p class="prompt-text">${promptHTML(room.prompt)}</p>
      <div class="vote-list">
        ${room.answers.map((a) => `<button class="btn-vote" data-id="${esc(a.id)}">${esc(a.text)}</button>`).join('')}
      </div>`,
    () => {
      el.querySelectorAll('.btn-vote').forEach((b) => {
        b.onclick = () => {
          el.querySelectorAll('.btn-vote').forEach((x) => (x.disabled = true));
          request(null, 'audience/vote', { id: b.dataset.id }).then((r) => { if (!r.ok) repaint(); });
        };
      });
    });
    foot('');
    return;
  }
  const total = audience ? audience.total : 0;
  const lines = {
    LOBBY: ['You\'re in the audience', 'You\'ll vote on answers once the game gets going.'],
    PICKING: ['Hang tight', `${(room.pick && room.pick.pickerName) || 'Someone'} is picking a category`],
    WRITING: ['Players are writing', 'Get ready to vote'],
    VOTING: ['Vote counted', 'The audience favorite shows up on the TV'],
    RESULTS: ['Results are up', 'Look at the TV.'],
    SCORES: ['That\'s the game', 'Thanks for watching.'],
  }[room.phase] || ['Audience', ''];
  paint(`aud:${room.phase}:${room.round}`, status(lines[0], lines[1], room.phase === 'WRITING' || room.phase === 'PICKING'));
  foot(room.phase === 'VOTING' ? `<p class="hint-sm">${total} audience vote${total === 1 ? '' : 's'} so far</p>` : '');
}
