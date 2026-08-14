/**
 * PERSONAL PROMPTS
 * =========================================================================
 * Prompts built from real stories told by the people in the room. These beat
 * anything pre-written, because the room already has the context.
 *
 * THE ONE DESIGN RULE
 *   A player only ever supplies a story about THEMSELVES. Never about somebody
 *   else. Player-writes-about-player turns cruel within about two rounds and
 *   doesn't need a game to do it. Self-supplied material stays affectionate,
 *   because the target handed it over — they're in on it before the prompt
 *   exists.
 *
 * THE GRAMMAR PROBLEM, AND THE FIX
 *   A story is a whole sentence; a prompt needs a short fragment that slots
 *   into a frame. Drop one into the other and you get:
 *
 *     "The part Dana leaves out about I got food poisoning at my cousin's
 *      wedding: ______."
 *
 *   So we never ask for a free-form story. Every question is a STEM the player
 *   completes — "the time I…" — which means their answer always arrives in a
 *   known grammatical shape, and the frames can be built around that shape:
 *
 *     "The part Dana leaves out about the time they got food poisoning at a
 *      wedding: ______."
 *
 *   The phone shows the stem as a visible prefix before the input box, so
 *   completing it is the obvious thing to do. `stripStem` below cleans up
 *   after anyone who types the stem again anyway.
 *
 * SHAPES
 *   Each question declares what its answer looks like, and its frames are
 *   written to match. Mixing them up is how you get broken sentences:
 *     past   — a past-tense verb phrase:  "missed my own flight"
 *     doing  — a gerund phrase:           "arguing with a lifeguard"
 *     thing  — a noun phrase:             "a wedding DJ"
 *
 * WRITING YOUR OWN
 *   Keep questions answerable in ten seconds and safe to read aloud at a
 *   party. Comedy comes from an absurd frame meeting a mundane true detail —
 *   so keep the questions ordinary and let the frames do the work. And test
 *   every frame against a few real answers before shipping it; one mismatched
 *   shape reads as a bug on the TV.
 * =========================================================================
 */

const QUESTIONS = [
  {
    ask: 'Tell us about a time something went wrong.',
    stem: 'the time I',
    shape: 'past',
    hint: 'missed my own flight',
    frames: [
      'The part {NAME} leaves out about the time they {A}: ______.',
      'The time {NAME} {A} was set in motion by ______.',
      '{NAME} {A}, and the official explanation was ______.',
      'Moments before {NAME} {A}, somebody said ______.',
    ],
  },
  {
    ask: 'What did you get in trouble for?',
    stem: 'I once got in trouble for',
    shape: 'doing',
    hint: 'borrowing a golf cart',
    frames: [
      '{NAME} got in trouble for {A}, and got away with ______.',
      'After {NAME} was caught {A}, the punishment was ______.',
      '{NAME} was caught {A} while holding ______.',
      'The report about {NAME} {A} also mentioned ______.',
    ],
  },
  {
    ask: 'What was the worst job you ever had?',
    stem: 'the worst job I had was',
    shape: 'thing',
    hint: 'cleaning pools',
    frames: [
      "{NAME}'s worst job was {A}. The second worst involved ______.",
      '{NAME} quit {A} over ______.',
      'The staff handbook for {A} named {NAME} specifically, alongside ______.',
      'Three days into {A}, {NAME} walked out over ______.',
    ],
  },
  {
    ask: 'What is something you will never live down?',
    stem: 'I will never live down',
    shape: 'doing',
    hint: 'singing at my sister’s wedding',
    frames: [
      'Everyone remembers {NAME} {A}. Nobody mentions ______.',
      'Nobody has forgotten {NAME} {A}, but everyone forgot ______.',
      'The video of {NAME} {A} is captioned ______.',
    ],
  },
  {
    ask: 'Where should you never have gone?',
    stem: 'I should never have gone to',
    shape: 'thing',
    hint: 'that campsite',
    frames: [
      '{NAME} should never have gone to {A}, mostly because of ______.',
      '{NAME} was asked to leave {A} over ______.',
      'What {NAME} found at {A}: ______.',
    ],
  },
  {
    ask: 'What did you waste money on?',
    stem: 'I wasted good money on',
    shape: 'thing',
    hint: 'a jet ski',
    frames: [
      '{NAME} bought {A} and immediately regretted ______.',
      '{NAME} still owns {A}, stored next to ______.',
      'The receipt for {A} was filed by {NAME} under ______.',
    ],
  },
  {
    ask: 'What did you do as a teenager that you would deny now?',
    stem: 'as a teenager I',
    shape: 'past',
    hint: 'dyed my hair green',
    frames: [
      '{NAME} {A} as a teenager, and blamed it entirely on ______.',
      'Teenage {NAME} {A}. Adult {NAME} does ______.',
      '{NAME} {A} and told their parents it was ______.',
    ],
  },
  {
    ask: 'What is a story you always end up telling?',
    stem: 'I always end up telling people about',
    shape: 'thing',
    hint: 'the raccoon incident',
    frames: [
      '{NAME} will not stop telling people about {A}, or about ______.',
      'The version of {A} that {NAME} tells leaves out ______.',
      '{A} came up again, so {NAME} mentioned ______.',
    ],
  },
  {
    ask: 'What is something you are secretly bad at?',
    stem: 'I am secretly terrible at',
    shape: 'doing',
    hint: 'parking',
    frames: [
      '{NAME} is secretly terrible at {A}, and openly terrible at ______.',
      "{NAME}'s attempt at {A} ended in ______.",
      'Watching {NAME} attempt {A} is worse than ______.',
    ],
  },
  {
    ask: 'What is the strangest thing you have eaten?',
    stem: 'the strangest thing I have eaten is',
    shape: 'thing',
    hint: 'gas station sushi',
    frames: [
      '{NAME} ate {A} on a dare and followed it with ______.',
      'After the {A} incident, {NAME} swore off ______.',
      '{NAME} describes the taste of {A} as ______.',
    ],
  },
];

// Fallback when someone skips the question but is still happy to be named.
// No personal detail, so gentler — and always available.
const NAME_ONLY = [
  "{NAME}'s search history is ninety percent ______.",
  '{NAME} would sell every one of us for ______.',
  'What {NAME} does when nobody is watching: ______.',
  "{NAME}'s villain origin story began with ______.",
  'The one thing {NAME} will not shut up about: ______.',
  'In every group photo, {NAME} is the one holding ______.',
  "{NAME}'s glovebox contains ______.",
  '{NAME} has strong, unsolicited opinions about ______.',
  'The group chat muted {NAME} over ______.',
  '{NAME} peaked the day they discovered ______.',
];

/**
 * Answers arrive in first person ("missed my own flight") but frames talk
 * about the player in third ("the time they ___"). Without this you get
 * "the time they missed MY own flight". Word boundaries only, so "mystery"
 * and "immerse" survive.
 */
function thirdPerson(a) {
  return a
    .replace(/\bmyself\b/gi, 'themselves')
    .replace(/\bmine\b/gi, 'theirs')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bme\b/gi, 'them')
    .replace(/\bI'm\b/gi, "they're")
    .replace(/\bI've\b/gi, "they've")
    .replace(/\bI\b/g, 'they')
    .replace(/\bwe\b/gi, 'they')
    .replace(/\bour\b/gi, 'their')
    .replace(/\bus\b/gi, 'them');
}

/**
 * Clean a player's answer so it slots into its frames.
 * People often retype the stem ("the time I fell off a roof") or start with a
 * capital or trailing full stop — all of which read wrong mid-sentence.
 */
function stripStem(answer, stem) {
  let a = String(answer || '').trim();
  if (!a) return '';
  if (stem) {
    // Tolerate them repeating the stem, with or without punctuation.
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    a = a.replace(new RegExp('^\\s*' + esc + '\\b[,:]?\\s*', 'i'), '');
  }
  // Only strip a leading "that"/"when" when it's clearly stem residue
  // ("that time I..."), never a real word like "that campsite".
  a = a.replace(/^(that|when)\s+(time|day|night)\s+/i, '');
  // Every stem already supplies the subject ("the time I…", "as a teenager
  // I…"), so an answer starting with one doubles it up: "Dana they dyed their
  // hair green". Drop it before the pronoun pass.
  a = a.replace(/^(i|we)\s+/i, '');
  a = a.replace(/[.!?]+$/, '');                // trailing punctuation
  a = thirdPerson(a);
  a = a.replace(/\s+/g, ' ').trim();
  // Lowercase a leading capital unless it looks like a proper noun (a second
  // capital later in the word would mean something like "McDonalds").
  if (/^[A-Z][a-z]/.test(a) && !/^[A-Z][a-z]*[A-Z]/.test(a)) {
    const first = a.split(' ')[0];
    const common = /^(I|My|The|A|An|We|They)$/.test(first);
    if (common) a = a[0].toLowerCase() + a.slice(1);
  }
  return a.slice(0, 60);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Build a personal prompt for one player.
 * Falls back to a name-only frame when they skipped the question.
 *
 * `used` is a Set of raw frames already spent this game — each question only
 * has three or four frames, so without this the same joke shape returns fast.
 * The frame comes back alongside the text so the caller can keep tracking.
 */
function buildPersonal(player, used = new Set()) {
  const name = player.name;
  const q = player.setupQ != null ? QUESTIONS[player.setupQ] : null;
  const answer = player.setupA ? stripStem(player.setupA, q && q.stem) : '';

  const frames = answer && q ? q.frames : NAME_ONLY;
  const fresh = frames.filter((f) => !used.has(f));
  const frame = pick(fresh.length ? fresh : frames);

  const text = frame
    .replace(/{NAME}/g, name)
    .replace(/{A}/g, answer)
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

  return { text, frame };
}

module.exports = { QUESTIONS, NAME_ONLY, buildPersonal, stripStem };
