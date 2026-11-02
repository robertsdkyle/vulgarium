/**
 * Every game under the Party Box umbrella. The key is the game type that
 * appears in room lookups, the welcome, and the controller URL the phone
 * loads on demand: /games/<type>/controller.js (and /games/<type>/tv.js).
 */
module.exports = {
  'party-box': require('./party-box/logic'),
};
