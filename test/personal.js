// Personal prompt tests.
const { setupRoom, playGame, makeChecker } = require('./client');
const { check, done } = makeChecker();
const log = console.log;

(async () => {
  log('\n[1] Every player is asked a setup question in the lobby');
  const A = await setupRoom(['Dana', 'Mick', 'Jo']);
  const asks = A.players.map((p) => p.me.setup && p.me.setup.ask);
  check('all three got a question', asks.every((a) => typeof a === 'string' && a.length > 5));
  check('questions differ between players', new Set(asks).size === 3, asks.join(' | '));
  check('a hint came with it', !!A.players[0].me.setup.hint);

  log('\n[2] Answers become a prompt naming that player');
  await A.players[0].send('lobby/setup', { answer: 'a pizza place' });
  await A.players[1].send('lobby/setup', { answer: 'competitive yoyo' });
  await A.players[2].send('lobby/setup', { answer: 'Biscuit' });
  await A.host.waitFor((h) => h.room.lobby.setupDone === 3);
  check('answer stored and echoed back', A.players[0].me.setup.answer === 'a pizza place');
  check('TV shows setup progress', A.host.room.lobby.setupDone === 3);

  const prompts = await playGame(A.host, A.players);
  const named = prompts.filter((p) => /Dana|Mick|Jo/.test(p));
  check('one or two personal prompts this game', named.length >= 1 && named.length <= 2, named.join(' | ') || 'none');
  check('they landed in different rounds', new Set(named).size === named.length);
  const personal = named[0] || '';
  check('it used their own supplied detail', ['a pizza place', 'competitive yoyo', 'Biscuit'].some((d) => personal.includes(d)), personal);
  check('the personal prompt still has a blank', personal.includes('______'), personal);
  check('capitalised properly', /^[A-Z]/.test(personal), personal.slice(0, 30));

  log('\n[2b] Which rounds are personal is random, and rarely round 1');
  const { pickPersonalRounds } = require('../games/party-box/schedule');
  const N = 20000;
  let r1 = 0, sizes = new Set(), byRound = [0, 0, 0, 0], bad = 0;
  for (let i = 0; i < N; i++) {
    const set = pickPersonalRounds({ rounds: 3, max: 2, eligible: 5 });
    sizes.add(set.size);
    if (set.size < 1 || set.size > 2) bad++;
    for (const r of set) byRound[r]++;
    if (set.has(1)) r1++;
  }
  check('always 1 or 2 personal rounds', bad === 0 && sizes.has(1) && sizes.has(2), [...sizes].join(','));
  check('round 1 is personal in well under half of games', r1 / N < 0.3, (100 * r1 / N).toFixed(1) + '%');
  check('every round can be personal', byRound.slice(1).every((n) => n > 0), byRound.slice(1).join('/'));
  check('later rounds are favoured', byRound[3] > byRound[2] && byRound[2] > byRound[1], byRound.slice(1).join('/'));
  check('capped by eligible players', [...Array(2000)].every(() => pickPersonalRounds({ rounds: 3, max: 2, eligible: 1 }).size === 1));
  check('nobody eligible -> none', pickPersonalRounds({ rounds: 3, max: 2, eligible: 0 }).size === 0);

  log('\n[3] Opting out protects you');
  const B = await setupRoom(['Zoe', 'Pat']);
  await B.players[0].send('lobby/setup', { allowPersonal: false, answer: '' });
  await B.players[1].send('lobby/setup', { answer: 'the DMV' });
  await B.players[0].waitFor((c) => c.me.setup.allowPersonal === false);
  check('opt-out recorded', B.players[0].me.setup.allowPersonal === false);
  let zoe = 0, pat = 0;
  for (let i = 0; i < 4; i++) {
    (await playGame(B.host, B.players)).forEach((p) => { if (/\bZoe\b/.test(p)) zoe++; if (/\bPat\b/.test(p)) pat++; });
    await B.host.send('host/restart');
  }
  check('opted-out player NEVER targeted across 4 games', zoe === 0, zoe + ' hits');
  check('opted-in player was targeted', pat > 0, pat + ' hits');

  log('\n[4] Skipping the question still works (name-only prompt)');
  const C = await setupRoom(['Sam', 'Lee']);
  await C.players[0].send('lobby/setup', { answer: '' });
  await C.players[1].send('lobby/setup', { answer: '' });
  check('skipping leaves them opted in', C.players[0].me.setup.allowPersonal !== false);
  const cNamed = (await playGame(C.host, C.players)).filter((p) => /\bSam\b|\bLee\b/.test(p));
  check('still got personal prompts from names alone', cNamed.length >= 1, cNamed.join(' | ') || 'none');
  check('name-only prompts are complete', cNamed.every((p) => p.includes('______') && !/\{A\}|\s{2,}/.test(p)), cNamed.join(' | '));

  log('\n[5] Host can switch personal prompts off entirely');
  const D = await setupRoom(['Rex', 'Ivy']);
  await D.players[0].send('lobby/setup', { answer: 'a bowling alley' });
  await D.host.send('host/personal', { on: false });
  await D.host.waitFor((h) => h.room.lobby.personalOn === false);
  check('toggle reflected in state', D.host.room.lobby.personalOn === false && D.host.host.personalOn === false);
  let hits = 0;
  for (let i = 0; i < 3; i++) {
    (await playGame(D.host, D.players)).forEach((p) => { if (/\bRex\b|\bIvy\b/.test(p)) hits++; });
    await D.host.send('host/restart');
  }
  check('no personal prompts while switched off', hits === 0, hits + ' hits');

  done();
})().catch((e) => { console.error('FAIL  crashed:', e); process.exit(1); });
