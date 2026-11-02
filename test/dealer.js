// Dealer tests: topic blend, freshness across games, prompt swapping.
const { setupRoom, playGame, makeChecker } = require('./client');
const { check, done } = makeChecker();
const log = console.log;

const GROUPS = require('../prompts').GROUPS;
const templated = require('../templates').expand();
function groupOf(text) {
  for (const [g, items] of Object.entries(GROUPS)) if (items.includes(text)) return g;
  const t = templated.find((p) => p.text === text);
  return t ? t.group : 'UNKNOWN';
}

(async () => {
  const R = await setupRoom(['Ann', 'Bo', 'Cy']);
  // Personal prompts belong to no category by design — test the dealer alone.
  await R.host.send('host/personal', { on: false });

  log('\n[1] One game spans three different topics');
  const g1 = await playGame(R.host, R.players);
  check('collected 3 prompts', g1.length === 3, g1.length);
  const cats1 = g1.map(groupOf);
  check('all 3 prompts identified', !cats1.includes('UNKNOWN'), cats1.join(', '));
  check('all 3 categories are DIFFERENT', new Set(cats1).size === 3, cats1.join(' / '));

  log('\n[2] A second game brings fresh prompts');
  await R.host.send('host/restart');
  const g2 = await playGame(R.host, R.players);
  check('second game dealt 3 prompts', g2.length === 3);
  const overlap = g2.filter((p) => g1.includes(p));
  check('no prompt repeated from game 1', overlap.length === 0, overlap.join(' | '));
  check('second game also spans 3 categories', new Set(g2.map(groupOf)).size === 3);

  log('\n[3] Repeated games keep drawing fresh material');
  const seen = new Set([...g1, ...g2]);
  let repeats = 0;
  for (let i = 0; i < 4; i++) {
    await R.host.send('host/restart');
    for (const p of await playGame(R.host, R.players)) { if (seen.has(p)) repeats++; seen.add(p); }
  }
  check('six games produced no repeated prompt', repeats === 0, repeats + ' repeats');
  check('18 distinct prompts seen', seen.size === 18, seen.size);

  log('\n[4] Host can swap a prompt nobody has answered yet');
  await R.host.send('host/restart');
  await R.host.send('host/start');
  await R.host.waitFor((h) => h.room.phase === 'PICKING');
  await R.host.send('host/skip'); // let the server pick the category
  await R.host.waitFor((h) => h.room.phase === 'WRITING');
  const before = R.host.room.prompt;
  const cat = R.host.room.category;
  check('TV says swap is available', R.host.host.canSwap === true);
  const r = await R.host.send('host/swap');
  check('swap accepted', r.ok);
  await R.host.waitFor((h) => h.room.prompt !== before);
  check('prompt changed after swap', R.host.room.prompt !== before);
  check('swap stays in the picked category', groupOf(R.host.room.prompt) === cat, `${cat} -> ${groupOf(R.host.room.prompt)}`);
  check('still in WRITING with a fresh timer', R.host.room.phase === 'WRITING' && R.host.room.deadline > Date.now());

  await R.players[0].send('write/answer', { text: 'committed' });
  await R.host.waitFor((h) => h.host.canSwap === false);
  const locked = R.host.room.prompt;
  const r2 = await R.host.send('host/swap');
  check('swap refused after someone answered', r2.ok === false && R.host.room.prompt === locked);

  done();
})().catch((e) => { console.error('FAIL  crashed:', e); process.exit(1); });
