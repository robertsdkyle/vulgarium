/**
 * A tiny client for the Party Box wire protocol, for tests. Mirrors what the
 * browser does: open the play URL, send hello, keep a versioned entity store.
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const BASE = process.env.TEST_URL || 'http://localhost:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function createRoom(game = 'party-box') {
  const res = await fetch(BASE + '/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game, origin: 'http://x:3000' }),
  });
  return res.json();
}

async function lookup(code, userId) {
  const res = await fetch(`${BASE}/rooms/${code}${userId ? '?user-id=' + userId : ''}`);
  return { status: res.status, body: await res.json() };
}

/**
 * Connect a client. Resolves once the welcome arrives, or rejects with the
 * server's error frame / close code.
 */
function connect({ code, role = 'player', name = '', userId = crypto.randomUUID(), secret = null }) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ role, name, 'user-id': userId });
    const ws = new WebSocket(`${WS_BASE}/rooms/${code}/play?${q}`);
    const c = {
      ws, userId, role, name,
      welcome: null,
      entities: {},          // key -> { version, val }
      frames: [],            // every frame, in order
      gaps: 0,
      stale: 0,
      lastSeq: 0,
      error: null,
      closeCode: null,
      pending: new Map(),
      nextRid: 1,
      listeners: new Set(),
      get room() { return (c.entities.room || {}).val; },
      get me() { return (c.entities[`${c.role === 'audience' ? 'audience' : 'player'}:${c.userId}`] || {}).val; },
      get host() { return (c.entities.host || {}).val; },
      get audience() { return (c.entities.audience || {}).val; },
      send(opcode, payload = {}) {
        const rid = c.nextRid++;
        return new Promise((res) => {
          c.pending.set(rid, res);
          ws.send(JSON.stringify({ opcode, payload, rid }));
          setTimeout(() => { if (c.pending.has(rid)) { c.pending.delete(rid); res({ ok: false, error: 'timeout' }); } }, 3000);
        });
      },
      raw(obj) { ws.send(JSON.stringify(obj)); },
      waitFor(pred, ms = 5000) {
        return new Promise((res, rej) => {
          if (safe(pred)) return res(true);
          const t = setTimeout(() => { c.listeners.delete(fn); rej(new Error('waitFor timeout')); }, ms);
          const fn = () => { if (safe(pred)) { clearTimeout(t); c.listeners.delete(fn); res(true); } };
          c.listeners.add(fn);
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    };
    const safe = (pred) => { try { return !!pred(c); } catch (_) { return false; } };

    ws.on('open', () => ws.send(JSON.stringify({ opcode: 'hello', payload: secret ? { secret } : {} })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      c.frames.push(msg);
      if (msg.opcode === 'welcome') {
        c.lastSeq = msg.seq;
        c.welcome = msg.payload;
        c.role = msg.payload.role;
        c.entities = {};
        for (const [k, e] of Object.entries(msg.payload.entities)) c.entities[k] = { version: e.version, val: e.val };
        resolve(c);
      } else {
        if (msg.seq !== c.lastSeq + 1) c.gaps++;
        c.lastSeq = msg.seq;
      }
      if (msg.opcode === 'entity') {
        const cur = c.entities[msg.payload.key];
        if (cur && cur.version >= msg.payload.version) c.stale++;
        else c.entities[msg.payload.key] = { version: msg.payload.version, val: msg.payload.val };
      }
      if (msg.opcode === 'reply' && c.pending.has(msg.payload.rid)) {
        const r = c.pending.get(msg.payload.rid);
        c.pending.delete(msg.payload.rid);
        r(msg.payload);
      }
      if (msg.opcode === 'error') c.error = msg.payload;
      for (const fn of [...c.listeners]) fn();
    });
    ws.on('close', (codeNum) => {
      c.closeCode = codeNum;
      for (const fn of [...c.listeners]) fn();
      if (!c.welcome) reject(Object.assign(new Error((c.error && c.error.code) || 'closed'), { closeCode: codeNum, payload: c.error }));
    });
    ws.on('error', () => {});
  });
}

/** Open a room with a TV plus named players. */
async function setupRoom(names, { audience = 0, house = false } = {}) {
  const { code, hostSecret } = await createRoom();
  const host = await connect({ code, role: 'host', name: 'TV', secret: hostSecret });
  // House answers change vote counts, so suites opt in to them explicitly.
  if (!house) await host.send('host/house', { on: false });
  const players = [];
  for (const n of names) players.push(await connect({ code, name: n }));
  const aud = [];
  for (let i = 0; i < audience; i++) aud.push(await connect({ code, role: 'audience', name: 'aud' + i }));
  await wait(100);
  return { code, hostSecret, host, players, audience: aud };
}

/**
 * Drive a player through whatever phase they're in: pick if they're the
 * picker, answer if writing, vote for the first option if voting.
 */
async function act(p, text) {
  const me = p.me;
  if (!me) return;
  if (me.permissions.canPick) {
    const c = p.room.pick.choices.find((x) => !x.disabled);
    return p.send('pick/choose', { id: c.id });
  }
  if (me.permissions.canWrite) return p.send('write/answer', { text: text || 'ans ' + Math.random().toString(36).slice(2, 7) });
  if (me.permissions.canVote && me.choices.length) return p.send('vote/cast', { id: me.choices[0].id });
}

/** Play one full game; returns the prompts seen, in order. */
async function playGame(host, players, { startWith = 'host' } = {}) {
  const prompts = [];
  if (startWith === 'host') await host.send('host/start');
  for (let round = 1; round <= 3; round++) {
    await host.waitFor((h) => h.room.round === round && ['PICKING', 'WRITING'].includes(h.room.phase), 8000);
    if (host.room.phase === 'PICKING') {
      const picker = players.find((p) => p.me && p.me.permissions.canPick);
      if (picker) await act(picker);
      await host.waitFor((h) => h.room.phase === 'WRITING', 8000);
    }
    prompts.push(host.room.prompt);
    await Promise.all(players.map((p) => p.waitFor((c) => c.me.permissions.canWrite, 3000).catch(() => {})));
    for (const p of players) await act(p);
    await host.waitFor((h) => h.room.phase === 'VOTING' || h.room.phase === 'RESULTS', 8000);
    if (host.room.phase === 'VOTING') {
      await Promise.all(players.map((p) => p.waitFor((c) => c.room.phase === 'VOTING' && c.me.choices.length > 0, 3000).catch(() => {})));
      for (const p of players) await act(p);
    }
    await host.waitFor((h) => h.room.phase === 'RESULTS', 8000);
    await host.send('host/skip');
  }
  await host.waitFor((h) => h.room.phase === 'SCORES', 8000);
  return prompts;
}

function makeChecker() {
  const st = { pass: 0, fail: 0 };
  const check = (label, cond, extra) => {
    cond ? st.pass++ : st.fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  (' + extra + ')' : ''}`);
  };
  const done = () => {
    console.log(`\n${st.pass} passed, ${st.fail} failed\n`);
    process.exit(st.fail ? 1 : 0);
  };
  return { check, done };
}

module.exports = { BASE, wait, createRoom, lookup, connect, setupRoom, act, playGame, makeChecker };
