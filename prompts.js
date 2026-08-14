/**
 * THE DECK
 * =========================================================================
 * Hand-written prompts, grouped by category. More get generated from
 * templates.js at boot — see that file for how the frames work.
 *
 * HOW TO EDIT (safe on a phone):
 *   - Every prompt is a line in "double quotes" ending with a comma.
 *   - Delete a line to cut it. Copy a line to add one.
 *   - Use ______ (six underscores) for the blank. The game highlights it.
 *
 * HOW TO DROP A WHOLE CATEGORY:
 *   Scroll to ACTIVE at the bottom and comment out one line. Playing with
 *   your in-laws and want the religion prompts gone? Put // in front of
 *   RELIGION and they're out for the night. Nothing else to change.
 *
 * ON BLEND:
 *   Don't worry about keeping the categories the same size. The dealer picks
 *   a DIFFERENT category for each round, so a game always spans three topics
 *   no matter how lopsided the counts are. Category size only affects how
 *   long that category takes to repeat, not how often it shows up.
 *
 * WHAT MAKES A PROMPT LAND:
 *   1. A BLANK BEATS A QUESTION. Questions invite wordy explanations; a slot
 *      forces one punchy noun, which is where the laugh lives.
 *   2. SPECIFIC SETUP, WIDE SLOT. Vivid enough to picture instantly, open
 *      enough to accept anything.
 *   3. FUNNY BEFORE THE ANSWER. If it gets no reaction hitting the TV, it
 *      won't rescue a weak answer either.
 *   4. NO OBVIOUS ANSWER. If everyone writes the same thing, there's no
 *      contest and nothing worth voting on.
 *
 * ON RELIGION, POLITICS AND MONEY:
 *   These aim at the machinery, never at a side. Corruption, hypocrisy,
 *   fundraising, spin and bureaucracy are funny to everyone in the room;
 *   "your team is stupid" is only funny to half of it, and half a room
 *   laughing is a broken party game. Brutal doesn't mean partisan — it means
 *   not flinching. There are no real names anywhere in here, deliberately:
 *   named targets date fast and start arguments instead of jokes.
 *
 * The single best upgrade: prompts about the people in your actual room.
 * =========================================================================
 */

const MORTALITY = [
  "Cause of death: ______.",
  "My will specifies that I be buried with ______.",
  "The funeral was going fine until ______.",
  "Turns out the afterlife is just ______.",
  "Grandma's last words were ______.",
  "They found ______ in the walls.",
  "The hospice nurse has seen everything except ______.",
  "My headstone will read ______.",
  "The coroner noted one unusual detail: ______.",
  "I want my ashes scattered over ______.",
  "The obituary politely omitted ______.",
  "The eulogy went off the rails at ______.",
  "They pulled the plug over ______.",
  "The life insurance claim was denied because of ______.",
];

const MEDICAL_HORROR = [
  "The surgeon paused, looked at me, and said ______.",
  "Worst thing to hear while you're going under: ______.",
  "The test results came back positive for ______.",
  "My therapist stopped taking notes when I mentioned ______.",
  "The pharmacist gave me a very long look about ______.",
  "New side effects include ______.",
  "The rash is spreading and it now resembles ______.",
  "The waiver I signed mentioned ______.",
  "The specialist has never seen ______ before.",
  "They found ______ on the X-ray.",
  "The anesthesia wore off during ______.",
  "My chart has one note that just says ______.",
  "The clinical trial's control group got ______.",
];

const VICE = [
  "Blackout me is out there right now doing ______.",
  "The bartender cut me off after I ______.",
  "My dealer has started offering ______.",
  "Rehab was going great until someone smuggled in ______.",
  "Vegas was a mistake, and the mistake was ______.",
  "I've replaced my entire personality with ______.",
  "The hangover was bad, but the ______ was worse.",
  "The bender ended at ______.",
  "I quit everything except ______.",
  "Last night's group chat is entirely ______.",
  "My sponsor doesn't know about ______.",
  "The bet started as ______.",
  "Somebody spiked the punch with ______.",
  "The tab included ______.",
];

const CRIME = [
  "I only commit light crimes, like ______.",
  "The judge added six months for ______.",
  "Prison would honestly be fine if not for ______.",
  "The bouncer threw me out for ______.",
  "The court has ordered me to attend classes about ______.",
  "The cop let me off with a warning about ______.",
  "My alibi is ______, and I'm sticking to it.",
  "The heist fell apart because of ______.",
  "The getaway was delayed by ______.",
  "The evidence locker holds ______.",
  "The witness described the suspect as ______.",
  "The plea deal hinged on ______.",
  "The security footage shows ______.",
  "The stolen goods turned out to be ______.",
];

const CORPORATE_EVIL = [
  "HR wants to see me about ______.",
  "The employee handbook now has a full page on ______.",
  "Our new company value is ______.",
  "The terms of service quietly added ______.",
  "The billionaire's bunker is stocked entirely with ______.",
  "The airline now charges extra for ______.",
  "We're not doing layoffs, we're doing ______.",
  "The team-building exercise was just ______.",
  "The CEO's apology video mentioned ______ eleven times.",
  "The all-hands ended with ______.",
  "The performance review flagged ______.",
  "Our disruptive innovation is just ______.",
  "The intern discovered ______.",
  "The merger was blocked over ______.",
];

const RELIGION = [
  "The eleventh commandment: ______.",
  "The confession booth has heard it all, except ______.",
  "Heaven's entrance exam has exactly one question about ______.",
  "The megachurch pastor's private jet is full of ______.",
  "God's actual reason for the flood: ______.",
  "The doomsday cult was right about everything except ______.",
  "The exorcist gave up when the demon requested ______.",
  "The tithe went straight to ______.",
  "The road to hell is paved with ______.",
  "St. Peter's clipboard has one red flag: ______.",
  "Sunday school skipped the part about ______.",
  "The miracle was later explained by ______.",
  "The prayer chain has devolved into ______.",
  "Purgatory is a waiting room with ______.",
  "The collection plate came back holding ______.",
  "Hell's orientation packet opens with ______.",
  "The relic turned out to be ______.",
  "The televangelist needs your money for ______.",
  "The holy war started over ______.",
  "The seance summoned ______.",
  "The commandment nobody brings up: ______.",
];

const POLITICS = [
  "The campaign promise quietly dropped: ______.",
  "The senator's explanation involved ______.",
  "The bill passed at 3 a.m. because of ______.",
  "My opponent is funded by ______.",
  "The leaked memo mentioned ______.",
  "The town hall descended into ______.",
  "The lobbyist's expense report includes ______.",
  "They resigned to spend more time with ______.",
  "The scandal broke when someone found ______.",
  "The debate was decided by ______.",
  "The new law bans everything except ______.",
  "The press secretary described it as ______.",
  "The recount turned up ______.",
  "The oath of office now includes ______.",
  "The filibuster was just ______ for nine hours.",
  "The bipartisan compromise was ______.",
  "The attack ad accused them of ______.",
  "The committee spent eight months investigating ______.",
  "The campaign bus smells like ______.",
  "The concession speech blamed ______.",
];

const MONEY = [
  "The tax return lists ______ as a business expense.",
  "My retirement plan is ______.",
  "The financial advisor recommended ______.",
  "The startup pivoted to ______.",
  "My credit score dropped because of ______.",
  "The crypto whitepaper promised ______.",
  "The upline says the secret is ______.",
  "The rich are just like us, except for ______.",
  "The bank denied the loan over ______.",
  "The inheritance came with one condition: ______.",
  "The hedge fund's entire strategy is ______.",
  "The security deposit was withheld for ______.",
  "My side hustle is ______.",
  "The pyramid scheme's actual product was ______.",
  "The estate sale featured ______.",
  "The IRS would like a word about ______.",
  "The GoFundMe is for ______.",
  "The bonus structure rewards ______.",
  "Nothing says wealth like ______.",
  "The yacht christening involved ______.",
];

const FAMILY = [
  "Thanksgiving ended when Dad brought up ______.",
  "The family group chat detonated over ______.",
  "Mom's number one disappointment is ______.",
  "The inheritance was split evenly except for ______.",
  "My childhood was mostly ______.",
  "The custody hearing hinged on ______.",
  "The reunion photo is missing ______.",
  "Grandma's recipe card just says ______.",
  "The sibling group chat is ninety percent ______.",
  "The wedding toast revealed ______.",
  "Dad's shed contains ______.",
  "The family secret is ______.",
  "Mom's freezer has held ______ since 2009.",
  "The divorce was finalized over ______.",
];

const CURSED = [
  "The vending machine has started dispensing ______.",
  "The AI woke up and immediately asked for ______.",
  "My sleep paralysis demon just wants to discuss ______.",
  "The prophecy was weirdly specific about ______.",
  "The zoo's newest exhibit is ______.",
  "Deep in the Mariana Trench, they found ______.",
  "The time traveler came back to warn us about ______.",
  "Every night at 3 a.m. the neighbors are ______.",
  "The Roomba has developed a taste for ______.",
  "The escape room was going well until we found ______.",
  "The dog won't stop staring at the corner because of ______.",
  "The group chat has been quiet since ______.",
  "The horse walked into the bar and ordered ______.",
  "The mirror shows ______ now.",
  "The basement door was locked from ______.",
];

const FILTH = [
  "The safe word was ______, and it did not work.",
  "The hotel room black light revealed ______.",
  "The gym has banned me for ______.",
  "My browser history is ninety percent ______.",
  "There's a reason I stopped shaking hands, and it's ______.",
  "The dating profile said only ______.",
  "TSA is now legally required to describe ______.",
  "The public pool was closed due to ______.",
  "The couch has absorbed ______.",
  "The roommate's side of the fridge holds ______.",
  "The lost and found is mostly ______.",
  "The massage took a turn toward ______.",
  "The hot tub incident involved ______.",
  "The laundry revealed ______.",
];

const TAME = [
  "The new flavor nobody asked for: ______.",
  "The theme park's least popular ride is ______.",
  "The self-checkout machine has started saying ______.",
  "A rejected Olympic sport: ______.",
  "The worst possible name for a cruise ship: ______.",
  "The cereal box promised ______.",
  "The GPS confidently said ______.",
  "The gift receipt was for ______.",
  "The playlist opens with ______.",
  "The group costume was ______.",
  "Secret santa produced ______.",
  "The trophy was awarded for ______.",
];

// ---------------------------------------------------------------------------
// Comment out any line below to drop that whole category for the night.
// ---------------------------------------------------------------------------
const ACTIVE = [
  MORTALITY,
  MEDICAL_HORROR,
  VICE,
  CRIME,
  CORPORATE_EVIL,
  RELIGION,
  POLITICS,
  MONEY,
  FAMILY,
  CURSED,
  FILTH,
  TAME,
];

const PROMPTS = ACTIVE.flat();

// Named groups, for the dealer and the preview page.
PROMPTS.GROUPS = Object.fromEntries([
  ["Mortality", MORTALITY],
  ["Medical horror", MEDICAL_HORROR],
  ["Vice", VICE],
  ["Crime", CRIME],
  ["Corporate evil", CORPORATE_EVIL],
  ["Religion", RELIGION],
  ["Politics", POLITICS],
  ["Money", MONEY],
  ["Family", FAMILY],
  ["Cursed", CURSED],
  ["Filth", FILTH],
  ["Tame", TAME],
]);

module.exports = PROMPTS;
