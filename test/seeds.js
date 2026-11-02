// Seed-dealing tests: private hands, distinct, refreshed each round.
const { wait, setupRoom, act, makeChecker } = require('./client');
const { check, done } = makeChecker();
const log = console.log;

// Only the picker acts: anyone else calling act() after the pick lands would
// submit an answer and lose their hand.
async function pickNow(R) {
  await Promise.all(R.players.map((p) => p.waitFor((c) => c.room.phase === 'PICKING')));
  const picker = R.players.find((p) => p.me.permissions.canPick);
  await act(picker);
}

(async () => {
  const R = await setupRoom(['Ann', 'Bo', 'Cy']);
  const [ann] = R.players;
  await R.host.send('host/personal', { on: false });

  log('\n[1] Seeds are dealt during WRITING');
  await R.host.send('host/start');
  await R.host.waitFor((h) => h.room.phase === 'PICKING');
  await pickNow(R);
  await R.host.waitFor((h) => h.room.phase === 'WRITING');
  await Promise.all(R.players.map((p) => p.waitFor((c) => c.me.seeds.length > 0)));
  const hands = R.players.map((p) => p.me.seeds);
  check('every player got seeds', hands.every((h) => h.length > 0), JSON.stringify(hands.map((h) => h.length)));
  check('hands are the configured size', hands.every((h) => h.length === 5));
  check('seeds are short strings', hands.flat().every((w) => typeof w === 'string' && w.length < 45));

  log('\n[2] Hands are PRIVATE');
  const anySeed = hands.flat()[0];
  check('TV received no seed text', !JSON.stringify(R.host.frames).includes(JSON.stringify(anySeed)), 'leaked: ' + anySeed);
  check('room entity carries no seeds', !JSON.stringify(R.host.room).includes('seeds'));
  check("one player's frames hold no other player's seeds", !hands[1].some((w) => JSON.stringify(ann.frames).includes(JSON.stringify(w))));

  log('\n[3] No two players share a seed this round');
  const all = hands.flat();
  check('all dealt seeds are distinct', all.length === new Set(all).size, `${all.length} dealt, ${new Set(all).size} unique`);

  log('\n[4] Seeds refresh each round');
  const round1 = new Set(ann.me.seeds);
  for (const p of R.players) await p.send('write/answer', { text: p.welcome.name + ' r1' });
  await R.host.waitFor((h) => h.room.phase === 'VOTING');
  await Promise.all(R.players.map((p) => p.waitFor((c) => c.me.choices.length > 0)));
  for (const p of R.players) await act(p);
  await R.host.waitFor((h) => h.room.round === 2 && h.room.phase === 'PICKING', 6000);
  await pickNow(R);
  await R.host.waitFor((h) => h.room.phase === 'WRITING');
  await ann.waitFor((c) => c.me.seeds.length > 0);
  const round2 = ann.me.seeds;
  check('got a fresh hand in round 2', round2.length === 5);
  const overlap = round2.filter((w) => round1.has(w));
  check('round 2 hand differs from round 1', overlap.length < 5, `overlap=${overlap.length}`);

  log('\n[5] Seeds are absent once you have answered, and while voting');
  await ann.send('write/answer', { text: 'done' });
  await ann.waitFor((c) => c.me.answer === 'done');
  check('no seeds after answering', ann.me.seeds.length === 0);
  for (const p of R.players.slice(1)) await p.send('write/answer', { text: 'x' });
  await R.host.waitFor((h) => h.room.phase === 'VOTING');
  await wait(100);
  check('no seeds while voting', R.players.every((p) => p.me.seeds.length === 0));

  done();
})().catch((e) => { console.error('FAIL  crashed:', e); process.exit(1); });
