/**
 * The phone shell. Knows how to find a room, join it, hold a seat across
 * reloads, and keep a connection alive. Knows NOTHING about any game: once
 * the server says which game this room is playing, the shell loads that
 * game's controller module on demand and hands it the entities to render.
 *
 *   /games/<type>/controller.js  exports  mount(el, api) · render(view) · unmount()
 */
import { Realtime, lookupRoom, deviceId, store, esc } from './realtime.js';

const stage = document.getElementById('stage');
const meEl = document.getElementById('me');
const linkbar = document.getElementById('linkbar');
const pbar = document.getElementById('pbar');
const pbarTrack = document.getElementById('pbarTrack');

const USER_ID = deviceId();
const SESSION_KEY = 'pb.session';  // { roomCode, name, userId, secret, role }
const NAME_KEY = 'pb.name';

let rt = null;          // the live connection
let controller = null;  // the loaded game module
let renderQueued = false;

// ---------------------------------------------------------------------------
// App-like behaviour: no pinch/double-tap zoom, installable, offline shell.
// ---------------------------------------------------------------------------
// iOS ignores user-scalable=no for pinch; double-tap zoom is handled by
// `touch-action: manipulation` in the stylesheet.
document.addEventListener('gesturestart', (e) => e.preventDefault());
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const loadSession = () => {
  const s = store.get(SESSION_KEY);
  return s && s.roomCode && s.secret && s.userId === USER_ID ? s : null;
};
const saveSession = (s) => store.set(SESSION_KEY, s);
const forgetSession = () => store.del(SESSION_KEY);

// ---------------------------------------------------------------------------
// Countdown bar (lives outside the stage so re-renders don't reset it)
// ---------------------------------------------------------------------------
let countdownTimer = null;
let countdownKey = '';
function countdown(deadline, totalSec) {
  const key = deadline + ':' + totalSec;
  if (key === countdownKey) return;
  countdownKey = key;
  clearInterval(countdownTimer);
  if (!deadline || !totalSec) { pbarTrack.hidden = true; return; }
  pbarTrack.hidden = false;
  const tick = () => {
    const leftMs = Math.max(0, deadline - (rt ? rt.now() : Date.now()));
    pbar.style.width = Math.max(0, Math.min(100, (leftMs / (totalSec * 1000)) * 100)) + '%';
    pbar.classList.toggle('urgent', leftMs <= 5000);
    if (leftMs <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

function setHeader(me) {
  if (!me) { meEl.textContent = ''; return; }
  const av = me.avatar ? `<span class="av" style="--av:${esc(me.avatar.color)}">${esc(me.avatar.glyph)}</span>` : '';
  const score = typeof me.score === 'number' ? `<span class="pts">${me.score}</span>` : '';
  meEl.innerHTML = `${av}<span>${esc(me.name)}</span>${score}`;
}

// ---------------------------------------------------------------------------
// Landing: reconnect card or join form
// ---------------------------------------------------------------------------
async function boot() {
  const preset = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const session = loadSession();
  if (session && (!preset || preset === session.roomCode)) {
    stage.innerHTML = `<p class="status"><strong>Checking your room</strong><span class="waiting-dots"></span></p>`;
    const look = await lookupRoom(session.roomCode, USER_ID);
    if (look.exists && look.seat) return showReconnect(session, look);
    if (!look.offline) forgetSession();
    return showJoin({ code: preset, message: look.offline ? look.error : look.exists ? '' : 'Your last room has ended.' });
  }
  showJoin({ code: preset });
}

function showReconnect(session, look) {
  teardown();
  setHeader(null);
  stage.innerHTML = `
    <div class="card reconnect-card">
      <p class="eyebrow">${esc(look.title || 'Party Box')} · room ${esc(session.roomCode)}</p>
      <p class="big-name">${esc(look.seat.name || session.name)}</p>
      <p class="hint-sm">${look.seat.role === 'audience' ? 'Your audience seat is still here.' : 'Your seat is being held for you.'}</p>
      <button class="btn-go btn-xl" id="reconnect">Reconnect</button>
    </div>
    <button class="btn-link" id="other">Join a different room</button>`;
  document.getElementById('reconnect').onclick = () => play({ code: session.roomCode, role: session.role, name: session.name, secret: session.secret });
  document.getElementById('other').onclick = () => { forgetSession(); showJoin({}); };
}

function showJoin({ code = '', message = '' } = {}) {
  teardown();
  setHeader(null);
  countdown(null);
  const savedName = store.get(NAME_KEY) || '';
  stage.innerHTML = `
    <div class="field">
      <label for="code">Room code</label>
      <input id="code" class="code-input" maxlength="4" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="····" value="${esc(code)}">
    </div>
    <p class="lookup" id="lookup" aria-live="polite"></p>
    <div class="field" id="nameField">
      <label for="name">Your name</label>
      <input id="name" maxlength="14" autocomplete="nickname" autocorrect="off" spellcheck="false" placeholder="What should we call you?" value="${esc(savedName)}">
    </div>
    <p class="error" id="err">${esc(message)}</p>
    <button class="btn-go btn-xl" id="join" disabled>Join</button>`;

  const codeInput = document.getElementById('code');
  const nameInput = document.getElementById('name');
  const lookupEl = document.getElementById('lookup');
  const errEl = document.getElementById('err');
  const joinBtn = document.getElementById('join');
  let look = null;
  let seq = 0;

  // As soon as four letters are in, ask the server about the room — before
  // any socket is opened. The button says what will actually happen.
  async function check() {
    const c = codeInput.value;
    look = null;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Join';
    lookupEl.className = 'lookup';
    if (c.length < 4) { lookupEl.textContent = ''; return; }
    const mine = ++seq;
    lookupEl.textContent = 'Looking…';
    const res = await lookupRoom(c, USER_ID);
    if (mine !== seq) return; // they kept typing
    look = res;
    const session = loadSession();
    if (!res.exists) {
      lookupEl.className = 'lookup bad';
      lookupEl.textContent = res.error || 'No room with that code. Check the TV.';
      return;
    }
    if (session && session.roomCode === c && res.seat) {
      lookupEl.className = 'lookup ok';
      lookupEl.innerHTML = `<b>${esc(res.title)}</b> · you're already in as ${esc(res.seat.name)}`;
      joinBtn.textContent = 'Reconnect';
      joinBtn.disabled = false;
      return;
    }
    if (res.joinable) {
      lookupEl.className = 'lookup ok';
      lookupEl.innerHTML = `<b>${esc(res.title)}</b> · ${res.players}/${res.maxPlayers} players · in the lobby`;
      joinBtn.textContent = 'Join';
    } else if (res.audience) {
      lookupEl.className = 'lookup warn';
      lookupEl.innerHTML = `<b>${esc(res.title)}</b> · ${res.full ? 'room is full' : 'game in progress'} — join the audience and vote`;
      joinBtn.textContent = 'Join the audience';
    } else {
      lookupEl.className = 'lookup bad';
      lookupEl.innerHTML = `<b>${esc(res.title)}</b> · ${res.full ? 'room is full' : 'game in progress'}`;
      return;
    }
    joinBtn.disabled = false;
  }

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    errEl.textContent = '';
    check();
    if (codeInput.value.length === 4 && !nameInput.value) nameInput.focus();
  });
  if (code.length === 4) check();
  else codeInput.focus();

  joinBtn.onclick = () => {
    if (!look || !look.exists) return;
    const c = codeInput.value;
    const session = loadSession();
    if (session && session.roomCode === c && look.seat) {
      return play({ code: c, role: session.role, name: session.name, secret: session.secret });
    }
    const role = look.joinable ? 'player' : 'audience';
    const name = nameInput.value.trim();
    if (role === 'player' && !name) { errEl.textContent = 'Pick a name so people know who you are.'; nameInput.focus(); return; }
    store.set(NAME_KEY, name);
    play({ code: c, role, name });
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click(); });
}

// ---------------------------------------------------------------------------
// In a room
// ---------------------------------------------------------------------------
function teardown() {
  if (rt) { rt.stop(); rt = null; }
  if (controller) { try { controller.unmount && controller.unmount(); } catch (_) {} controller = null; }
  linkbar.hidden = true;
}

function play({ code, role, name, secret = null }) {
  teardown();
  stage.innerHTML = `<p class="status"><strong>${secret ? 'Reconnecting' : 'Joining'}</strong><span class="waiting-dots"></span></p>`;
  let gameType = null;

  rt = new Realtime({
    code, role, name, userId: USER_ID, secret,
    onStatus(st) {
      linkbar.hidden = !(st === 'reconnecting');
    },
    async onWelcome(w) {
      saveSession({ roomCode: w.code, name: w.name, userId: USER_ID, secret: w.secret, role: w.role });
      if (gameType !== w.game || !controller) {
        gameType = w.game;
        try {
          // Each game ships its own controller; only the one in use loads.
          const mod = await import(`/games/${encodeURIComponent(w.game)}/controller.js`);
          controller = mod;
          stage.innerHTML = '';
          controller.mount(stage, {
            role: w.role,
            send: (op, payload) => rt.send(op, payload),
            now: () => rt.now(),
            countdown,
          });
        } catch (e) {
          stage.innerHTML = `<p class="status"><strong>Couldn't load this game</strong>${esc(e.message)}</p>`;
          return;
        }
      }
      queueRender();
    },
    onChange: queueRender,
    onPresence: queueRender,
    onFatal(err) { onFatal(err, { code, role, name }); },
  });
  rt.connect();
}

// Several entity frames often land together (welcome, then a burst during a
// phase change). Render once per frame, not once per message.
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!rt || !controller || !rt.welcomed) return;
    const role = rt.role;
    const me = rt.get(`${role === 'audience' ? 'audience' : 'player'}:${USER_ID}`);
    setHeader(role === 'audience' ? { name: (me && me.name) || 'Audience', avatar: { color: '#9a92c4', glyph: '👁' } } : me);
    controller.render({ role, room: rt.get('room'), me, audience: rt.get('audience'), here: rt.here });
  });
}

function onFatal(err, attempt) {
  const code = err && err.code;
  const msg = (err && err.message) || 'Disconnected.';
  if (code === 'replaced') {
    teardown();
    setHeader(null);
    countdown(null);
    stage.innerHTML = `
      <p class="status"><strong>Open somewhere else</strong>${esc(msg)}</p>
      <button class="btn-go btn-xl" id="here">Use this screen</button>`;
    document.getElementById('here').onclick = () => {
      const s = loadSession();
      if (s) play({ code: s.roomCode, role: s.role, name: s.name, secret: s.secret });
      else boot();
    };
    return;
  }
  if (code === 'room-closed' || code === 'room-not-found') {
    forgetSession();
    return showJoin({ message: code === 'room-closed' ? `Game over — ${msg}` : msg });
  }
  if (code === 'seat-taken') {
    // Our saved secret didn't match. Nothing to do but start over.
    forgetSession();
    return showJoin({ code: attempt.code, message: msg });
  }
  if (code === 'in-progress' || code === 'room-full') return showJoin({ code: attempt.code, message: msg });
  showJoin({ code: attempt.code, message: msg });
}

boot();
