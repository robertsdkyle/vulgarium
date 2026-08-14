// Dealer tests: topic blend, freshness across games, and prompt swapping.
// Run the server first:  T_WRITING=2 T_VOTING=2 T_RESULTS=1 node server.js
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = console.log;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  (' + extra + ')' : ''}`);
};

// Map a prompt back to its category using the same sources the server uses.
const GROUPS = require('./prompts').GROUPS;
const templated = require('./templates').expand();
function groupOf(text) {
  for (const [g, items] of Object.entries(GROUPS)) if (items.includes(text)) return g;
  const t = templated.find((p) => p.text === text);
  return t ? t.group : 'UNKNOWN';
}

async function playGame(host, socks, collect) {
  host.emit('host:start');
  await wait(400);
  for (let r = 0; r < 3; r++) {
    await wait(200);
    if (collect.state && collect.state.prompt) collect.prompts.push(collect.state.prompt);
    for (const sk of socks) sk.emit('player:answer', { text: 'x' + Math.random() });
    await wait(350);
    for (const sk of socks) {
      const st = collect.playerStates[sk._name];
      if (!st) continue;
      const other = (st.answers || []).filter((a) => a.pid !== st.you.pid)[0];
      if (other) sk.emit('player:vote', { targetId: other.pid });
    }
    await wait(1600);
  }
  await wait(400);
}

(async () => {
  let code = null;
  const host = io(URL);
  const collect = { state: null, prompts: [], playerStates: {} };
  host.on('state', (s) => { collect.state = s; });
  await new Promise((r) => host.emit('host:create', {}, (res) => { code = res.code; r(); }));

  const socks = [];
  for (const name of ['Ann', 'Bo', 'Cy']) {
    const sk = io(URL); sk._name = name;
    sk.on('state', (s) => { collect.playerStates[name] = s; });
    await new Promise((r) => sk.emit('player:join', { code, name }, r));
    socks.push(sk);
  }
  // Personal prompts belong to no category by design, so switch them off —
  // this suite tests the category dealer in isolation. Personal prompts have
  // their own suite in test-personal.js.
  host.emit('host:personal', { on: false });
  await wait(300);

  // -------------------------------------------------------------------
  log('\n[1] One game spans three different topics');
  // -------------------------------------------------------------------
  await playGame(host, socks, collect);
  const g1 = collect.prompts.slice(0, 3);
  check('collected 3 prompts', g1.length === 3, g1.length + '');
  const cats1 = g1.map(groupOf);
  check('all 3 prompts identified', !cats1.includes('UNKNOWN'), cats1.join(', '));
  check('all 3 categories are DIFFERENT', new Set(cats1).size === 3, cats1.join(' / '));

  // -------------------------------------------------------------------
  log('\n[2] A second game brings fresh prompts');
  // -------------------------------------------------------------------
  host.emit('host:restart');
  await wait(400);
  collect.prompts = [];
  await playGame(host, socks, collect);
  const g2 = collect.prompts.slice(0, 3);
  check('second game dealt 3 prompts', g2.length === 3);
  const overlap = g2.filter((p) => g1.includes(p));
  check('no prompt repeated from game 1', overlap.length === 0, overlap.join(' | '));
  const cats2 = g2.map(groupOf);
  check('second game also spans 3 categories', new Set(cats2).size === 3, cats2.join(' / '));

  // -------------------------------------------------------------------
  log('\n[3] Repeated games keep drawing fresh material');
  // -------------------------------------------------------------------
  const seen = new Set([...g1, ...g2]);
  let repeats = 0;
  for (let i = 0; i < 4; i++) {
    host.emit('host:restart');
    await wait(300);
    collect.prompts = [];
    await playGame(host, socks, collect);
    for (const p of collect.prompts.slice(0, 3)) {
      if (seen.has(p)) repeats++;
      seen.add(p);
    }
  }
  check('six games produced no repeated prompt', repeats === 0, repeats + ' repeats');
  check('18 distinct prompts seen', seen.size === 18, seen.size + '');

  // -------------------------------------------------------------------
  log('\n[4] Host can swap a prompt nobody has answered yet');
  // -------------------------------------------------------------------
  host.emit('host:restart');
  await wait(300);
  host.emit('host:start');
  await wait(400);
  const before = collect.state.prompt;
  host.emit('host:swapPrompt');
  await wait(400);
  const after = collect.state.prompt;
  check('prompt changed after swap', before !== after, `${(before||'').slice(0,28)} -> ${(after||'').slice(0,28)}`);
  check('still in WRITING', collect.state.phase === 'WRITING');
  check('timer was reset', collect.state.deadline && collect.state.deadline > Date.now());

  // Once someone answers, swapping must be refused so no work is lost.
  socks[0].emit('player:answer', { text: 'committed' });
  await wait(300);
  const locked = collect.state.prompt;
  host.emit('host:swapPrompt');
  await wait(300);
  check('swap refused after someone answered', collect.state.prompt === locked);

  log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
