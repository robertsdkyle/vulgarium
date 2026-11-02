/**
 * HOUSE ANSWERS
 * =========================================================================
 * Decoys the game slips into every vote. They sit in the list looking
 * exactly like player answers; anyone who votes for one has been fooled by
 * the box, and that vote scores for nobody. The reveal shows them as
 * "The Box".
 *
 * They do two jobs:
 *   1. Variety and a little suspicion — "was that Dana, or the box?"
 *   2. A vote still happens when only one or two people answered (someone
 *      dropped, someone froze), instead of the round skipping to results.
 *
 * HOW THEY'RE BUILT
 *   A seed scrap nobody was dealt this round, dropped into one of the
 *   frames below. Seeds are deliberately generic (see seeds.js), and the
 *   comedy comes from a mundane thing colliding with the prompt — the same
 *   engine as a player borrowing a seed, which is why they blend in.
 *
 *   Plain "{S}" appears several times on purpose: a bare scrap is the most
 *   convincing decoy, so it should be the most common.
 *
 * Add your own: one per line, keep {S} somewhere in it, keep them short and
 * lowercase-ish so they read like something typed on a phone.
 * =========================================================================
 */

const FRAMES = [
  '{S}',
  '{S}',
  '{S}',
  '{S}',
  '{S}, allegedly',
  '{S} and no witnesses',
  '{S}, again',
  'honestly? {S}',
  'a group chat about {S}',
  'three weeks of {S}',
  'whatever {S} was hiding',
  '{S}, but bigger',
  'the ghost of {S}',
  'a strongly worded letter about {S}',
  '{S} at 3am',
  'a podcast about {S}',
  '{S} with a lawyer present',
  'a tasteful amount of {S}',
];

/**
 * Make `count` decoys from `spare` seeds (ones nobody holds this round),
 * avoiding anything that matches a real answer.
 */
function makeHouseAnswers(count, spare, taken) {
  const seen = new Set(taken.map((t) => t.toLowerCase().trim()));
  const out = [];
  const pool = [...spare];
  while (out.length < count && pool.length) {
    const seed = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const frame = FRAMES[Math.floor(Math.random() * FRAMES.length)];
    const text = frame.replace('{S}', seed).slice(0, 90);
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

module.exports = { FRAMES, makeHouseAnswers };
