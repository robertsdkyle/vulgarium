// Reconnection, identity and seat tests. Run via `npm test` (boots its own server).
const { wait, createRoom, lookup, connect, setupRoom, act, makeChecker } = require('./client');
const { check, done } = makeChecker();
const log = console.log;

(async () => {
  // ---------------------------------------------------------------------
  log('\n[1] Player drops mid-game and reclaims their seat with the secret');
  // ---------------------------------------------------------------------
  const R = await setupRoom(['Ann', 'Bo']);
  const [ann, bo] = R.players;
  check('welcome carries a secret', typeof ann.welcome.secret === 'string' && ann.welcome.secret.length > 16);
  check('first welcome says reconnect: false', ann.welcome.reconnect === false);

  await R.host.send('host/start');
  // Get through picking/writing to voting.
  await R.host.waitFor((h) => ['PICKING', 'WRITING'].includes(h.room.phase));
  if (R.host.room.phase === 'PICKING') {
    for (const p of R.players) await act(p);
    await R.host.waitFor((h) => h.room.phase === 'WRITING');
  }
  await ann.send('write/answer', { text: 'Ann answer' });
  await bo.send('write/answer', { text: 'Bo answer' });
  await R.host.waitFor((h) => h.room.phase === 'VOTING');
  check('advanced to VOTING', R.host.room.phase === 'VOTING');

  await ann.waitFor((c) => c.me.choices.length === 1);
  const r = await ann.send('vote/cast', { id: ann.me.choices[0].id });
  check('vote accepted', r.ok);
  ann.close();
  await R.host.waitFor((h) => h.room.players.find((p) => p.name === 'Ann').connected === false);

  const annRow = R.host.room.players.find((p) => p.name === 'Ann');
  check('dropped player still holds their seat', !!annRow);
  check('TV sees them as disconnected', annRow && annRow.connected === false);
  check("dropped player's vote survived", annRow && annRow.hasVoted === true);

  const ann2 = await connect({ code: R.code, name: 'ignored', userId: ann.userId, secret: ann.welcome.secret });
  check('reconnect welcome says reconnect: true', ann2.welcome.reconnect === true);
  check('same seat id restored', ann2.welcome.id === ann.welcome.id);
  check('same name restored (URL name ignored)', ann2.welcome.name === 'Ann');
  check('welcome already holds the current phase', ann2.room.phase === 'VOTING');
  check('welcome already holds my private entity, vote included', ann2.me && !!ann2.me.votedFor);
  await R.host.waitFor((h) => h.room.players.find((p) => p.name === 'Ann').connected === true);
  check('TV sees them connected again', true);

  await R.host.waitFor((h) => h.room.phase === 'RESULTS', 8000);
  const boRow = R.host.room.players.find((p) => p.name === 'Bo');
  check("Bo scored from the dropped player's vote", boRow.score >= 100, boRow.score);

  // ---------------------------------------------------------------------
  log('\n[2] Bad reconnects are refused');
  // ---------------------------------------------------------------------
  const tryConnect = (o) => connect(o).then((c) => ({ ok: true, c }), (e) => ({ ok: false, code: e.closeCode, err: e.message }));
  let res = await tryConnect({ code: R.code, userId: ann.userId, secret: 'nope' });
  check('wrong secret refused', !res.ok && res.code === 4003, res.code);
  res = await tryConnect({ code: R.code, userId: ann.userId });
  check('missing secret refused for an existing seat', !res.ok && res.code === 4003, res.code);
  res = await tryConnect({ code: 'ZZZZ', userId: ann.userId, secret: ann.welcome.secret });
  check('unknown room refused', !res.ok && res.code === 4004, res.code);
  res = await tryConnect({ code: R.code, userId: 'x', name: 'Bad' });
  check('malformed user-id refused', !res.ok && res.code === 4022, res.code);
  res = await tryConnect({ code: R.code, name: 'Late' });
  check('new player refused mid-game', !res.ok && res.code === 4009 && res.err === 'in-progress', `${res.code} ${res.err}`);
  res = await tryConnect({ code: R.code, role: 'audience', name: 'Late' });
  check('…but can join the audience mid-game', res.ok && res.c.welcome.role === 'audience');

  // ---------------------------------------------------------------------
  log('\n[3] The same seat opened twice: newest wins, oldest is told why');
  // ---------------------------------------------------------------------
  const ann3 = await connect({ code: R.code, userId: ann.userId, secret: ann.welcome.secret });
  await ann2.waitFor((c) => c.closeCode !== null);
  check('old connection closed with "replaced"', ann2.closeCode === 4001 && ann2.error && ann2.error.code === 'replaced', ann2.closeCode);
  check('new connection is live', ann3.room && ann3.welcome.reconnect === true);
  const okNow = await ann3.send('ping');
  check('new connection works', okNow !== undefined);

  // ---------------------------------------------------------------------
  log('\n[4] TV reloads and reclaims the room');
  // ---------------------------------------------------------------------
  const roomBefore = R.code;
  R.host.close();
  await wait(300);
  const host2 = await connect({ code: roomBefore, role: 'host', secret: R.hostSecret });
  check('host reconnect accepted', host2.welcome.role === 'host' && host2.welcome.reconnect === true);
  check('same room, players still there', host2.room.players.length >= 2);
  res = await tryConnect({ code: roomBefore, role: 'host', secret: 'wrong' });
  check('wrong host secret refused', !res.ok && res.code === 4003, res.code);

  // ---------------------------------------------------------------------
  log('\n[5] TV drop does NOT destroy the room immediately');
  // ---------------------------------------------------------------------
  host2.close();
  await wait(1200);
  check('room survives a brief TV drop', bo.closeCode === null);
  const look = await lookup(roomBefore);
  check('room lookup still finds it', look.status === 200 && look.body.exists === true);

  // ---------------------------------------------------------------------
  log('\n[6] Refreshing in the lobby keeps your seat');
  // ---------------------------------------------------------------------
  const L = await setupRoom(['Cat', 'Dee']);
  const cat = L.players[0];
  cat.close();
  await L.host.waitFor((h) => h.room.players.find((p) => p.name === 'Cat').connected === false);
  check('lobby seat held while disconnected', L.host.room.players.length === 2);
  const lk = await lookup(L.code, cat.userId);
  check('lookup with user-id reports the held seat', lk.body.seat && lk.body.seat.name === 'Cat');
  const cat2 = await connect({ code: L.code, userId: cat.userId, secret: cat.welcome.secret });
  check('lobby reconnect restores the same seat', cat2.welcome.id === cat.welcome.id && cat2.welcome.reconnect === true);
  check('…and the setup question', !!(cat2.me.setup && cat2.me.setup.ask));
  check('VIP status survives a lobby refresh', cat2.me.isVIP === true);

  // ---------------------------------------------------------------------
  log('\n[7] Duplicate names get a suffix');
  // ---------------------------------------------------------------------
  const { code } = await createRoom();
  const names = [];
  for (const n of ['MIKE', 'mike', 'MIKE', 'Mike ', 'ABCDEFGHIJKLMN', 'abcdefghijklmn']) {
    const c = await connect({ code, name: n });
    names.push(c.welcome.name);
  }
  check('first MIKE keeps the name', names[0] === 'MIKE', names[0]);
  check('case-insensitive clash -> mike2', names[1] === 'mike2', names[1]);
  check('third MIKE -> MIKE3', names[2] === 'MIKE3', names[2]);
  check('trimmed "Mike " -> Mike4', names[3] === 'Mike4', names[3]);
  check('long names stay within 14 chars', names[5] === 'abcdefghijklm2' && names[5].length === 14, names[5]);

  // ---------------------------------------------------------------------
  log('\n[8] A player who drops briefly still holds the round');
  // ---------------------------------------------------------------------
  // Runs with DROP_HOLD=2 (seconds) from run-tests.js.
  const H = await setupRoom(['Hal', 'Ivy']);
  const [hal, ivy] = H.players;
  await H.host.send('host/personal', { on: false });
  await H.host.send('host/start');
  await H.host.waitFor((h) => h.room.phase === 'PICKING');
  await H.host.send('host/skip');
  await H.host.waitFor((h) => h.room.phase === 'WRITING');
  hal.close(); // screen lock mid-write
  await H.host.waitFor((h) => h.room.players.find((p) => p.name === 'Hal').connected === false);
  await ivy.send('write/answer', { text: 'Ivy answer' });
  await wait(600);
  check('round does NOT skip ahead while Hal is briefly away', H.host.room.phase === 'WRITING', H.host.room.phase);
  const hal2 = await connect({ code: H.code, userId: hal.userId, secret: hal.welcome.secret });
  await hal2.send('write/answer', { text: 'Hal answer' });
  await H.host.waitFor((h) => h.room.phase !== 'WRITING');
  check('once Hal is back and answers, it goes to VOTING (not results)', H.host.room.phase === 'VOTING', H.host.room.phase);

  hal2.close();
  await H.host.waitFor((h) => h.room.players.find((p) => p.name === 'Hal').connected === false);
  await ivy.waitFor((c) => c.me.choices.length > 0);
  await ivy.send('vote/cast', { id: ivy.me.choices[0].id });
  await wait(600);
  check('still waiting on Hal inside the hold window', H.host.room.phase === 'VOTING', H.host.room.phase);
  await H.host.waitFor((h) => h.room.phase === 'RESULTS', 3500).catch(() => {});
  check('after the hold runs out, the room moves on without him', H.host.room.phase === 'RESULTS', H.host.room.phase);

  done();
})().catch((e) => { console.error('FAIL  crashed:', e); process.exit(1); });
