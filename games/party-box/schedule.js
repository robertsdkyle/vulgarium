/**
 * Which rounds of a game get a personal prompt (one built from a player's
 * lobby answer).
 *
 * The old rule took a fixed number of rounds (2 of 3) uniformly at random,
 * so round 1 was personal two games out of three and they stopped feeling
 * like a surprise. Now:
 *
 *   HOW MANY  random between 1 and `max` (never 0 when someone is eligible —
 *             answering the lobby question should always pay off), capped by
 *             how many people can be targeted.
 *   WHICH     weighted toward later rounds. A prompt about someone in the
 *             room lands hardest once everyone's warmed up; round 1 still
 *             happens, just rarely.
 *
 * With the defaults (max 2, weights 1:3:4) round 1 is personal in about one
 * game in five, instead of two in three.
 */

// Relative chance of each round being picked; index 0 is round 1. Rounds
// past the end of this list use its last weight.
const ROUND_WEIGHTS = [1, 3, 4];

function pickPersonalRounds({ rounds, max, eligible, weights = ROUND_WEIGHTS, rng = Math.random }) {
  const cap = Math.min(max, eligible, rounds);
  if (cap <= 0) return new Set();
  const count = 1 + Math.floor(rng() * cap); // 1..cap

  // Weighted sampling without replacement.
  const pool = Array.from({ length: rounds }, (_, i) => ({ round: i + 1, w: weights[Math.min(i, weights.length - 1)] }));
  const chosen = new Set();
  while (chosen.size < count && pool.length) {
    const total = pool.reduce((t, x) => t + x.w, 0);
    let r = rng() * total;
    let i = 0;
    while (i < pool.length - 1 && r >= pool[i].w) { r -= pool[i].w; i++; }
    chosen.add(pool.splice(i, 1)[0].round);
  }
  return chosen;
}

module.exports = { pickPersonalRounds, ROUND_WEIGHTS };
