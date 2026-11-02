/**
 * End-to-end browser run: one TV, four phones, one audience member, each in
 * its own browser context (so each is a separate "device" with its own
 * localStorage and user-id — plain tabs would share one).
 *
 * Exercises: room lookup, duplicate names, VIP start, picking, auto-answer,
 * audience voting, and a refresh + one-tap RECONNECT in every phase, plus a
 * TV refresh and the "opened somewhere else" hand-off.
 *
 *   npm run test:e2e        (needs Playwright + Chromium installed)
 *
 * Screenshots land in e2e-shots/.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  console.log('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const PORT = 3200;
const URL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  (' + String(extra).slice(0, 120) + ')' : ''}`);
};
const log = console.log;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Long timers: the test drives every phase change itself.
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), T_PICKING: '90', T_WRITING: '120', T_VOTING: '120', T_RESULTS: '90', USED_FILE: path.join(SHOTS, '.used.json') },
    stdio: 'ignore',
  });
  await wait(1200);

  const browser = await chromium.launch();
  const errors = [];
  let shotN = 0;
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) });

  async function device(label, mobile = true) {
    const ctx = await browser.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
      : { viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The 404 from looking up a code that doesn't exist is the expected answer.
      if (/status of 404/.test(m.text()) && /\/rooms\//.test((m.location() || {}).url || '')) return;
      errors.push(`${label}: ${m.text()}`);
    });
    page._label = label;
    return page;
  }
  const text = async (p, sel = '#stage') => (await p.locator(sel).innerText()).replace(/\s+/g, ' ').trim();
  const until = async (p, fn, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch (_) {} await wait(100); }
    return false;
  };
  // innerText follows CSS text-transform, so compare case-insensitively.
  const stageHas = (p, s, ms) => until(p, async () => (await text(p)).toLowerCase().includes(s.toLowerCase()), ms);

  /** Reload a phone, check the TV marks it as away, then tap RECONNECT. */
  async function refresh(p, name, expect, tv) {
    await p.reload();
    const card = await until(p, async () => p.locator('#reconnect').isVisible(), 6000);
    check(`${p._label}: reload shows a one-tap RECONNECT`, card);
    if (tv) {
      const away = await until(tv, async () => (await text(tv)).includes('reconnecting') && (await text(tv)).includes(name), 4000);
      check(`TV shows ${name} as disconnected meanwhile`, away);
    }
    await shot(p, `${p._label}-reconnect-card`);
    await p.click('#reconnect');
    const ok = await stageHas(p, expect, 6000);
    check(`${p._label}: back in, showing "${expect}"`, ok, ok ? '' : await text(p));
  }

  async function join(p, code, name) {
    await p.goto(`${URL}/?c=${code}`);
    await until(p, async () => (await p.locator('#join').isEnabled()));
    if (name !== null) await p.fill('#name', name);
    await p.click('#join');
    await until(p, async () => (await p.locator('#pb-main').count()) > 0);
    await wait(250);
  }

  try {
    // ---------------------------------------------------------------
    log('\n[1] TV creates a room; phones look it up before connecting');
    // ---------------------------------------------------------------
    const tv = await device('tv', false);
    await tv.goto(`${URL}/host`);
    await tv.waitForSelector('.code-tiles span');
    const code = (await tv.locator('.code-tiles span').allTextContents()).join('');
    check('TV shows a 4-letter code', /^[A-Z]{4}$/.test(code), code);
    check('TV timer hidden in the lobby', !(await tv.locator('#timer').isVisible()));

    const A = await device('phoneA'), B = await device('phoneB'), C = await device('phoneC'), D = await device('phoneD');
    await A.goto(URL);
    await A.fill('#code', 'ZZZ');
    await A.type('#code', 'Z');
    check('unknown code: says so, Join disabled', await stageHas(A, 'No room with that code') && !(await A.locator('#join').isEnabled()));
    await A.fill('#code', '');
    await A.type('#code', code.toLowerCase());
    check('real code: shows the game name and lobby status', await stageHas(A, 'Party Box · 0/10 players · in the lobby'));
    const wsBefore = await A.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/play')).length);
    check('no websocket opened before tapping Join', wsBefore === 0);
    await shot(A, 'phoneA-lookup');
    await A.fill('#name', 'MIKE');
    await A.click('#join');
    await stageHas(A, 'One question');

    // ---------------------------------------------------------------
    log('\n[2] Duplicate names get a suffix');
    // ---------------------------------------------------------------
    await join(B, code, 'MIKE');
    const bHead = await text(B, '#me');
    check('second MIKE becomes MIKE2', bHead.includes('MIKE2'), bHead);
    await join(C, code, 'Dana');
    await join(D, code, 'Jo');
    check('TV lists all four', await until(tv, async () => (await tv.locator('.roster .chip').count()) === 4));
    check('TV shows MIKE as VIP', (await text(tv)).includes('MIKE is the VIP'));
    await shot(tv, 'tv-lobby');

    // ---------------------------------------------------------------
    log('\n[3] LOBBY: setup question, refresh, VIP');
    // ---------------------------------------------------------------
    await C.fill('#setup', 'got lost at a petting zoo');
    await C.click('#setupSend');
    check('Dana answered her question', await stageHas(C, 'Your answer: got lost at a petting zoo'));
    await D.click('#skip');
    await refresh(C, 'Dana', 'Your answer: got lost at a petting zoo', tv);
    check('only the VIP phone has a Start button', (await A.locator('#start').count()) === 1 && (await B.locator('#start').count()) === 0);
    check('non-VIP sees who will start', (await text(B)).includes('Waiting for MIKE to start'));
    await shot(A, 'phoneA-lobby-vip');
    // Personal prompts off so every round has a picker (deterministic test).
    await tv.click('#personal');
    await until(tv, async () => (await text(tv, '#controls')).includes('Personal prompts: off'));
    await A.click('#start');

    // ---------------------------------------------------------------
    log('\n[4] PICKING: only the picker gets buttons');
    // ---------------------------------------------------------------
    check('TV: MIKE is picking', await stageHas(tv, 'MIKE is picking'));
    check('picker sees category buttons', await until(A, async () => (await A.locator('.btn-choice:enabled').count()) >= 3));
    check('others see "MIKE is picking"', await stageHas(B, 'MIKE is picking') && (await B.locator('.btn-choice').count()) === 0);
    await shot(A, 'phoneA-picking');
    await shot(B, 'phoneB-picking-wait');
    await refresh(A, 'MIKE', 'Choose a category', tv);
    check('picker still has buttons after refresh', (await A.locator('.btn-choice:enabled').count()) >= 3);
    await refresh(B, 'MIKE2', 'MIKE is picking');
    const picked = (await A.locator('.btn-choice:enabled').first().innerText()).trim();
    await A.locator('.btn-choice:enabled').first().click();
    check('TV moves to WRITING with the picked category', await stageHas(tv, picked.toUpperCase()), picked);

    // ---------------------------------------------------------------
    log('\n[5] Audience joins a game in progress');
    // ---------------------------------------------------------------
    const E = await device('audience');
    await E.goto(`${URL}/?c=${code}`);
    check('lookup offers the audience', await until(E, async () => (await E.locator('#join').innerText()).includes('audience')));
    await shot(E, 'audience-lookup');
    await E.click('#join');
    check('audience sees the writing phase', await stageHas(E, 'Players are writing'));
    check('TV counts the audience', await stageHas(tv, '+1 in the audience', 3000) || (await text(tv, '#audCount')).includes('+1'));

    // ---------------------------------------------------------------
    log('\n[6] WRITING: refresh before and after answering; auto-answer; TV refresh');
    // ---------------------------------------------------------------
    const prompt = (await A.locator('.prompt-text').innerText()).trim();
    await B.fill('#ans', 'half-typed B');
    await refresh(B, 'MIKE2', prompt.slice(0, 12), tv);
    check('B still has the answer box after refresh', (await B.locator('#ans').count()) === 1);
    check("B's half-typed draft survived the refresh", (await B.inputValue('#ans')) === 'half-typed B', await B.inputValue('#ans'));
    await A.fill('#ans', 'A-ANSWER a haunted Roomba');
    await A.click('#send');
    check('A locked in', await stageHas(A, 'Answer locked in'));
    await refresh(A, 'MIKE', 'Answer locked in');
    check('A sees own answer after refresh', (await text(A)).includes('A-ANSWER'));
    await shot(C, 'phoneC-writing');
    await C.click('#auto');
    check('"Write one for me" locks Dana in', await stageHas(C, 'Answer locked in'));

    await tv.reload();
    check('TV refresh reclaims the same room mid-round', await until(tv, async () => (await text(tv)).includes(prompt.replace(/_{3,}/g, '').slice(0, 10))));
    check('TV did not make a new room', /round 1/i.test(await text(tv, '#roundLabel')) && (await tv.evaluate(() => JSON.parse(localStorage.getItem('pb.host')).code)) === code);
    await D.fill('#ans', 'D-ANSWER');
    await D.click('#send');
    await B.fill('#ans', 'B-ANSWER');
    await B.click('#send');

    // ---------------------------------------------------------------
    log('\n[7] VOTING: own answer hidden; refresh before/after voting; audience');
    // ---------------------------------------------------------------
    check('everyone answered -> VOTING', await stageHas(A, 'Pick your favorite'));
    const aOpts = await A.locator('.btn-vote').allInnerTexts();
    check("A's own answer is not in A's list", !aOpts.some((t) => t.includes('A-ANSWER')), aOpts.join(' | '));
    check('A sees the other three', aOpts.length === 3, aOpts.length);
    await shot(A, 'phoneA-voting');
    await refresh(A, 'MIKE', 'Pick your favorite', tv);
    const aOpts2 = await A.locator('.btn-vote').allInnerTexts();
    check('after refresh, still no own answer', aOpts2.length === 3 && !aOpts2.some((t) => t.includes('A-ANSWER')));
    await A.locator('.btn-vote', { hasText: 'B-ANSWER' }).click();
    check('A vote cast', await stageHas(A, 'Vote cast'));
    await refresh(A, 'MIKE', 'Vote cast');

    check('audience gets every answer to vote on', await until(E, async () => (await E.locator('.btn-vote').count()) === 4));
    await shot(E, 'audience-voting');
    await E.locator('.btn-vote', { hasText: 'D-ANSWER' }).click();
    check('audience vote counted', await stageHas(E, 'Vote counted'));
    await refresh(E, 'x', 'Vote counted');
    check('TV shows the audience tally', await until(tv, async () => (await text(tv)).includes('1 👏')));

    for (const p of [B, C, D]) {
      await p.locator('.btn-vote').first().click();
    }

    // ---------------------------------------------------------------
    log('\n[8] RESULTS');
    // ---------------------------------------------------------------
    check('TV reveals names', await until(tv, async () => (await tv.locator('.answer-row .who').count()) >= 4));
    check('TV marks the audience favorite', (await tv.locator('.answer-row.aud-fav').count()) === 1);
    await shot(tv, 'tv-results');
    await refresh(B, 'MIKE2', 'Results are up', tv);
    check('B sees their own round result', /vote|No votes/.test(await text(B)), await text(B));

    // ---------------------------------------------------------------
    log('\n[9] Round 2 picking rotates; played category is disabled');
    // ---------------------------------------------------------------
    await tv.click('#skip');
    check('TV: MIKE2 is picking round 2', await stageHas(tv, 'MIKE2 is picking'));
    check('B (MIKE2) has the buttons now', await until(B, async () => (await B.locator('.btn-choice').count()) >= 3));
    check('A is waiting', await stageHas(A, 'MIKE2 is picking'));
    check('a played category shows disabled', (await B.locator('.btn-choice:disabled').count()) === 1);
    await shot(B, 'phoneB-picking-disabled');

    // Hurry through the rest from the TV.
    for (let i = 0; i < 12 && !(await text(tv)).includes(' wins'); i++) {
      if (await tv.locator('#skip').count()) await tv.click('#skip');
      await wait(350);
    }

    // ---------------------------------------------------------------
    log('\n[10] SCORES');
    // ---------------------------------------------------------------
    check('TV shows the winner', await stageHas(tv, ' wins'));
    await shot(tv, 'tv-scores');
    await refresh(C, 'Dana', 'You', null);
    check('Dana sees her placing after refresh', /You (won|finished)/.test(await text(C)), await text(C));
    check('VIP can start another game', await until(A, async () => (await A.locator('#again').count()) === 1));

    // ---------------------------------------------------------------
    log('\n[11] Same seat opened in a second tab: newest wins');
    // ---------------------------------------------------------------
    const D2 = await D.context().newPage();
    D2._label = 'phoneD-tab2';
    await D2.goto(URL);
    await D2.waitForSelector('#reconnect');
    await D2.click('#reconnect');
    check('first tab is told it moved', await stageHas(D, 'Open somewhere else'));
    await shot(D, 'phoneD-replaced');
    await D.click('#here');
    check('"Use this screen" takes it back', await stageHas(D2, 'Open somewhere else'));

    await A.click('#again');
    check('VIP "Play again" returns everyone to the lobby', await stageHas(C, "You're in") && await stageHas(tv, 'ENTER THE CODE'));

    // ---------------------------------------------------------------
    log('\n[12] App-like phone');
    // ---------------------------------------------------------------
    const manifest = await (await fetch(`${URL}/manifest.webmanifest`)).json();
    check('manifest is standalone with icons', manifest.display === 'standalone' && manifest.icons.length >= 3);
    const vp = await A.locator('meta[name=viewport]').getAttribute('content');
    check('no pinch zoom', /user-scalable=no/.test(vp) && /maximum-scale=1/.test(vp));
    const small = await A.evaluate(() => [...document.querySelectorAll('#stage button')]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()));
    check('every visible button is a big tap target', small.length === 0, small.join(','));

    check('no page errors in any browser', errors.length === 0, errors.join(' || '));
  } catch (e) {
    console.error('FAIL  crashed:', e);
    fail++;
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed\n(screenshots in ${path.relative(process.cwd(), SHOTS)}/)\n`);
  process.exit(fail ? 1 : 0);
})();
