/**
 * PARTY BOX — server entry point
 *
 *   /            the phone controller (a thin shell; game UI loads on demand)
 *   /host        the TV
 *   /rooms…      room lookup, room creation, and the WebSocket (server/core.js)
 *   /healthz     for your host's health check
 *
 * Game logic stays here on the server — the TV and phones only render the
 * entities they're sent. See server/core.js for the protocol and
 * games/party-box/logic.js for the game itself.
 */

const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { createCore } = require('./server/core');
const games = require('./games');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));
// HTML is never cached so a deploy reaches phones on the next load; the
// service worker (public/sw.js) handles offline-ish shell caching itself.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/\.(html|js|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

/**
 * Find the address phones should actually use.
 *
 * The naive version — first non-internal IPv4 — picks whatever the OS happens
 * to list first, which on a Mac is regularly a VPN tunnel (utun*), an AirDrop
 * adapter (awdl0), or a Docker bridge. Phones can't reach any of those, so the
 * game would print an address that silently goes nowhere.
 *
 * So: throw out interfaces that are never the answer, then rank what's left.
 * Returns the best guess; `lanCandidates()` exposes the rest for the boot
 * message, because a wrong guess is much easier to recover from when the
 * alternatives are printed right there.
 */
const VIRTUAL_IFACE = /^(utun|tun|tap|awdl|llw|bridge|docker|veth|vboxnet|vmnet|zt|wg|ham|anpi)/i;

function lanCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      // Rank: real Wi-Fi/Ethernet names first, then by how likely the range is
      // to be a home network a phone shares.
      let score = 0;
      if (/^en\d/.test(name)) score += 100;      // macOS Wi-Fi / Ethernet
      if (/^(eth|wlan|wl)\d/.test(name)) score += 100; // Linux equivalents
      if (a.address.startsWith('192.168.')) score += 50;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 30;
      else if (a.address.startsWith('10.')) score += 20;
      if (name === 'en0') score += 10;           // the usual Wi-Fi on a Mac
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function lanAddress() {
  const best = lanCandidates()[0];
  return best ? best.address : 'localhost';
}


createCore({ app, server, games, port: PORT, lanAddress });

server.listen(PORT, '0.0.0.0', () => {
  // Hosts set these; locally none of them exist.
  const hostedUrl =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) ||
    (process.env.FLY_APP_NAME && `https://${process.env.FLY_APP_NAME}.fly.dev`) ||
    null;
  const hosted = !!hostedUrl || !!process.env.RENDER || !!process.env.FLY_APP_NAME;

  console.log('\n  PARTY BOX is running\n');

  if (hosted) {
    // Deployed: there's no LAN and no "same Wi-Fi" — everyone comes in over
    // the internet, so printing a local address would just mislead.
    console.log(`  Listening on port ${PORT}.`);
    if (hostedUrl) {
      console.log(`\n    TV / laptop   ->  ${hostedUrl}/host`);
      console.log(`    Phones        ->  ${hostedUrl}\n`);
    } else {
      console.log('  Open /host on your public URL for the TV screen,');
      console.log('  and the root URL on phones.\n');
    }
    return;
  }

  const all = lanCandidates();
  const ip = all.length ? all[0].address : 'localhost';
  if (!all.length) {
    console.log('  No network address found — this machine may be offline.');
    console.log(`  You can still open http://localhost:${PORT}/host on this computer,`);
    console.log('  but phones will not be able to reach it.\n');
    return;
  }
  // Point the TV at the network address too, not localhost: the QR code and
  // the join address shown on screen are built from whatever the TV page was
  // opened at, and "localhost" means "this phone" to a phone.
  console.log('  Open BOTH of these in a web browser (not in this terminal):\n');
  console.log(`    TV / laptop   ->  http://${ip}:${PORT}/host`);
  console.log(`    Phones        ->  http://${ip}:${PORT}\n`);
  if (all.length > 1) {
    console.log('  If phones cannot reach that, try one of these instead:');
    for (const c of all.slice(1)) console.log(`    http://${c.address}:${PORT}   (${c.name})`);
    console.log('');
  }
  console.log('  Phones must be on the same Wi-Fi as this computer.');
  console.log('  Cafe, hotel and apartment Wi-Fi usually block this — deploy instead.\n');
});
