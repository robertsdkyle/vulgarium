// Protocol, privacy and permission tests. Run via `npm test`.
const { wait, createRoom, lookup, connect, setupRoom, act, makeChecker } = require('./client');
const { check, done } = makeChecker();
const log = console.log;

async function toPhase(R, phase) {
  for (let i = 0; i < 20 && R.host.room.phase !== phase && R.host.room.phase !== 'SCORES'; i++) {
    const before = R.host.entities.room.version;
    const ph = R.host.room.phase;
    if (ph === 'PICKING' || ph === 'WRITING' || ph === 'VOTING') {
      for (const p of R.players) await act(p);
    } else {
      await R.host.send('host/skip');
    }
    await R.host.waitFor((h) => h.entities.room.version > before, 6000).catch(() => {});
  }
}

(async () => {
  // ---------------------------------------------------------------------
  log('\n[1] Room lookup before connecting');
  // ---------------------------------------------------------------------
  let lk = await lookup('QQQQ');
  check('unknown code -> 404, exists:false', lk.status === 404 && lk.body.exists === false);
  const R = await setupRoom(['Ann', 'Bo', 'Cy'], { audience: 1 });
  lk = await lookup(R.code.toLowerCase());
  check('known code (any case) -> exists', lk.status === 200 && lk.body.exists === true);
  check('says which game', lk.body.game === 'party-box' && lk.body.title === 'Party Box');
  check('joinable in the lobby', lk.body.joinable === true && lk.body.inProgress === false && lk.body.full === false);
  check('counts players', lk.body.players === 3 && lk.body.maxPlayers === 10, lk.body.players);
  check('no seat info without a user-id', lk.body.seat === undefined);

  // ---------------------------------------------------------------------
  log('\n[2] Welcome is a full snapshot');
  // ---------------------------------------------------------------------
  const [ann, bo, cy] = R.players;
  const w = ann.welcome;
  check('welcome is the first frame, seq 1', ann.frames[0].opcode === 'welcome' && ann.frames[0].seq === 1);
  check('has my id, name, role', typeof w.id === 'number' && w.name === 'Ann' && w.role === 'player');
  check('has game type for loading the controller', w.game === 'party-box');
  check('"here" lists the TV and players with roles',
    w.here.some((x) => x.role === 'host') && w.here.filter((x) => x.role === 'player').length >= 1);
  check('has the room entity and my own entity', !!w.entities.room && !!w.entities['player:' + ann.userId]);
  check('has serverNow for clock offset', Math.abs(w.serverNow - Date.now()) < 5000);
  check('Cy (joined last) sees all three players in here', cy.welcome.here.filter((x) => x.role === 'player').length === 3);
  check('players are not sent audience members in here', !cy.welcome.here.some((x) => x.role === 'audience'));
  check('the TV is', R.host.room && (await R.host.send('resync')) && R.host.welcome.here.some((x) => x.role === 'audience'));

  // ---------------------------------------------------------------------
  log('\n[3] Permissions: VIP');
  // ---------------------------------------------------------------------
  check('first player is VIP', ann.me.isVIP === true && bo.me.isVIP === false);
  check('VIP can start, others cannot', ann.me.permissions.canStartGame === true && bo.me.permissions.canStartGame === false);
  let r = await bo.send('lobby/start');
  check('non-VIP start refused', r.ok === false && r.error === 'not-vip', r.error);
  r = await R.audience[0].send('lobby/start');
  check('audience start refused', r.ok === false);
  // Personal rounds skip picking; switch them off so every round is picked.
  await R.host.send('host/personal', { on: false });
  r = await ann.send('lobby/start');
  check('VIP starts the game from the phone', r.ok === true);
  await R.host.waitFor((h) => h.room.phase !== 'LOBBY');
  lk = await lookup(R.code);
  check('lookup now says in progress, not joinable', lk.body.inProgress === true && lk.body.joinable === false);

  // ---------------------------------------------------------------------
  log('\n[4] Picking: only the picker gets controls');
  // ---------------------------------------------------------------------
  await R.host.waitFor((h) => h.room.phase === 'PICKING' || h.room.phase === 'WRITING');
  if (R.host.room.phase === 'PICKING') {
    const pickers = R.players.filter((p) => p.me.permissions.canPick);
    check('exactly one player may pick', pickers.length === 1, pickers.length);
    const picker = pickers[0];
    const other = R.players.find((p) => p !== picker);
    check('room says who is picking', R.host.room.pick.pickerName === picker.welcome.name);
    check('choices are offered with disabled flags', R.host.room.pick.choices.every((c) => typeof c.disabled === 'boolean'));
    r = await other.send('pick/choose', { id: R.host.room.pick.choices[0].id });
    check('non-picker pick refused', r.ok === false && r.error === 'not-your-pick', r.error);
    const choice = R.host.room.pick.choices.find((c) => !c.disabled);
    r = await picker.send('pick/choose', { id: choice.id });
    check('picker pick accepted', r.ok);
    await R.host.waitFor((h) => h.room.phase === 'WRITING');
    check('round uses the picked category', R.host.room.category === choice.label, R.host.room.category);
  } else {
    check('round 1 is a picking round', false, R.host.room.phase);
  }

  // ---------------------------------------------------------------------
  log('\n[5] Writing: private seeds, auto-answer, audience locked out');
  // ---------------------------------------------------------------------
  await R.host.waitFor((h) => h.room.phase === 'WRITING');
  await ann.waitFor((c) => c.me.seeds.length > 0);
  const annSeeds = ann.me.seeds;
  r = await R.audience[0].send('write/answer', { text: 'sneaky' });
  check('audience cannot answer', r.ok === false && r.error === 'not-allowed', r.error);
  r = await bo.send('write/auto');
  check('auto-answer accepted', r.ok);
  await bo.waitFor((c) => !!c.me.answer);
  check('auto-answer came from my own hand', bo.me.answer && bo.frames.some((f) => f.opcode === 'entity' && f.payload.val.seeds && f.payload.val.seeds.includes(bo.me.answer)), bo.me.answer);
  r = await bo.send('write/answer', { text: 'second go' });
  check('cannot answer twice', r.ok === false && r.error === 'already-answered');
  await ann.send('write/answer', { text: 'ANN-ANSWER' });
  await cy.send('write/answer', { text: 'CY-ANSWER' });
  await R.host.waitFor((h) => h.room.phase === 'VOTING');

  // ---------------------------------------------------------------------
  log('\n[6] Voting: anonymous, and you never see your own answer');
  // ---------------------------------------------------------------------
  const roomV = R.host.room;
  check('room answers carry no author', roomV.answers.every((a) => a.name === undefined && a.authorId === undefined));
  const memberIds = new Set(roomV.players.map((p) => String(p.id)));
  check('answer ids are not seat ids', roomV.answers.every((a) => !memberIds.has(String(a.id))));
  await ann.waitFor((c) => c.me.choices.length > 0);
  check('my own answer is not in my choices', !ann.me.choices.some((c) => c.text === 'ANN-ANSWER'));
  check('everyone else\'s is', ann.me.choices.length === roomV.answers.length - 1);
  r = await ann.send('vote/cast', { id: ann.me.myAnswerId });
  check('voting for my own answer refused server-side', r.ok === false && r.error === 'own-answer', r.error);

  // Audience can only add to the counters, once.
  const aud = R.audience[0];
  check('audience sees the room and counters, nothing private',
    !!aud.room && !!aud.audience && Object.keys(aud.entities).every((k) => ['room', 'audience', 'audience:' + aud.userId].includes(k)),
    Object.keys(aud.entities).join(','));
  const target = roomV.answers[0].id;
  r = await aud.send('audience/vote', { id: target });
  check('audience vote accepted', r.ok);
  r = await aud.send('audience/vote', { id: target });
  check('second audience vote refused', r.ok === false && r.error === 'already-voted');
  r = await aud.send('vote/cast', { id: target });
  check('audience cannot cast a player vote', r.ok === false && r.error === 'not-allowed');
  await R.host.waitFor((h) => h.audience.counts[target] === 1);
  check('shared counter went up by one', R.host.audience.counts[target] === 1 && R.host.audience.total === 1);

  for (const p of R.players) await act(p);
  await R.host.waitFor((h) => h.room.phase === 'RESULTS');
  check('names revealed at RESULTS', R.host.room.answers.every((a) => typeof a.name === 'string'));
  check('audience votes did not change scores',
    R.host.room.players.reduce((s, p) => s + p.score, 0) === 300, R.host.room.players.map((p) => p.score).join(','));
  // Over a real network the TV's update can land before Ann's; wait for hers.
  await ann.waitFor((c) => c.me.lastRound && typeof c.me.lastRound.votes === 'number').catch(() => {});
  check('my phone gets my round result', ann.me.lastRound && typeof ann.me.lastRound.votes === 'number');

  // ---------------------------------------------------------------------
  log('\n[7] Envelope integrity: contiguous seq, monotonic versions');
  // ---------------------------------------------------------------------
  const all = [ann, bo, cy, aud, R.host];
  check('every frame is {seq, opcode, payload}', all.every((c) => c.frames.every((f) => Number.isInteger(f.seq) && typeof f.opcode === 'string' && 'payload' in f)));
  check('no seq gaps on any connection', all.every((c) => c.gaps === 0), all.map((c) => c.gaps).join(','));
  check('no stale entity versions delivered', all.every((c) => c.stale === 0));
  const versions = ann.frames.filter((f) => f.opcode === 'entity' && f.payload.key === 'room').map((f) => f.payload.version);
  check('room versions strictly increase by 1', versions.every((v, i) => i === 0 || v === versions[i - 1] + 1), versions.slice(0, 8).join(','));
  check('every update resends the whole entity', ann.frames.filter((f) => f.opcode === 'entity' && f.payload.key === 'room').every((f) => 'phase' in f.payload.val && 'players' in f.payload.val));

  // ---------------------------------------------------------------------
  log('\n[8] Privacy: nobody receives an entity that is not theirs');
  // ---------------------------------------------------------------------
  const keysSeen = (c) => new Set(c.frames.flatMap((f) =>
    f.opcode === 'entity' ? [f.payload.key] : f.opcode === 'welcome' ? Object.keys(f.payload.entities) : []));
  for (const p of R.players) {
    const ks = keysSeen(p);
    const foreign = [...ks].filter((k) => k.startsWith('player:') && k !== 'player:' + p.userId || k === 'host' || k.startsWith('audience:'));
    check(`${p.welcome.name} saw only shared + own entities`, foreign.length === 0, foreign.join(','));
  }
  const tvKeys = [...keysSeen(R.host)];
  check('TV never received a player entity', !tvKeys.some((k) => k.startsWith('player:') || k.startsWith('audience:')), tvKeys.join(','));
  const tvJson = JSON.stringify(R.host.frames);
  check('TV never saw a seed', !annSeeds.some((s) => tvJson.includes(JSON.stringify(s))));
  check("no client ever saw another player's secret", !JSON.stringify(bo.frames).includes(ann.welcome.secret));

  // ---------------------------------------------------------------------
  log('\n[9] Resync returns a fresh snapshot');
  // ---------------------------------------------------------------------
  const before = ann.frames.length;
  ann.raw({ opcode: 'resync' });
  await ann.waitFor((c) => c.frames.length > before && c.frames[c.frames.length - 1].opcode === 'welcome');
  const rw = ann.frames[ann.frames.length - 1];
  check('resync welcome has resync:true and restarts seq at 1', rw.payload.resync === true && rw.seq === 1);

  // ---------------------------------------------------------------------
  log('\n[10] Disabled choices and VIP hand-off');
  // ---------------------------------------------------------------------
  await toPhase(R, 'PICKING');
  if (R.host.room.phase === 'PICKING') {
    const dis = R.host.room.pick.choices.find((c) => c.disabled);
    check('round 2+ shows an already-played category, disabled', !!dis);
    await Promise.any(R.players.map((p) => p.waitFor((c) => c.me.permissions.canPick))).catch(() => {});
    const picker = R.players.find((p) => p.me.permissions.canPick);
    r = dis && picker ? await picker.send('pick/choose', { id: dis.id }) : { ok: null, error: 'no picker/disabled choice' };
    check('disabled choice refused', r.ok === false && r.error === 'choice-disabled', r.error);
  } else {
    check('round 2 is a picking round', false, R.host.room.phase);
  }
  const L = await setupRoom(['First', 'Second']);
  L.players[0].close();
  await wait(150);
  await L.host.send('host/start');
  await wait(100);
  await L.host.send('host/restart');  // back to lobby releases the gone seat
  await L.players[1].waitFor((c) => c.me.isVIP === true);
  check('VIP passes to the next player when the VIP leaves', L.players[1].me.isVIP === true);

  // ---------------------------------------------------------------------
  log('\n[11] Full room');
  // ---------------------------------------------------------------------
  const { code } = await createRoom();
  for (let i = 0; i < 10; i++) await connect({ code, name: 'P' + i });
  lk = await lookup(code);
  check('lookup says full', lk.body.full === true && lk.body.joinable === false);
  const eleventh = await connect({ code, name: 'P10' }).then(() => null, (e) => e);
  check('11th player refused with room-full', eleventh && eleventh.message === 'room-full',
    eleventh ? `close ${eleventh.closeCode}, error ${eleventh.message}` : 'it was let in');
  check('…with close code 4009', eleventh && eleventh.closeCode === 4009, eleventh ? eleventh.closeCode : '-');

  done();
})().catch((e) => { console.error('FAIL  crashed:', e); process.exit(1); });
