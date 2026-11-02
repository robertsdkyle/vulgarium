/**
 * Celebrations: confetti, party sounds, a buzz on the winner's phone.
 *
 * Everything is generated in code — the confetti is a small canvas particle
 * system and the sounds are synthesised with the Web Audio API — so there are
 * no audio or image files to license or load.
 *
 * Browsers only allow sound after someone has clicked/tapped the page, so
 * audio starts "locked"; the first click anywhere unlocks it (on the TV that's
 * usually the Start button). Sound can be muted and the choice is remembered.
 * Confetti is skipped for people who've asked their OS for reduced motion.
 */

const COLORS = ['#ffc64a', '#ff5e7a', '#45e0b0', '#8b7fff', '#7fd4ff', '#f6f0e4', '#ff9a3c'];
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Confetti
// ---------------------------------------------------------------------------
let canvas = null;
let ctx2d = null;
let parts = [];
let raf = null;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx2d = canvas.getContext('2d');
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', size);
}

/**
 * Throw confetti.
 *   amount   number of pieces
 *   origin   { x, y } in 0..1 of the viewport (default: top, spread across)
 *   spread   how wide the burst fans out, in radians
 */
export function confetti({ amount = 160, origin = null, spread = Math.PI / 2.2, power = 1 } = {}) {
  if (reducedMotion()) return;
  ensureCanvas();
  const W = innerWidth, H = innerHeight;
  for (let i = 0; i < amount; i++) {
    const fromTop = !origin;
    const x = fromTop ? Math.random() * W : origin.x * W;
    const y = fromTop ? -20 - Math.random() * H * 0.3 : origin.y * H;
    const angle = fromTop ? Math.PI / 2 : -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const speed = fromTop ? 1 + Math.random() * 3 : (7 + Math.random() * 9) * power;
    parts.push({
      x, y,
      vx: Math.cos(angle) * speed + (fromTop ? (Math.random() - 0.5) * 2 : 0),
      vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 7,
      h: 8 + Math.random() * 10,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      wobble: Math.random() * 10,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      round: Math.random() < 0.25,
      life: 0,
    });
  }
  if (!raf) raf = requestAnimationFrame(step);
}

function step() {
  const H = innerHeight;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  parts = parts.filter((p) => p.y < H + 40 && p.life < 600);
  for (const p of parts) {
    p.life += 1;
    p.vy += 0.18;          // gravity
    p.vx *= 0.985;         // air
    p.vy *= 0.985;
    p.wobble += 0.12;
    p.x += p.vx + Math.sin(p.wobble) * 0.6;
    p.y += p.vy;
    p.rot += p.vr;
    ctx2d.save();
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rot);
    ctx2d.scale(1, Math.abs(Math.cos(p.wobble)) * 0.8 + 0.2); // flutter
    ctx2d.fillStyle = p.color;
    if (p.round) { ctx2d.beginPath(); ctx2d.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx2d.fill(); }
    else ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx2d.restore();
  }
  raf = parts.length ? requestAnimationFrame(step) : null;
  if (!raf) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

/** Confetti bursting out of an element (e.g. the winning answer). */
export function confettiFrom(el, amount = 70) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  confetti({ amount, origin: { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight }, spread: Math.PI / 1.4, power: 0.8 });
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------
const SOUND_KEY = 'pb.sound';
let ac = null;
let muted = (() => { try { return localStorage.getItem(SOUND_KEY) === 'off'; } catch (_) { return false; } })();
const listeners = new Set();

export function soundOn() { return !muted; }
export function audioReady() { return !!ac && ac.state === 'running'; }
export function onSoundChange(fn) { listeners.add(fn); }
const emit = () => listeners.forEach((fn) => fn());

function unlock() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume().then(emit, () => {});
    emit();
  } catch (_) { /* no audio on this device — fine */ }
}
// The first real interaction unlocks audio for the rest of the session.
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, unlock, { passive: true }));

export function setSound(on) {
  muted = !on;
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (_) {}
  if (on) unlock();
  emit();
}

function playable() { return !muted && ac && ac.state === 'running'; }

function tone({ type = 'triangle', freq, at = 0, dur = 0.2, vol = 0.18, bendTo = null }) {
  const t = ac.currentTime + at;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t + dur * 0.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Filtered noise with an envelope — reads as a cheer / burst of applause. */
function cheer({ at = 0, dur = 1.6, vol = 0.12 } = {}) {
  const t = ac.currentTime + at;
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  // Clumpy noise: random "claps" on top of a hiss.
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.08 ? 1 : 0.35);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.6;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.15);
  g.gain.setValueAtTime(vol, t + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(t);
}

/** A party horn: a buzzy blast that bends up and wobbles. */
function horn({ at = 0, vol = 0.09 } = {}) {
  const t = ac.currentTime + at;
  const o = ac.createOscillator();
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  const g = ac.createGain();
  const lp = ac.createBiquadFilter();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(330, t);
  o.frequency.exponentialRampToValueAtTime(520, t + 0.12);
  lfo.frequency.value = 22;
  lfoGain.gain.value = 14;
  lfo.connect(lfoGain).connect(o.frequency);
  lp.type = 'lowpass';
  lp.frequency.value = 2600;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
  g.gain.setValueAtTime(vol, t + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
  o.connect(lp).connect(g).connect(ac.destination);
  o.start(t); lfo.start(t);
  o.stop(t + 0.8); lfo.stop(t + 0.8);
}

/** Round winner: a quick two-note "ta-da". */
export function playRoundWin() {
  if (!playable()) return;
  tone({ freq: 659.25, dur: 0.14, vol: 0.16 });            // E5
  tone({ freq: 987.77, at: 0.12, dur: 0.45, vol: 0.18 });  // B5
  tone({ type: 'sine', freq: 1318.5, at: 0.12, dur: 0.5, vol: 0.06 });
}

/** Game winner: rising fanfare, party horns, and a cheer. */
export function playFanfare() {
  if (!playable()) return;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C E G C
  notes.forEach((f, i) => tone({ type: 'square', freq: f, at: i * 0.13, dur: 0.18, vol: 0.07 }));
  tone({ type: 'triangle', freq: 1046.5, at: 0.52, dur: 0.9, vol: 0.16 });
  tone({ type: 'triangle', freq: 1318.5, at: 0.52, dur: 0.9, vol: 0.1 });
  tone({ type: 'triangle', freq: 1567.98, at: 0.52, dur: 0.9, vol: 0.08 });
  horn({ at: 0.45 });
  horn({ at: 0.9, vol: 0.07 });
  cheer({ at: 0.4, dur: 2.2 });
}

/** A short buzz for the winner's phone (Android; iOS ignores it). */
export function buzz(pattern = [60, 40, 120]) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
}
