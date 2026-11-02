/**
 * PARTY BOX — realtime core
 *
 * Everything that isn't a particular game lives here: rooms, connections,
 * identity, reconnects, the wire protocol and entity sync. Games plug in
 * through a small interface (see games/index.js) and never touch a socket.
 *
 * THE WIRE PROTOCOL
 * ---------------------------------------------------------------------------
 *   HTTP  POST /rooms               -> { code, hostSecret }        (the TV)
 *   HTTP  GET  /rooms/:code         -> exists? which game? joinable? full?
 *   WS    /rooms/:code/play?role=player|audience|host&name=…&user-id=…
 *
 * The URL carries who you claim to be. The one thing it does NOT carry is
 * your reconnect secret — URLs end up in proxy and host logs — so the first
 * frame a client sends is `hello { secret? }`. Only then does the server
 * decide whether this is a new seat, a reclaimed seat, or a refusal.
 *
 * Every server -> client frame is  { seq, opcode, payload }.
 * `seq` counts up by one per frame on each connection, starting at the
 * welcome. Within a single WebSocket a gap should be impossible, so a client
 * that sees one asks for a `resync` and gets a fresh full snapshot.
 *
 * Client -> server frames are { opcode, payload, rid? }. If `rid` is present
 * the server answers with `reply { rid, ok, error? }`.
 *
 * ENTITIES
 * ---------------------------------------------------------------------------
 * State reaches clients as named entities, each a whole JSON value with a
 * version number:
 *
 *   room                 shared   — everyone in the room
 *   audience             shared   — everyone (vote counters)
 *   host                 private  — the TV only
 *   player:<user-id>     private  — that one player only
 *   audience:<user-id>   private  — that one audience member only
 *
 * The game never sends anything. After it changes its state it calls
 * ctx.sync(); the core asks the game for fresh views of every entity,
 * compares each to what it last sent, and for every one that changed bumps
 * the version and sends the WHOLE entity to the clients allowed to see it.
 * Clients ignore any entity whose version is not newer than what they hold.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// Close codes. 4000+ is the application range. A client should NOT
// auto-reconnect after any of these — they're answers, not accidents.
const CLOSE = {
  ERROR: 4000,
  REPLACED: 4001,      // same seat opened somewhere else
  BAD_SECRET: 4003,    // seat exists and you can't prove it's yours
  NOT_FOUND: 4004,
  NOT_JOINABLE: 4009,  // full, or game in progress (players only)
  ROOM_CLOSED: 4010,
  BAD_REQUEST: 4022,
  RATE_LIMITED: 4029,
};

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

const CFG = {
  HOST_GRACE_MS: env('HOST_GRACE', 120) * 1000,
  PLAYER_GRACE_MS: env('PLAYER_GRACE', 900) * 1000,   // seat held mid-game
  LOBBY_GRACE_MS: env('LOBBY_GRACE', 90) * 1000,      // seat held in the lobby
  ROOM_IDLE_MS: 3 * 60 * 60 * 1000,
  SWEEP_MS: 30 * 1000,
  HELLO_TIMEOUT_MS: 5000,
  HEARTBEAT_MS: 20000,
  MAX_AUDIENCE: 500,
  MAX_ROOMS_PER_IP: 15,
  ROOM_RATE_WINDOW_MS: 10 * 60 * 1000,
  MAX_LOOKUPS_PER_MIN: 60,
  MAX_MSGS_PER_WINDOW: 60,
  MSG_WINDOW_MS: 10 * 1000,
  MAX_FRAME_BYTES: 4096,
  AUDIENCE_SYNC_MS: 500,
};

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXYZ'; // no vowels, no I/O look-alikes
const USER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const NAME_MAX = 14;

const secret = () => crypto.randomBytes(18).toString('base64url');
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cleanName(raw) {
  // Strip control characters and collapse whitespace; the client escapes on
  // render, but there's no reason to store junk.
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * MIKE -> MIKE2 -> MIKE3. Case-insensitive against every seat in the room,
 * including seats held for disconnected players (their name is still "theirs").
 * The base is trimmed when needed so the suffix always fits the length cap.
 */
function dedupeName(name, taken) {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = String(n);
    const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name.slice(0, NAME_MAX - 4) + crypto.randomBytes(2).toString('hex');
}

function createCore({ app, server, games, port, lanAddress }) {
  const rooms = new Map(); // code -> Room

  // -------------------------------------------------------------------------
  // Rate limiting (per IP, in memory)
  // -------------------------------------------------------------------------
  const buckets = new Map(); // key -> [timestamps]
  function allow(key, max, windowMs) {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) { buckets.set(key, hits); return false; }
    hits.push(now);
    buckets.set(key, hits);
    return true;
  }
  function ipOf(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------
  function makeCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function createRoom(gameType) {
    const def = games[gameType];
    const room = {
      code: makeCode(),
      gameType,
      def,
      hostSecret: secret(),
      host: null,            // { conn, goneAt, userId }
      hostGoneAt: null,
      members: new Map(),    // userId -> Member (players + audience)
      nextId: 2,             // public seat ids; the host is always 1
      entities: new Map(),   // key -> { version, json, val }
      qr: null,
      joinUrl: null,
      lastActivity: Date.now(),
      audienceSyncTimer: null,
      destroyed: false,
      game: null,
    };
    room.game = def.create(makeCtx(room));
    rooms.set(room.code, room);
    return room;
  }

  function destroyRoom(room, reason) {
    if (room.destroyed) return;
    room.destroyed = true;
    try { room.game.destroy && room.game.destroy(); } catch (e) { console.error(e); }
    clearTimeout(room.audienceSyncTimer);
    for (const m of room.members.values()) {
      clearTimeout(m.graceTimer);
      if (m.conn) closeWith(m.conn, CLOSE.ROOM_CLOSED, 'room-closed', reason);
    }
    if (room.host && room.host.conn) closeWith(room.host.conn, CLOSE.ROOM_CLOSED, 'room-closed', reason);
    rooms.delete(room.code);
  }

  const touch = (room) => { room.lastActivity = Date.now(); };

  const players = (room) => [...room.members.values()].filter((m) => m.role === 'player');
  const audience = (room) => [...room.members.values()].filter((m) => m.role === 'audience');

  // -------------------------------------------------------------------------
  // The context handed to a game. This is the whole surface a game sees.
  // -------------------------------------------------------------------------
  function makeCtx(room) {
    return {
      get code() { return room.code; },
      players: () => players(room),
      audience: () => audience(room),
      member: (userId) => room.members.get(userId) || null,
      hostConnected: () => !!(room.host && room.host.conn),
      joinInfo: () => ({ qr: room.qr, joinUrl: room.joinUrl }),
      sync: () => sync(room),
      // Audience votes can arrive in bursts; coalesce them.
      syncSoon: () => {
        if (room.audienceSyncTimer) return;
        room.audienceSyncTimer = setTimeout(() => { room.audienceSyncTimer = null; sync(room); }, CFG.AUDIENCE_SYNC_MS);
      },
      touch: () => touch(room),
      // Give up a disconnected seat now rather than when its grace runs out
      // (e.g. going back to the lobby for a new game).
      release: (userId) => {
        const m = room.members.get(userId);
        if (m && !m.conn) { clearTimeout(m.graceTimer); removeMember(room, m); }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Entity sync
  // -------------------------------------------------------------------------
  /**
   * Who may see which entity. Kept here, in one place, rather than spread
   * through game code — it's the privacy boundary of the whole system.
   */
  function canSee(key, conn) {
    if (key === 'room' || key === 'audience') return true;
    if (key === 'host') return conn.role === 'host';
    const [scope, owner] = splitKey(key);
    if (scope === 'player') return conn.role === 'player' && conn.userId === owner;
    if (scope === 'audience') return conn.role === 'audience' && conn.userId === owner;
    return false;
  }
  function splitKey(key) {
    const i = key.indexOf(':');
    return i < 0 ? [key, null] : [key.slice(0, i), key.slice(i + 1)];
  }

  function connsOf(room) {
    const out = [];
    if (room.host && room.host.conn) out.push(room.host.conn);
    for (const m of room.members.values()) if (m.conn) out.push(m.conn);
    return out;
  }

  /** Recompute every view, send only what changed, to only who may see it. */
  function sync(room) {
    if (room.destroyed) return;
    const views = room.game.views();
    const next = new Map();
    const put = (key, val) => { if (val !== undefined && val !== null) next.set(key, val); };

    put('room', views.room);
    put('audience', views.audience);
    put('host', { code: room.code, game: room.gameType, qr: room.qr, joinUrl: room.joinUrl, ...(views.host || {}) });
    for (const [uid, v] of Object.entries(views.players || {})) put('player:' + uid, v);
    for (const [uid, v] of Object.entries(views.audienceMembers || {})) put('audience:' + uid, v);

    const changed = [];
    for (const [key, val] of next) {
      const json = JSON.stringify(val);
      const prev = room.entities.get(key);
      if (prev && prev.json === json) continue;
      const ent = { version: prev ? prev.version + 1 : 1, json, val };
      room.entities.set(key, ent);
      changed.push(key);
    }
    // Entities for seats that no longer exist are simply forgotten; nobody
    // is entitled to see them any more.
    for (const key of [...room.entities.keys()]) if (!next.has(key)) room.entities.delete(key);

    if (!changed.length) return;
    for (const conn of connsOf(room)) {
      if (!conn.welcomed) continue;
      for (const key of changed) {
        if (!canSee(key, conn)) continue;
        const ent = room.entities.get(key);
        send(conn, 'entity', { key, version: ent.version, val: ent.val });
      }
    }
  }

  function entitiesFor(room, conn) {
    const out = {};
    for (const [key, ent] of room.entities) {
      if (canSee(key, conn)) out[key] = { key, version: ent.version, val: ent.val };
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------
  function send(conn, opcode, payload) {
    if (conn.ws.readyState !== 1) return;
    conn.seq += 1;
    conn.ws.send(JSON.stringify({ seq: conn.seq, opcode, payload }));
  }

  function closeWith(conn, code, errCode, message) {
    if (conn.closedByServer) return;
    conn.closedByServer = true;
    try { send(conn, 'error', { code: errCode, message: message || errCode }); } catch (_) {}
    try { conn.ws.close(code, errCode); } catch (_) {}
  }

  /** "here": who is in the room right now. Audience is only itemised for the TV. */
  function hereFor(room, conn) {
    const list = [];
    if (room.host) list.push({ id: 1, role: 'host', name: 'TV', connected: !!room.host.conn });
    for (const m of room.members.values()) {
      if (m.role === 'audience' && conn.role !== 'host' && m.userId !== conn.userId) continue;
      list.push({ id: m.id, role: m.role, name: m.name, connected: !!m.conn });
    }
    return list;
  }

  function welcome(room, conn, { reconnect, resync = false }) {
    const self = conn.role === 'host' ? { id: 1, name: 'TV', secret: room.hostSecret } : room.members.get(conn.userId);
    conn.seq = 0; // the welcome restarts this connection's sequence
    conn.welcomed = true;
    send(conn, 'welcome', {
      id: self.id,
      role: conn.role,
      name: self.name,
      secret: conn.role === 'host' ? room.hostSecret : self.secret,
      reconnect,
      resync,
      code: room.code,
      game: room.gameType,
      title: room.def.title,
      serverNow: Date.now(),
      here: hereFor(room, conn),
      audienceCount: audience(room).filter((m) => m.conn).length,
      entities: entitiesFor(room, conn),
    });
  }

  /** Tell others about arrivals/departures. Audience churn only goes to the TV. */
  function announce(room, member, opcode, except) {
    for (const c of connsOf(room)) {
      if (!c.welcomed || c === except) continue;
      if (member.role === 'audience' && c.role !== 'host') continue;
      send(c, opcode, { id: member.id, role: member.role, name: member.name });
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------
  function lookup(room, userId) {
    const st = room.game.status();
    const seats = players(room).length;
    const full = seats >= room.def.maxPlayers;
    const out = {
      exists: true,
      code: room.code,
      game: room.gameType,
      title: room.def.title,
      phase: st.phase,
      inProgress: st.inProgress,
      full,
      joinable: !full && st.acceptingPlayers,
      audience: !!room.def.audience && audience(room).length < CFG.MAX_AUDIENCE,
      players: seats,
      maxPlayers: room.def.maxPlayers,
    };
    if (userId) {
      const m = room.members.get(userId);
      out.seat = m ? { role: m.role, name: m.name } : null;
    }
    return out;
  }

  app.get('/rooms/:code', (req, res) => {
    if (!allow('lookup:' + ipOf(req), CFG.MAX_LOOKUPS_PER_MIN, 60 * 1000)) {
      return res.status(429).json({ exists: false, error: 'Too many lookups. Wait a minute.' });
    }
    res.set('Cache-Control', 'no-store');
    const room = rooms.get(String(req.params.code || '').toUpperCase());
    if (!room) return res.status(404).json({ exists: false });
    const uid = String(req.query['user-id'] || '');
    res.json(lookup(room, USER_ID_RE.test(uid) ? uid : null));
  });

  app.post('/rooms', async (req, res) => {
    if (!allow('create:' + ipOf(req), CFG.MAX_ROOMS_PER_IP, CFG.ROOM_RATE_WINDOW_MS)) {
      return res.status(429).json({ error: 'Too many rooms from this connection. Wait a few minutes.' });
    }
    const body = req.body || {};
    const gameType = String(body.game || 'party-box');
    if (!games[gameType]) return res.status(400).json({ error: 'Unknown game.' });
    const room = createRoom(gameType);
    await makeQr(room, typeof body.origin === 'string' ? body.origin : null);
    sync(room);
    res.json({ code: room.code, hostSecret: room.hostSecret, game: gameType });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

  // -------------------------------------------------------------------------
  // QR / join address
  // -------------------------------------------------------------------------
  /**
   * A TV opened at localhost would encode "localhost" into its QR, which on a
   * phone means the phone itself. Swap in the LAN address in that case; a
   * deployed host reports a real hostname and is left alone.
   */
  function joinBase(origin) {
    let base = origin || `http://${lanAddress()}:${port}`;
    try {
      const u = new URL(base);
      if (['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(u.hostname)) {
        const lan = lanAddress();
        if (lan && lan !== 'localhost') { u.hostname = lan; base = u.origin; }
      }
    } catch (_) { /* malformed origin — use as-is */ }
    return base.replace(/\/+$/, '');
  }

  async function makeQr(room, origin) {
    const base = joinBase(origin);
    room.joinUrl = base;
    try {
      room.qr = await QRCode.toDataURL(`${base}/?c=${room.code}`, {
        margin: 1, width: 320, color: { dark: '#14102e', light: '#f6f0e4' },
      });
    } catch (_) { room.qr = null; }
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: CFG.MAX_FRAME_BYTES });
  const PLAY_PATH = /^\/rooms\/([A-Za-z]{4})\/play$/;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { return socket.destroy(); }
    const m = PLAY_PATH.exec(url.pathname);
    if (!m) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req, url, m[1].toUpperCase()));
  });

  function onSocket(ws, req, url, code) {
    const conn = {
      ws,
      code,
      role: String(url.searchParams.get('role') || 'player'),
      name: cleanName(url.searchParams.get('name')),
      userId: String(url.searchParams.get('user-id') || ''),
      seq: 0,
      welcomed: false,
      helloTimer: null,
      winStart: Date.now(),
      winCount: 0,
      ip: ipOf(req),
    };
    ws.on('error', () => {});

    if (!['player', 'audience', 'host'].includes(conn.role)) return closeWith(conn, CLOSE.BAD_REQUEST, 'bad-role');
    if (!USER_ID_RE.test(conn.userId)) return closeWith(conn, CLOSE.BAD_REQUEST, 'bad-user-id');
    const room = rooms.get(code);
    if (!room) return closeWith(conn, CLOSE.NOT_FOUND, 'room-not-found', 'No room with that code.');

    conn.helloTimer = setTimeout(() => closeWith(conn, CLOSE.BAD_REQUEST, 'no-hello'), CFG.HELLO_TIMEOUT_MS);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (_) { return; }
      if (!msg || typeof msg.opcode !== 'string') return;
      if (throttled(conn)) {
        if (msg.rid) send(conn, 'reply', { rid: msg.rid, ok: false, error: 'slow-down' });
        return;
      }
      const r = rooms.get(code);
      if (!r) return closeWith(conn, CLOSE.ROOM_CLOSED, 'room-closed');

      if (!conn.welcomed) {
        if (msg.opcode !== 'hello') return;
        clearTimeout(conn.helloTimer);
        return onHello(r, conn, (msg.payload && msg.payload.secret) || null);
      }
      onMessage(r, conn, msg);
    });

    ws.on('close', () => {
      clearTimeout(conn.helloTimer);
      const r = rooms.get(code);
      if (r && conn.welcomed) onDisconnect(r, conn);
    });
  }

  function throttled(conn) {
    const now = Date.now();
    if (now - conn.winStart > CFG.MSG_WINDOW_MS) { conn.winStart = now; conn.winCount = 0; }
    conn.winCount += 1;
    return conn.winCount > CFG.MAX_MSGS_PER_WINDOW;
  }

  function onHello(room, conn, presentedSecret) {
    // ---- The TV ----
    if (conn.role === 'host') {
      if (!safeEqual(presentedSecret, room.hostSecret)) return closeWith(conn, CLOSE.BAD_SECRET, 'bad-secret', 'That room belongs to another screen.');
      const reconnect = !!room.host;
      if (room.host && room.host.conn && room.host.conn !== conn) closeWith(room.host.conn, CLOSE.REPLACED, 'replaced', 'This room was opened on another screen.');
      room.host = { conn, userId: conn.userId };
      room.hostGoneAt = null;
      touch(room);
      room.game.onHostChange && room.game.onHostChange();
      sync(room);                       // others learn the TV is back...
      welcome(room, conn, { reconnect }); // ...and the TV gets the result
      announce(room, { id: 1, role: 'host', name: 'TV' }, 'client/connected', conn);
      return;
    }

    // ---- Reclaiming a seat ----
    const existing = room.members.get(conn.userId);
    if (existing) {
      if (!safeEqual(presentedSecret, existing.secret)) {
        return closeWith(conn, CLOSE.BAD_SECRET, 'seat-taken', 'This device already has a seat in that room. Use Reconnect.');
      }
      // Same seat open in another tab/phone: newest wins, the old one is told why.
      if (existing.conn && existing.conn !== conn) {
        const old = existing.conn;
        existing.conn = null;
        closeWith(old, CLOSE.REPLACED, 'replaced', 'You opened this seat somewhere else.');
      }
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      existing.conn = conn;
      existing.goneAt = null;
      conn.role = existing.role; // the seat decides the role, not the URL
      touch(room);
      room.game.onReconnect(existing);
      sync(room);                       // everyone else sees them come back
      welcome(room, conn, { reconnect: true });
      announce(room, existing, 'client/connected', conn);
      return;
    }

    // ---- A new seat ----
    const st = room.game.status();
    if (conn.role === 'player') {
      if (players(room).length >= room.def.maxPlayers) return closeWith(conn, CLOSE.NOT_JOINABLE, 'room-full', 'This room is full. You can still join the audience.');
      if (!st.acceptingPlayers) return closeWith(conn, CLOSE.NOT_JOINABLE, 'in-progress', 'That game already started. You can join the audience.');
    } else {
      if (!room.def.audience) return closeWith(conn, CLOSE.NOT_JOINABLE, 'no-audience', 'This game has no audience.');
      if (audience(room).length >= CFG.MAX_AUDIENCE) return closeWith(conn, CLOSE.NOT_JOINABLE, 'audience-full', 'The audience is full.');
    }

    const base = conn.name || (conn.role === 'player' ? 'Player' : 'Audience');
    const member = {
      id: room.nextId++,
      userId: conn.userId,
      role: conn.role,
      name: conn.role === 'player' ? dedupeName(base, players(room).map((p) => p.name)) : base,
      secret: secret(),
      conn,
      goneAt: null,
      graceTimer: null,
      joinedAt: Date.now(),
    };
    room.members.set(member.userId, member);
    touch(room);
    room.game.onJoin(member);
    sync(room);                 // build this seat's entities before the welcome
    welcome(room, conn, { reconnect: false });
    announce(room, member, 'client/connected', conn);
  }

  function onMessage(room, conn, msg) {
    const { opcode, payload, rid } = msg;
    const reply = (ok, error) => { if (rid !== undefined) send(conn, 'reply', { rid, ok, ...(error ? { error } : {}) }); };

    if (opcode === 'ping') return send(conn, 'pong', { t: Date.now() });
    if (opcode === 'resync') return welcome(room, conn, { reconnect: true, resync: true });

    const actor = conn.role === 'host' ? { role: 'host', id: 1 } : room.members.get(conn.userId);
    if (!actor || (actor.conn && actor.conn !== conn && conn.role !== 'host')) return reply(false, 'not-seated');
    if (conn.role === 'host' && (!room.host || room.host.conn !== conn)) return reply(false, 'not-host');

    let result;
    try {
      result = room.game.onMessage(actor, opcode, payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      console.error('game error', e);
      result = { ok: false, error: 'server-error' };
    }
    touch(room);
    const ok = !result || result.ok !== false;
    reply(ok, ok ? null : result.error || 'rejected');
  }

  function onDisconnect(room, conn) {
    if (conn.role === 'host') {
      if (!room.host || room.host.conn !== conn) return;
      room.host.conn = null;
      room.hostGoneAt = Date.now();
      announce(room, { id: 1, role: 'host', name: 'TV' }, 'client/disconnected', conn);
      room.game.onHostChange && room.game.onHostChange();
      sync(room);
      return;
    }
    const member = room.members.get(conn.userId);
    if (!member || member.conn !== conn) return; // superseded by a newer socket
    member.conn = null;
    member.goneAt = Date.now();
    announce(room, member, 'client/disconnected', conn);

    // Hold the seat. Short in the lobby, long mid-game — losing a score to a
    // screen lock is the worst thing that can happen to a player.
    const grace = member.role === 'audience'
      ? CFG.LOBBY_GRACE_MS
      : room.game.status().inProgress ? CFG.PLAYER_GRACE_MS : CFG.LOBBY_GRACE_MS;
    member.graceTimer = setTimeout(() => removeMember(room, member), grace);
    member.graceTimer.unref && member.graceTimer.unref();

    room.game.onDisconnect(member);
    sync(room);
  }

  function removeMember(room, member) {
    if (member.conn || room.members.get(member.userId) !== member) return;
    room.members.delete(member.userId);
    room.game.onRemove(member);
    announce(room, member, 'client/removed');
    sync(room);
  }

  // -------------------------------------------------------------------------
  // Heartbeat: WebSocket pings catch half-open sockets (a phone that lost
  // signal never sends a FIN). Two missed pongs and the socket is cut, which
  // starts that seat's grace period.
  // -------------------------------------------------------------------------
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._pbMissed >= 2) { ws.terminate(); continue; }
      ws._pbMissed = (ws._pbMissed || 0) + 1;
      try { ws.ping(); } catch (_) {}
    }
  }, CFG.HEARTBEAT_MS).unref();
  wss.on('connection', (ws) => { ws.on('pong', () => { ws._pbMissed = 0; }); ws.on('message', () => { ws._pbMissed = 0; }); });

  // -------------------------------------------------------------------------
  // Sweep
  // -------------------------------------------------------------------------
  setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      const hostGone = !room.host || !room.host.conn;
      if (hostGone && room.hostGoneAt && now - room.hostGoneAt > CFG.HOST_GRACE_MS) {
        destroyRoom(room, 'The TV disconnected.');
      } else if (now - room.lastActivity > CFG.ROOM_IDLE_MS) {
        destroyRoom(room, 'Room expired.');
      } else if (!room.host && now - room.lastActivity > CFG.HOST_GRACE_MS) {
        destroyRoom(room, 'The TV never connected.');
      }
    }
    for (const [key, hits] of buckets) {
      const live = hits.filter((t) => now - t < CFG.ROOM_RATE_WINDOW_MS);
      if (live.length) buckets.set(key, live); else buckets.delete(key);
    }
  }, CFG.SWEEP_MS).unref();

  return { rooms, CLOSE };
}

module.exports = { createCore, dedupeName, CLOSE };
