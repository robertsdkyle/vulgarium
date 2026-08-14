// Personal prompt tests. Run the server first:
//   T_WRITING=2 T_VOTING=2 T_RESULTS=1 node server.js   (PERSONAL_ROUNDS defaults to 2)
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = console.log;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  (' + extra + ')' : ''}`);
};

async function room(names) {
  const host = io(URL);
  const st = { host: null, players: {} };
  host.on('state', (s) => { st.host = s; });
  const code = await new Promise((r) => host.emit('host:create', {}, (res) => r(res.code)));
  const socks = [];
  for (const n of names) {
    const sk = io(URL); sk._n = n;
    sk.on('state', (s) => { st.players[n] = s; });
    await new Promise((r) => sk.emit('player:join', { code, name: n }, r));
    socks.push(sk);
  }
  await wait(250);
  return { host, socks, st, code };
}

// Play through, capturing every prompt.
async function play(host, socks, st, rounds = 3) {
  const seen = [];
  host.emit('host:start');
  await wait(400);
  for (let r = 0; r < rounds; r++) {
    await wait(150);
    if (st.host && st.host.prompt) seen.push(st.host.prompt);
    for (const sk of socks) sk.emit('player:answer', { text: 'a' + Math.random() });
    await wait(350);
    for (const sk of socks) {
      const p = st.players[sk._n];
      const other = p && (p.answers || []).filter((a) => a.pid !== p.you.pid)[0];
      if (other) sk.emit('player:vote', { targetId: other.pid });
    }
    await wait(1500);
  }
  return seen;
}

(async () => {
  // -------------------------------------------------------------------
  log('\n[1] Every player is asked a setup question in the lobby');
  // -------------------------------------------------------------------
  const A = await room(['Dana', 'Mick', 'Jo']);
  const asks = ['Dana', 'Mick', 'Jo'].map((n) => A.st.players[n] && A.st.players[n].you.setupAsk);
  check('all three got a question', asks.every((a) => typeof a === 'string' && a.length > 5), asks.filter(Boolean).length + '/3');
  check('questions differ between players', new Set(asks).size === 3, asks.join(' | '));
  check('a hint came with it', !!(A.st.players['Dana'].you.setupHint));

  // -------------------------------------------------------------------
  log('\n[2] Answers become a prompt naming that player');
  // -------------------------------------------------------------------
  await new Promise((r) => A.socks[0].emit('player:setup', { answer: 'a pizza place' }, r));
  await new Promise((r) => A.socks[1].emit('player:setup', { answer: 'competitive yoyo' }, r));
  await new Promise((r) => A.socks[2].emit('player:setup', { answer: 'Biscuit' }, r));
  await wait(300);
  check('answer stored and echoed back', A.st.players['Dana'].you.setupA === 'a pizza place');
  check('TV shows setup progress', A.st.host.setupDone === 3, String(A.st.host.setupDone));

  const prompts = await play(A.host, A.socks, A.st);
  const named = prompts.filter((p) => /Dana|Mick|Jo/.test(p));
  check('personal prompts spread across the game', named.length === 2, named.join(' | ') || 'none');
  check('they landed in different rounds', new Set(named).size === named.length);
  const personal = named[0] || '';
  const usedDetail = ['a pizza place', 'competitive yoyo', 'Biscuit'].some((d) => personal.includes(d));
  check('it used their own supplied detail', usedDetail, personal);
  check('the personal prompt still has a blank', personal.includes('______'), personal);
  check('capitalised properly', /^[A-Z]/.test(personal), personal.slice(0, 30));

  // -------------------------------------------------------------------
  log('\n[3] Opting out protects you');
  // -------------------------------------------------------------------
  const B = await room(['Zoe', 'Pat']);
  // Zoe opts out; Pat answers.
  await new Promise((r) => B.socks[0].emit('player:setup', { allowPersonal: false, answer: '' }, r));
  await new Promise((r) => B.socks[1].emit('player:setup', { answer: 'the DMV' }, r));
  await wait(300);
  check('opt-out recorded', B.st.players['Zoe'].you.allowPersonal === false);

  let zoeHits = 0, patHits = 0;
  for (let i = 0; i < 4; i++) {
    const ps = await play(B.host, B.socks, B.st);
    ps.forEach((p) => { if (/\bZoe\b/.test(p)) zoeHits++; if (/\bPat\b/.test(p)) patHits++; });
    B.host.emit('host:restart');
    await wait(350);
  }
  check('opted-out player NEVER targeted across 4 games', zoeHits === 0, zoeHits + ' hits');
  check('opted-in player was targeted', patHits > 0, patHits + ' hits');

  // -------------------------------------------------------------------
  log('\n[4] Skipping the question still works (name-only prompt)');
  // -------------------------------------------------------------------
  const C = await room(['Sam', 'Lee']);
  await new Promise((r) => C.socks[0].emit('player:setup', { answer: '' }, r)); // skip
  await new Promise((r) => C.socks[1].emit('player:setup', { answer: '' }, r));
  await wait(250);
  check('skipping leaves them opted in', C.st.players['Sam'].you.allowPersonal !== false);
  const cp = await play(C.host, C.socks, C.st);
  const cNamed = cp.filter((p) => /\bSam\b|\bLee\b/.test(p));
  check('still got personal prompts from names alone', cNamed.length >= 1, cNamed.join(' | ') || 'none');
  // With nobody supplying a detail, every personal prompt must come from the
  // name-only set — no dangling "{A}" gaps where an answer would have gone.
  check('name-only prompts are complete', cNamed.every((p) => p.includes('______') && !/\{A\}|\s{2,}/.test(p)),
    cNamed.join(' | '));

  // -------------------------------------------------------------------
  log('\n[5] Host can switch personal prompts off entirely');
  // -------------------------------------------------------------------
  const D = await room(['Rex', 'Ivy']);
  await new Promise((r) => D.socks[0].emit('player:setup', { answer: 'a bowling alley' }, r));
  await wait(200);
  D.host.emit('host:personal', { on: false });
  await wait(250);
  check('toggle reflected in state', D.st.host.personalOn === false);
  let hits = 0;
  for (let i = 0; i < 3; i++) {
    const ps = await play(D.host, D.socks, D.st);
    ps.forEach((p) => { if (/\bRex\b|\bIvy\b/.test(p)) hits++; });
    D.host.emit('host:restart');
    await wait(300);
  }
  check('no personal prompts while switched off', hits === 0, hits + ' hits');

  log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
