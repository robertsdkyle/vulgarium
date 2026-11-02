/**
 * The TV shell. Creates (or reclaims) a room, holds the host connection, and
 * loads the current game's TV module on demand:
 *
 *   /games/<type>/tv.js  exports  mount(els, api) · render(view)
 *
 * The TV is a renderer like the phones — the game runs on the server. It
 * just happens to be the one screen everybody looks at.
 */
import { Realtime, lookupRoom, deviceId, store, esc } from './realtime.js';
import { soundOn, audioReady, setSound, onSoundChange } from './celebrate.js';

// Sound toggle. Browsers keep audio locked until the page is clicked, so if
// the TV was reloaded mid-game the button says so and one click fixes it.
const soundBtn = document.getElementById('soundBtn');
function paintSound() {
  if (!soundOn()) { soundBtn.textContent = '🔇 Sound off'; soundBtn.className = 'sound-btn'; return; }
  if (!audioReady()) { soundBtn.textContent = '🔈 Click for sound'; soundBtn.className = 'sound-btn nudge'; return; }
  soundBtn.textContent = '🔊'; soundBtn.className = 'sound-btn';
}
soundBtn.onclick = () => setSound(!(soundOn() && audioReady()) ? true : false);
onSoundChange(paintSound);
paintSound();

const els = {
  stage: document.getElementById('stage'),
  controls: document.getElementById('controls'),
  roundLabel: document.getElementById('roundLabel'),
  timer: document.getElementById('timer'),
  timerNum: document.getElementById('timerNum'),
  audCount: document.getElementById('audCount'),
};
const linkbar = document.getElementById('linkbar');
const USER_ID = deviceId();
const HOST_KEY = 'pb.host'; // { code, hostSecret, game }
const GAME = new URLSearchParams(location.search).get('game') || 'party-box';

let rt = null;
let mod = null;
let queued = false;

async function createRoom() {
  const res = await fetch('/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The address the TV was opened at becomes the QR target.
    body: JSON.stringify({ game: GAME, origin: location.origin }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not start a room.');
  store.set(HOST_KEY, { code: body.code, hostSecret: body.hostSecret, game: body.game });
  return body;
}

async function boot() {
  let saved = store.get(HOST_KEY);
  if (saved) {
    const look = await lookupRoom(saved.code);
    if (!look.exists && !look.offline) { store.del(HOST_KEY); saved = null; }
  }
  try {
    if (!saved) saved = await createRoom();
  } catch (e) {
    return fatal(e.message, true);
  }
  connect(saved);
}

function connect(saved) {
  if (rt) rt.stop();
  rt = new Realtime({
    code: saved.code,
    role: 'host',
    name: 'TV',
    userId: USER_ID,
    secret: saved.hostSecret,
    onStatus(st) { linkbar.hidden = st !== 'reconnecting'; },
    async onWelcome(w) {
      if (!mod) {
        try {
          mod = await import(`/games/${encodeURIComponent(w.game)}/tv.js`);
          mod.mount(els, { send: (op, p) => rt.send(op, p), now: () => rt.now() });
        } catch (e) { return fatal(`Couldn't load this game: ${e.message}`); }
      }
      queue();
    },
    onChange: queue,
    onPresence: queue,
    onFatal(err) {
      if (err.code === 'replaced') {
        return fatal('This room was opened on another screen.', false, 'Show it here instead', () => { rt.restart(); });
      }
      store.del(HOST_KEY);
      fatal(`${err.message || 'The room closed.'}`, true);
    },
  });
  rt.connect();
}

function queue() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (!rt || !mod || !rt.welcomed) return;
    mod.render({ room: rt.get('room'), host: rt.get('host'), audience: rt.get('audience'), here: rt.here });
  });
}

function fatal(msg, offerNew, label, action) {
  els.timer.hidden = true;
  els.stage.innerHTML = `<p class="hint">${esc(msg)}</p>`;
  els.controls.innerHTML = offerNew || action
    ? `<button class="btn-big" id="fatalBtn">${esc(label || 'Start a new room')}</button>`
    : '';
  const b = document.getElementById('fatalBtn');
  if (b) b.onclick = action || (() => { store.del(HOST_KEY); location.reload(); });
}

boot();
