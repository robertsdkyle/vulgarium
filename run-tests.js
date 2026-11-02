/**
 * Runs every test suite. Boots its own server with short timers, runs each
 * suite against it, and reports. Nothing to set up:
 *
 *   npm test
 *
 * Suites speak the WebSocket protocol through test/client.js.
 *
 * Each suite gets a fresh server so one suite's leftover rooms or used-prompt
 * history can't influence the next.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FAST = { T_PICKING: '3', T_WRITING: '4', T_VOTING: '4', T_RESULTS: '1', DROP_HOLD: '2' };
const SUITES = [
  { file: 'test/protocol.js',  label: 'protocol & privacy', env: FAST },
  { file: 'test/reconnect.js', label: 'reconnection',       env: FAST },
  { file: 'test/seeds.js',     label: 'answer seeds',       env: FAST },
  { file: 'test/dealer.js',    label: 'prompt dealing',     env: FAST },
  { file: 'test/personal.js',  label: 'personal prompts',   env: FAST },
];

const USED = path.join(__dirname, '.used-prompts.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(env) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, ...env, PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  srv.getLog = () => log;
  return srv;
}

function runSuite(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  let failed = 0;
  const summary = [];

  for (const suite of SUITES) {
    try { fs.unlinkSync(USED); } catch (_) {}
    const srv = startServer(suite.env);
    await wait(1200);

    const { code, out } = await runSuite(suite.file);
    srv.kill();
    await wait(300);

    const line = (out.match(/^\d+ passed, \d+ failed$/m) || [])[0] || 'no result';
    const ok = code === 0;
    if (!ok) failed++;
    summary.push({ label: suite.label, ok, line });

    console.log(`\n${ok ? '✓' : '✗'}  ${suite.label}  —  ${line}`);
    if (!ok) {
      console.log(out.split('\n').filter((l) => /FAIL|Error/.test(l)).join('\n'));
      const serverLog = srv.getLog();
      if (/Error/i.test(serverLog)) console.log('server log:\n' + serverLog);
    }
  }

  try { fs.unlinkSync(USED); } catch (_) {}

  console.log('\n' + '─'.repeat(46));
  for (const s of summary) console.log(`  ${s.ok ? '✓' : '✗'}  ${s.label.padEnd(22)} ${s.line}`);
  console.log('─'.repeat(46));
  console.log(failed ? `\n${failed} suite(s) failed\n` : '\nAll suites passed\n');
  process.exit(failed ? 1 : 0);
})();
