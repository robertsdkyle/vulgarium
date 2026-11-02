/**
 * Browser side of the Party Box wire protocol. Shared by the phone and the TV.
 *
 *  - Opens  /rooms/:code/play?role=…&name=…&user-id=…  and sends `hello`
 *    with the reconnect secret as the first frame.
 *  - Keeps a versioned entity store: anything not newer than what we hold
 *    is dropped, so an out-of-order or duplicate frame can't roll state back.
 *  - Watches `seq`; a gap asks the server for a fresh snapshot (`resync`).
 *  - Reconnects on its own after an accidental drop (backoff + jitter), but
 *    never after a deliberate refusal (close codes 4000+).
 *  - App-level heartbeat, because a browser can't see WebSocket pings and a
 *    phone coming back from a screen lock often holds a dead socket.
 */

const FATAL_MIN = 4000;
const PING_EVERY_MS = 15000;
const DEAD_AFTER_MS = 40000;

export function wsUrl(code, params) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams(params);
  return `${proto}//${location.host}/rooms/${encodeURIComponent(code)}/play?${q}`;
}

export async function lookupRoom(code, userId) {
  try {
    const res = await fetch(`/rooms/${encodeURIComponent(code)}${userId ? '?user-id=' + encodeURIComponent(userId) : ''}`, { cache: 'no-store' });
    if (res.status === 429) return { exists: false, error: 'Slow down a little and try again.' };
    return await res.json();
  } catch (_) {
    return { exists: false, error: 'Could not reach the server.', offline: true };
  }
}

export class Realtime {
  /**
   * opts: { code, role, name, userId, secret,
   *         onWelcome(payload), onChange(keys), onStatus(status), onFatal(err), onPresence(here) }
   */
  constructor(opts) {
    Object.assign(this, { onWelcome() {}, onChange() {}, onStatus() {}, onFatal() {}, onPresence() {} }, opts);
    this.entities = new Map();
    this.here = [];
    this.ws = null;
    this.lastSeq = 0;
    this.attempt = 0;
    this.offset = 0;
    this.pending = new Map();
    this.nextRid = 1;
    this.stopped = false;
    this.lastHeard = Date.now();
    this.welcomed = false;
    this._timers = [];

    this._onVisible = () => {
      if (document.visibilityState !== 'visible' || this.stopped) return;
      // Back from a screen lock: if we haven't heard from the server in a
      // while, assume the socket is dead rather than waiting to find out.
      if (!this.ws || this.ws.readyState > 1 || Date.now() - this.lastHeard > PING_EVERY_MS + 5000) this._reconnectNow();
      else this._raw({ opcode: 'ping' });
    };
    this._onOnline = () => { if (!this.stopped) this._reconnectNow(); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('online', this._onOnline);
    this._heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (Date.now() - this.lastHeard > DEAD_AFTER_MS) { try { this.ws.close(); } catch (_) {} return; }
      this._raw({ opcode: 'ping' });
    }, PING_EVERY_MS);
  }

  get(key) { const e = this.entities.get(key); return e ? e.val : null; }
  now() { return Date.now() + this.offset; }
  get open() { return !!this.ws && this.ws.readyState === 1 && this.welcomed; }

  connect() {
    if (this.stopped) return;
    this.welcomed = false;
    this.onStatus(this.attempt ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(wsUrl(this.code, { role: this.role, name: this.name || '', 'user-id': this.userId }));
    this.ws = ws;
    let fatal = null;

    ws.onopen = () => {
      this.lastHeard = Date.now();
      ws.send(JSON.stringify({ opcode: 'hello', payload: this.secret ? { secret: this.secret } : {} }));
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.opcode === 'error') { fatal = msg.payload; return; }
      this._handle(msg);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.welcomed = false;
      for (const [, res] of this.pending) res({ ok: false, error: 'disconnected' });
      this.pending.clear();
      if (this.stopped) return;
      if (ev.code >= FATAL_MIN) {
        this.stopped = true;
        this.onStatus('closed');
        this.onFatal(fatal || { code: 'closed-' + ev.code, message: 'Disconnected.' });
        return;
      }
      this._schedule();
    };
    ws.onerror = () => {};
  }

  _schedule() {
    this.attempt += 1;
    this.onStatus('reconnecting');
    const base = Math.min(8000, 400 * 2 ** Math.min(this.attempt, 5));
    const delay = base / 2 + Math.random() * base / 2;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect(), delay);
  }

  _reconnectNow() {
    clearTimeout(this._retry);
    if (this.ws && this.ws.readyState <= 1) {
      const old = this.ws;
      this.ws = null;
      old.onclose = null;
      try { old.close(); } catch (_) {}
    }
    this.attempt = Math.max(this.attempt, 1);
    this.connect();
  }

  _handle(msg) {
    const { seq, opcode, payload } = msg;
    if (opcode === 'welcome') {
      this.lastSeq = seq;
      this.welcomed = true;
      this.attempt = 0;
      this.secret = payload.secret;
      this.role = payload.role; // the seat decides the role, not what we asked for
      this.offset = payload.serverNow - Date.now();
      this.here = payload.here || [];
      // A welcome is a full snapshot: it replaces everything we hold.
      this.entities = new Map(Object.entries(payload.entities).map(([k, e]) => [k, { version: e.version, val: e.val }]));
      this.onStatus('open');
      this.onWelcome(payload);
      this.onChange([...this.entities.keys()]);
      return;
    }
    if (seq !== this.lastSeq + 1) {
      // Shouldn't happen on one socket — but if it does, don't guess.
      this.lastSeq = seq;
      this._raw({ opcode: 'resync' });
      return;
    }
    this.lastSeq = seq;

    switch (opcode) {
      case 'entity': {
        const cur = this.entities.get(payload.key);
        if (cur && cur.version >= payload.version) return; // stale
        this.entities.set(payload.key, { version: payload.version, val: payload.val });
        this.onChange([payload.key]);
        return;
      }
      case 'reply': {
        const res = this.pending.get(payload.rid);
        if (res) { this.pending.delete(payload.rid); res(payload); }
        return;
      }
      case 'client/connected':
      case 'client/disconnected':
      case 'client/removed': {
        const others = this.here.filter((h) => h.id !== payload.id);
        if (opcode !== 'client/removed') others.push({ ...payload, connected: opcode === 'client/connected' });
        this.here = others;
        this.onPresence(this.here);
        return;
      }
    }
  }

  _raw(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  /** Send a request; resolves with { ok, error? } from the server. */
  send(opcode, payload = {}) {
    if (!this.open) return Promise.resolve({ ok: false, error: 'offline' });
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      this.pending.set(rid, resolve);
      this._raw({ opcode, payload, rid });
      setTimeout(() => { if (this.pending.has(rid)) { this.pending.delete(rid); resolve({ ok: false, error: 'timeout' }); } }, 8000);
    });
  }

  /** Try again after a fatal close (e.g. "use this tab" after being replaced). */
  restart() {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._retry);
    clearInterval(this._heartbeat);
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('online', this._onOnline);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (_) {} }
  }
}

// ---------------------------------------------------------------------------
// Device identity and small helpers
// ---------------------------------------------------------------------------

/**
 * A stable id for this browser, made once and kept in localStorage.
 * crypto.randomUUID only exists in secure contexts, and a phone on the LAN
 * reaches us over plain http://192.168…, so build a v4 UUID by hand.
 */
export function deviceId() {
  const KEY = 'pb.device';
  let id = store.get(KEY);
  if (typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  store.set(KEY, id);
  return id;
}

// localStorage can throw (private mode, blocked storage); never let it break the game.
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Prompts carry a ______ blank; render it as a styled slot.
export const promptHTML = (t) => esc(t || '').replace(/_{3,}/g, '<span class="blank"></span>');
