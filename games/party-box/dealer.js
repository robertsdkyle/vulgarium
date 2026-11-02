/**
 * The prompt dealer for Party Box. Moved out of server.js unchanged in spirit:
 *
 *   THE POOL   hand-written prompts (prompts.js) plus every expansion of the
 *              frames in templates.js. Each entry carries its category and
 *              source, which is what lets us guarantee a spread of topics.
 *
 *   FRESHNESS  rooms are in-memory, so without a memory the same laptop would
 *              serve the same early prompts every game night. A rolling list
 *              of what's been used is kept on disk (best-effort) and skipped
 *              until the pool is mostly spent.
 *
 * New: a round can now be dealt from a category a player picked.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RAW_PROMPTS = require(path.join(ROOT, 'prompts'));
const { expand: expandTemplates } = require(path.join(ROOT, 'templates'));

const POOL = [
  ...Object.entries(RAW_PROMPTS.GROUPS || { Misc: RAW_PROMPTS }).flatMap(([group, items]) =>
    items.map((text) => ({ text, group, source: 'written' }))
  ),
  ...expandTemplates(),
];

const GROUP_NAMES = [...new Set(POOL.map((p) => p.group))];

const USED_FILE = process.env.USED_FILE || path.join(ROOT, '.used-prompts.json');
const USED_CAP = Math.floor(POOL.length * 0.7); // recycle before we run dry

let usedPrompts = [];
try {
  const disk = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
  if (Array.isArray(disk)) usedPrompts = disk.filter((t) => typeof t === 'string');
} catch (_) { /* first run, or no writable disk — fine */ }

let saveQueued = false;
function rememberUsed(text) {
  usedPrompts.push(text);
  if (usedPrompts.length > USED_CAP) usedPrompts = usedPrompts.slice(-Math.floor(USED_CAP / 2));
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try { fs.writeFileSync(USED_FILE, JSON.stringify(usedPrompts)); } catch (_) {}
  }, 2000).unref();
}

/**
 * Deal one prompt.
 *
 * `bk` is the game's bookkeeping: { usedPrompts, usedGroups, usedSources }.
 * With `forceGroup` the deal stays inside that category (a player picked it);
 * otherwise it picks a category this game hasn't used yet — the blend.
 * The net widens step by step rather than ever failing to deal.
 */
function dealPrompt(bk, forceGroup = null) {
  const fresh = GROUP_NAMES.filter((g) => !bk.usedGroups.has(g));
  const groupPool = forceGroup && GROUP_NAMES.includes(forceGroup) ? [forceGroup] : fresh.length ? fresh : GROUP_NAMES;

  const eligible = (relaxUsed, relaxSource) =>
    POOL.filter(
      (p) =>
        groupPool.includes(p.group) &&
        !bk.usedPrompts.has(p.text) &&
        (relaxSource || p.source === 'written' || !bk.usedSources.has(p.source)) &&
        (relaxUsed || !usedPrompts.includes(p.text))
    );

  let candidates = eligible(false, false);
  if (!candidates.length) candidates = eligible(true, false);
  if (!candidates.length) candidates = eligible(true, true);
  if (!candidates.length) candidates = POOL.filter((p) => !bk.usedPrompts.has(p.text));
  if (!candidates.length) candidates = POOL;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  bk.usedGroups.add(pick.group);
  bk.usedPrompts.add(pick.text);
  if (pick.source !== 'written') bk.usedSources.add(pick.source);
  rememberUsed(pick.text);
  return pick;
}

module.exports = { POOL, GROUP_NAMES, dealPrompt };
