// Reconnection tests. Run the server first (short timers recommended):
//   T_WRITING=4 T_VOTING=4 T_RESULTS=1 node server.js
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = console.log;
let pass = 0, fail = 0;
const check = (label, cond) => { (cond ? pass++ : fail++); log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

(async () => {
  // ---------------------------------------------------------------------
  log('\n[1] Player drops mid-game and reclaims their seat');
  // ---------------------------------------------------------------------
  let code = null, hostToken = null;
  const host = io(URL);
  let hostState = null;
  host.on('state', (s) => { hostState = s; });
  await new Promise((r) => host.emit('host:create', { origin: 'http://x:3000' }, (res) => {
    code = res.code; hostToken = res.hostToken; r();
  }));

  // Two players join.
  const a = io(URL), b = io(URL);
  let aSeat = null, bSeat = null, aState = null;
  a.on('state', (s) => { aState = s; });
  await new Promise((r) => a.emit('player:join', { code, name: 'Ann' }, (res) => { aSeat = res; r(); }));
  await new Promise((r) => b.emit('player:join', { code, name: 'Bo' }, (res) => { bSeat = res; r(); }));
  check('join returns a pid token', !!aSeat.pid && aSeat.pid.length > 10);

  host.emit('host:start');
  await wait(300);
  check('game started (WRITING)', hostState.phase === 'WRITING');

  // Both answer, so we advance to VOTING and everyone has a score stake.
  a.emit('player:answer', { text: 'Ann answer' });
  b.emit('player:answer', { text: 'Bo answer' });
  await wait(300);
  check('advanced to VOTING', hostState.phase === 'VOTING');

  // Ann votes for Bo, then Ann's phone "dies".
  const bAnswer = hostState.answers.find((x) => x.pid === bSeat.pid);
  a.emit('player:vote', { targetId: bAnswer.pid });
  await wait(200);
  a.disconnect();
  await wait(400);

  const annAfterDrop = hostState.players.find((p) => p.pid === aSeat.pid);
  check('dropped player still holds their seat', !!annAfterDrop);
  check('dropped player shown as disconnected', annAfterDrop && annAfterDrop.connected === false);
  check("dropped player's vote survived", annAfterDrop && annAfterDrop.hasVoted === true);

  // Ann's phone comes back with a NEW socket but the SAME pid.
  const a2 = io(URL);
  let a2State = null;
  a2.on('state', (s) => { a2State = s; });
  let resumeRes = null;
  await new Promise((r) => a2.emit('player:resume', { code, pid: aSeat.pid }, (res) => { resumeRes = res; r(); }));
  await wait(300);
  check('resume accepted', resumeRes && resumeRes.ok === true);
  check('same name restored', resumeRes && resumeRes.name === 'Ann');
  const annBack = hostState.players.find((p) => p.pid === aSeat.pid);
  check('marked connected again', annBack && annBack.connected === true);
  check('vote still registered after reconnect', annBack && annBack.hasVoted === true);
  check('player sees game state immediately', a2State && a2State.you.pid === aSeat.pid);

  // Let the round resolve and confirm score survived the whole ordeal.
  await wait(4500);
  const bo = hostState.players.find((p) => p.pid === bSeat.pid);
  check("Bo scored from the dropped player's vote", bo && bo.score >= 100);

  // ---------------------------------------------------------------------
  log('\n[2] Bad resume attempts are rejected');
  // ---------------------------------------------------------------------
  const imposter = io(URL);
  let badRes = null;
  await new Promise((r) => imposter.emit('player:resume', { code, pid: 'not-a-real-pid' }, (res) => { badRes = res; r(); }));
  check('unknown pid rejected', badRes && badRes.ok === false);
  await new Promise((r) => imposter.emit('player:resume', { code: 'ZZZZ', pid: aSeat.pid }, (res) => { badRes = res; r(); }));
  check('unknown room rejected', badRes && badRes.ok === false);

  // ---------------------------------------------------------------------
  log('\n[3] Host reloads the TV and reclaims the room');
  // ---------------------------------------------------------------------
  const roomBefore = hostState.code;
  host.disconnect();
  await wait(500);
  const host2 = io(URL);
  let host2State = null;
  host2.on('state', (s) => { host2State = s; });
  let hres = null;
  await new Promise((r) => host2.emit('host:resume', { code: roomBefore, hostToken }, (res) => { hres = res; r(); }));
  await wait(300);
  check('host resume accepted', hres && hres.ok === true);
  check('same room reclaimed (not a new one)', host2State && host2State.code === roomBefore);
  check('players still in the room', host2State && host2State.players.length >= 2);

  let wrongHost = null;
  const fakeHost = io(URL);
  await new Promise((r) => fakeHost.emit('host:resume', { code: roomBefore, hostToken: 'wrong' }, (res) => { wrongHost = res; r(); }));
  check('wrong host token rejected', wrongHost && wrongHost.ok === false);

  // ---------------------------------------------------------------------
  log('\n[4] Host drop does NOT destroy the room immediately');
  // ---------------------------------------------------------------------
  let closed = false;
  b.on('room:closed', () => { closed = true; });
  host2.disconnect();
  await wait(1500);
  check('room survives a brief host drop', closed === false);

  log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
