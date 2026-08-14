/**
 * PROMPT TEMPLATES
 * =========================================================================
 * Frames with one swappable slot. Each frame expands into as many prompts as
 * it has fillers, so a dozen frames here roughly doubles the deck.
 *
 * WHY THIS WORKS
 *   In a good prompt the *frame* does the comedic labour — the scene, the
 *   stakes, the implied story. The specific noun inside it just changes the
 *   flavour. So "{RITUAL} was ruined by ______" is already funny before you
 *   pick which ritual, and every filler inherits that.
 *
 * WHAT MAKES A GOOD FRAME
 *   - It must be funny with EVERY filler, not just your favourite one. If two
 *     of eight fall flat, cut those fillers rather than shipping them.
 *   - One slot only. Two slots multiply combinations but most read as noise.
 *   - The ______ blank stays where it is; {SLOT} is the part that varies.
 *
 * These are tagged by category and get dealt exactly like hand-written
 * prompts. The dealer treats a frame as one source, so you'll never get two
 * prompts from the same frame in one game.
 * =========================================================================
 */

const TEMPLATES = [
  {
    group: 'Corporate evil',
    frame: '{X} has quietly introduced a policy about ______.',
    fills: ['Corporate', 'Legal', 'The school board', 'The co-op board', 'Compliance', 'The franchise owner', 'Middle management', 'The HOA'],
  },
  {
    group: 'Crime',
    frame: '{X} would like a word about ______.',
    fills: ['The IRS', 'My probation officer', 'Internal affairs', 'The health inspector', 'Code enforcement', 'Animal control', 'The dean', 'The licensing board'],
  },
  {
    group: 'Cursed',
    frame: 'Nobody expected to find ______ in {X}.',
    fills: ['the crawlspace', 'the storm drain', 'the abandoned mall', "my parents' attic", 'the walk-in freezer', 'the sub-basement', 'the ball pit', 'the church van'],
  },
  {
    group: 'Mortality',
    frame: '{X} was ruined by ______.',
    fills: ['The funeral', 'The wake', 'The scattering of the ashes', 'The memorial slideshow', 'The graveside service', 'The reading of the will', 'The viewing'],
  },
  {
    group: 'Vice',
    frame: '{X} ended with ______.',
    fills: ['The bachelor party', 'Trivia night', 'The work happy hour', 'The wine tasting', 'The tailgate', "New Year's Eve", 'The company retreat', 'Karaoke'],
  },
  {
    group: 'Family',
    frame: "{X} won't stop bringing up ______.",
    fills: ['My mother', 'Uncle Dale', 'My stepsister', 'Grandpa', 'The in-laws', 'My cousin who does CrossFit', 'Dad', 'The group chat'],
  },
  {
    group: 'Religion',
    frame: '{X} would not approve of ______.',
    fills: ['The pastor', 'My confirmation sponsor', 'The church council', 'Whichever angel is on duty', 'The prayer group', 'The deacon', 'The nuns'],
  },
  {
    group: 'Politics',
    frame: '{X} voted unanimously in favour of ______.',
    fills: ['The city council', 'The ethics committee', 'The school board', 'The zoning board', 'The subcommittee', 'The homeowners association', 'The parks department'],
  },
  {
    group: 'Money',
    frame: '{X} spent the entire budget on ______.',
    fills: ['The nonprofit', 'The startup', 'The PTA', 'The university', 'The campaign', 'The wedding planner', 'The department', 'The union'],
  },
  {
    group: 'Filth',
    frame: '{X} smells like ______.',
    fills: ['The gym locker room', 'The tour van', "My roommate's car", 'The dorm hallway', 'The bowling alley', 'The frat basement', 'The porta-potty at mile twelve'],
  },
  {
    group: 'Medical horror',
    frame: '{X} recommended ______.',
    fills: ['The chiropractor', 'My dentist', 'The urgent care doctor', 'A podcast host', 'The pharmacist', 'WebMD', 'My massage therapist', 'The school nurse'],
  },
  {
    group: 'Tame',
    frame: '{X} was won by ______.',
    fills: ['The chili cook-off', 'The science fair', 'The talent show', 'The office pool', 'The county fair', 'The spelling bee', 'The bake sale'],
  },
];

/**
 * Expand every frame into concrete prompts.
 * Returns [{ text, group, source }] — `source` names the frame so the dealer
 * can avoid serving two prompts cut from the same cloth in one game.
 */
function expand() {
  const out = [];
  for (const t of TEMPLATES) {
    for (const fill of t.fills) {
      out.push({
        text: t.frame.replace('{X}', fill),
        group: t.group,
        source: t.frame,
      });
    }
  }
  return out;
}

module.exports = { TEMPLATES, expand };
