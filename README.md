# Party Box

A phone-as-controller party game. The TV shows the game, everyone's phone is their private controller. No app to install — players open a browser and type a 4-letter code.

**The game (proof of concept):** three rounds. Everyone gets the same prompt, writes a funny answer on their phone, then votes on everyone else's. 100 points per vote received. Highest score wins.

**Hands-free by default.** Every phase runs on a timer, so the game plays itself start to finish — you never have to touch the laptop mid-game. Players see a countdown; if everyone finishes early, it advances immediately instead of waiting. There's also a **Skip ahead** button on the TV if you want to jump forward.

**Scan to join.** The lobby shows a QR code alongside the room code. Phones scan it and land on a join screen with the code already filled in — no typing the address at all.

Tested end to end: full game with a host plus three players, QR generation, and timer expiry with a player who never responds (the game advances past them and never stalls).

---

## Run it

```bash
npm install
npm start
```

To check everything works before a party:

```bash
npm test
```

That boots its own server and runs all four suites — 62 assertions covering reconnection, seed privacy, prompt dealing and personal prompts. Takes about a minute.

The console prints two addresses:

```
TV / laptop   ->  http://localhost:3000/host
Phones        ->  http://192.168.1.42:3000
```

Open the first on the laptop that's plugged into the TV. Everyone else opens the second on their phone and types the code off the screen.

---

## Option 1 — Run it on your laptop (game night)

This is what Jackbox actually does, and it's the better choice for a party in one room.

1. Laptop plugged into the TV via HDMI, browser fullscreen (F11) on `/host`
2. Everyone on the **same Wi-Fi** as the laptop
3. Phones go to the LAN address printed in the console

**What to know:**
- No internet needed except for the fonts (it degrades fine without them)
- Zero latency, zero cost, nothing to deploy
- If phones can't connect, it's almost always one of two things: guest Wi-Fi with client isolation turned on (put everyone on the main network), or your laptop's firewall blocking port 3000
- The IP can change when your router reassigns leases — reread the console each time

## Option 2 — Deploy it (remote play)

Players on different networks, anywhere.

**Render / Railway / Fly.io:** push to GitHub, point the service at the repo, build `npm install`, start `npm start`. The server already reads `process.env.PORT`, and the client connects with a relative URL so it upgrades to secure WSS automatically. Nothing to configure.

**No database needed.** Rooms live in memory and die with the game, so you skip the managed-Postgres line item that dominates most hosting bills. Bandwidth is negligible — this is a text game.

**What it costs:** free tiers work for testing but sleep after ~15 minutes idle, so the first visitor waits through a cold start. Open the host page a couple of minutes early and it's a non-issue. A small always-on instance runs roughly $5-7/mo, which is plenty for dozens of concurrent rooms. Watch out for usage-metered hosts with no spending cap.

**Tunables** (environment variables, all optional):

```
T_WRITING=60      seconds to write an answer
T_VOTING=25       seconds to vote
T_RESULTS=12      seconds on the reveal
HOST_GRACE=120    seconds a room survives without its host
PLAYER_GRACE=900  seconds a disconnected player keeps their seat
```

**Health check:** `GET /healthz` returns `{ok: true, rooms: N}` — point your host's monitor at it.

**Scaling:** one instance holds a lot. Past that you'd need the socket.io Redis adapter plus sticky sessions, since rooms are per-process.

---

## Files

```
server.js           game state machine, identity, timers, sockets
prompts.js          the prompt deck — edit this one
templates.js        frames that expand into more prompts
seeds.js            scraps players can borrow while writing
personal.js         lobby questions and the frames they feed
run-tests.js        runs every test suite (npm test)
public/host.html    the TV screen
public/index.html   the phone controller
public/style.css    both screens
test-*.js           four suites, 62 assertions
```

## Make it yours

**Prompts** — 276 in the pool, across twelve categories. They come from two places:

- **`prompts.js`** — 185 hand-written. Delete a line to cut one, copy a line to add one; keep the double quotes and the trailing comma. Write the blank as `______`.
- **`templates.js`** — 12 frames that expand into 91 more at boot. A frame like `"{X} would like a word about ______"` with eight fillers gives you eight prompts, because the frame carries the joke and the noun just changes the flavour.

**Dropping a category:** comment out one line in `ACTIVE` at the bottom of `prompts.js`. Playing with your in-laws and want religion gone? `//` in front of `RELIGION` and it's out for the night.

**On religion, politics and money:** these aim at the machinery, never at a side. Corruption, hypocrisy, fundraising, spin and bureaucracy are funny to everyone in the room; "your team is stupid" is only funny to half of it. Brutal doesn't mean partisan. No real names anywhere, deliberately — named targets date fast and start arguments instead of jokes.

**Timers** — the `TIMERS` object near the top of `server.js`: `WRITING` (60s), `VOTING` (25s), `RESULTS` (12s), all in seconds. Bump `WRITING` up if people need more time to think, or drop `RESULTS` if the reveal drags. You can also override them without editing the file — set `T_WRITING`, `T_VOTING`, or `T_RESULTS` when starting, e.g. `T_WRITING=90 npm start`.

**Length and scoring** — `ROUNDS` and `POINTS_PER_VOTE`, same spot.

**Player cap** — currently 10, in the `player:join` handler.

## Adding the other game modes

The architecture is already set up for it. `room.phase` drives everything, and both screens are just switch statements over the phase. To add Fibbage:

1. Add a `truth` field to the room and prompts that carry a real answer
2. In `WRITING`, players submit lies instead of jokes
3. In `VOTING`, shuffle the truth in with the lies
4. Score two ways: points for fooling someone, points for finding the truth

That's maybe 40 lines. Trivia is even less — swap voting for a first-correct timer.

Add a `room.gameType` field and a game picker on the lobby screen and you've got the full pack.


## Reconnection

Players are identified by a `pid` token their own browser holds, not by their socket connection. This is what makes remote play survive real phones — a screen lock, a walk out of wifi range, or a hop to cellular all kill the socket, and without a stable token each one would cost that player their seat and score.

What happens on a drop:

- **A player drops.** Their seat, name, score, answer and vote all stay put. The roster shows them greyed out. When their phone comes back it presents the pid and picks up exactly where it left off. They keep the seat for 15 minutes by default.
- **The game doesn't wait for them.** Round advancement only counts connected players, and the phase timer covers the rest, so one person wandering off never stalls the room.
- **The host drops.** The room survives for 2 minutes, so a TV reload or a blip doesn't end the party. The game keeps running on server timers; the host sees current state when it returns.
- **Anything genuinely dead** gets cleaned up by a sweep that runs every minute, so a long-running server doesn't leak memory.

Both screens show a red "Reconnecting" bar while the socket is down, and nothing on screen gets wiped — the state reappears when the connection returns.

Covered by `test-reconnect.js`: 19 assertions across seat reclamation, vote survival, rejected tokens, host reload, and host-drop tolerance.


## Seeds

Cards Against Humanity hands you cards. Fibbage hands you a blank box. Both work, for different reasons — cards kill blank-page paralysis and generate comedy through collision, while a blank box has an unlimited ceiling. Seeds are the middle: **raw material, not answers.**

During the writing phase each player gets five short scraps under their text box — things like *a moist handshake*, *the HOA*, *expired mayonnaise*. Tap one and it drops into your answer at the cursor. Tap two and they stack. Or ignore them entirely and write your own; they're styled quiet on purpose so confident writers can look past them.

Three decisions worth knowing about, because they're what make it work:

**Hands are private and non-overlapping.** Each player gets their own five, dealt off one shuffled deck so nobody in a round sees the same scrap. Shared seeds would converge everyone's answers onto the same joke — the exact opposite of the goal. This is why CAH deals separate hands too.

**Seeds are never matched to the prompt.** That looks like a missed opportunity and isn't. The comedy comes from collision: "expired mayonnaise" is nothing on its own, but *"Cause of death: expired mayonnaise"* is the whole joke. Prompt-matched seeds would smooth out exactly the friction that's funny.

**They insert rather than replace.** A seed is a starting point, not a card you play. The answer stays yours, which keeps the ceiling where Fibbage has it.

Edit them in `seeds.js`. The file header explains what makes a good one, but the short version: concrete beats abstract, four words or fewer, and it should suggest a joke without being one. Seeds naming people in your actual room are lethal.

Deal size is tunable with `SEEDS_PER_PLAYER` (default 5).


## Freshness

Three mechanisms, because "we need more prompts" is only half the problem.

**Blend is enforced by the dealer, not by the deck.** Each round draws from a category the game hasn't used yet, so every three-round game spans three different topics. This matters because the categories aren't the same size and never will be — religion holds 28 prompts, tame holds 19. Without a balanced dealer the big categories would dominate by sheer weight, and you'd be hand-trimming the deck forever to keep it even. Category size now only affects how long a category takes to come round again, not how often it shows up.

**Used prompts are remembered across games and across nights.** The server keeps a rolling list in `.used-prompts.json` next to the code and skips those when dealing, recycling once the pool is about 70% spent. So the same group on the same laptop can play many nights before seeing a repeat — roughly **92 games** at three prompts each. Delete the file to wipe the history.

On an ephemeral host (Render, Railway, Fly) the filesystem resets on redeploy, so this degrades to per-deployment memory. Everything still works; the window is just shorter. Set `USED_FILE` to a path on a mounted volume if you want it to survive.

**The host can swap a prompt.** During writing, the TV shows a **Different prompt** button — for when the room groans, or one lands wrong for the crowd. It deals a fresh one and restarts the round clock. It disappears the moment anyone submits an answer, so nobody loses work.

### Growing the pool further

Adding one frame to `templates.js` with eight fillers adds eight prompts for about a minute of work — the cheapest way to grow. Hand-written prompts are better one at a time; templates are better in bulk.

If you ever want genuinely novel prompts rather than more combinations, the pool is a plain list — a script could append LLM-generated ones to `prompts.js` between sessions. Worth generating in batches and reading them before they go in, rather than live at game time: an unreviewed prompt goes straight onto a TV in front of your friends, and generation at runtime adds a network dependency to a game that currently has none.


## Personal prompts

Prompts built from real stories told by the people in the room. These beat anything pre-written, because the room already has the context.

**Everyone gets asked one question in the lobby**, while they're waiting for the rest to join. Two rounds of each game then use those answers, dropped at random points so they arrive as a surprise.

### The grammar problem

A story is a whole sentence; a prompt needs a fragment that slots into a frame. Drop one into the other and you get:

> The part Dana leaves out about I got food poisoning at my cousin's wedding: ______.

So the game never asks for a free-form story. Every question is a **stem the player completes** — *"the time I…"* — shown as a visible prefix before the input box, so finishing the sentence is the obvious thing to do. Their answer then arrives in a known grammatical shape and the frames are built around it:

> The part Dana leaves out about the time they got food poisoning at a wedding: ______.

Three cleanups happen on the way in, all of which were real bugs caught in testing:

- **First person becomes third.** Answers are written as *"missed my own flight"* but frames talk about the player as *they* — without conversion you get *"the time they missed my own flight"*.
- **Duplicated subjects are dropped.** With the stem *"as a teenager I…"*, someone typing *"I dyed my hair green"* would otherwise produce *"Dana they dyed their hair green"*.
- **Stem echoes are stripped**, but carefully — an early version ate the word "that" out of *"that campsite"*.

### The design rule

A player only ever supplies a story about **themselves**, never about someone else. Player-writes-about-player turns cruel within about two rounds and doesn't need a game to do it. Self-supplied material stays affectionate, because the target handed it over — they're in on it before the prompt exists.

### Opting out

Anyone can decline to be named and still play everything else, and the host can switch personal prompts off for the whole room from the lobby. Some crowds love being roasted and some don't, and you often can't tell in advance.

Skipping the question is fine too — those players fall back to name-only frames like *"{NAME}'s glovebox contains ______"*, which need nothing but a name.

### Tuning

`PERSONAL_ROUNDS` sets how many rounds of a game use one (default 2 of 3; set it to 0 to disable). It's automatically capped by how many people are eligible, so nobody gets named twice in a game while someone else goes unmentioned.

Add your own questions in `personal.js`. Each one declares its answer shape — `past`, `doing`, or `thing` — and its frames must match, since a mismatched shape reads as a bug on the TV. Test any new frame against a few real answers before shipping it.
