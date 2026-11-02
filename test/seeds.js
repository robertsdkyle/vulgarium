// Seed-dealing tests. Run the server first:
//   T_WRITING=4 T_VOTING=3 T_RESULTS=1 node server.js
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = console.log;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? '  -> ' + extra : ''}`);
};

(async () => {
  let code = null;
  const host = io(URL);
  let hostState = null;
  host.on('state', (s) => { hostState = s; });
  await new Promise((r) => host.emit('host:create', {}, (res) => { code = res.code; r(); }));

  const names = ['Ann', 'Bo', 'Cy'];
  const socks = [];
  const states = {};
  for (const name of names) {
    const sk = io(URL);
    sk._name = name;
    sk.on('state', (s) => { states[name] = s; });
    await new Promise((r) => sk.emit('player:join', { code, name }, r));
    socks.push(sk);
  }
  await wait(200);

  log('\n[1] Seeds are dealt during WRITING');
  host.emit('host:start');
  await wait(400);
  check('phase is WRITING', hostState.phase === 'WRITING');
  const hands = names.map((n) => (states[n] && states[n].you.seeds) || []);
  check('every player got seeds', hands.every((h) => h.length > 0), JSON.stringify(hands.map(h => h.length)));
  check('hands are the configured size', hands.every((h) => h.length === 5), JSON.stringify(hands.map(h => h.length)));
  check('seeds are short strings', hands.flat().every((w) => typeof w === 'string' && w.length < 45));

  log('\n[2] Hands are PRIVATE');
  // The host sees the public state — it must contain no seeds anywhere.
  const hostJson = JSON.stringify(hostState);
  const anySeed = hands.flat()[0];
  check('host/TV state contains no seed text', !hostJson.includes(anySeed), 'leaked: ' + anySeed);
  check('public player list carries no seeds', hostState.players.every((p) => p.seeds === undefined));
  // A player's own state must not contain another player's hand.
  const annJson = JSON.stringify(states['Ann'].players);
  check("one player's state has no other player's seeds", !hands[1].some((w) => annJson.includes(w)));

  log('\n[3] No two players share a seed this round');
  const all = hands.flat();
  check('all dealt seeds are distinct', all.length === new Set(all).size,
    `${all.length} dealt, ${new Set(all).size} unique`);

  log('\n[4] Seeds refresh each round');
  const round1 = new Set(states['Ann'].you.seeds);
  for (const sk of socks) sk.emit('player:answer', { text: sk._name + ' r1' });
  await wait(300);
  for (const sk of socks) {
    const st = states[sk._name];
    const other = st.answers.filter((a) => a.pid !== st.you.pid)[0];
    if (other) sk.emit('player:vote', { targetId: other.pid });
  }
  await wait(2000); // through RESULTS into round 2
  check('now in round 2', hostState.round === 2, 'round=' + hostState.round);
  const round2 = states['Ann'].you.seeds || [];
  check('got a fresh hand in round 2', round2.length === 5);
  const overlap = round2.filter((w) => round1.has(w));
  check('round 2 hand differs from round 1', overlap.length < 5, `overlap=${overlap.length}`);

  log('\n[5] Seeds are absent outside the writing phase');
  for (const sk of socks) sk.emit('player:answer', { text: sk._name + ' r2' });
  await wait(400);
  check('phase is VOTING', hostState.phase === 'VOTING');
  check('no seeds sent while voting', (states['Ann'].you.seeds || []).length === 0);

  log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
