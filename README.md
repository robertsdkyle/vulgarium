# Party Box

A phone-as-controller party game. The TV shows the game, everyone's phone is their private controller. No app to install — players open a browser and type a 4-letter code.

**The game (proof of concept):** three rounds. Everyone gets the same prompt, writes a funny answer on their phone, then votes on everyone else's. 100 points per vote received. Highest score wins.

**Hands-free by default.** Every phase runs on a timer, so the game plays itself start to finish — you never have to touch the laptop mid-game. Players see a countdown; if everyone finishes early, it advances immediately instead of waiting. There's also a **Skip ahead** button on the TV if you want to jump forward.

**Scan to join.** The lobby shows a QR code alongside the room code. Phones scan it and land on a join screen with the code already filled in — no typing the address at all. As soon as four letters are in, the phone looks the room up and says what it is ("Party Box · 3/10 players · in the lobby") before anything connects.

**Someone picks the topic.** Each normal round, one player (rotating) chooses the category on their phone while everyone else sees "MIKE is picking". Categories already played this game show up crossed out.

**Run from a phone.** The first player in is the VIP and can start the game, and start the next one, from their phone. The TV buttons still work too.

**Stuck?** "Write one for me" sits next to Send and submits an answer for you.

**Audience.** Once a game is under way (or the room is full), latecomers can join the audience. They vote on answers; the TV shows the tally and highlights the audience favorite. Audience votes don't affect scores.

**App-like phone.** Installable to the home screen, no pinch zoom, big tap targets. A refresh or a locked screen never loses your seat — reload and it's one tap to get back in.

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

That boots its own server and runs five suites — 142 assertions covering the wire protocol and privacy boundaries, reconnection, seed privacy, prompt dealing and personal prompts. Takes about a minute and a half.

There's also a full browser run — a TV, four phones and an audience member, each its own browser profile, refreshing and reconnecting in every phase:

```bash
npm run test:e2e
```

It needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`) and saves screenshots to `e2e-shots/`.

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

**Render / Railway / Fly.io:** push to GitHub, point the service at the repo, build `npm install`, start `npm start`. The server already reads `process.env.PORT`, and the client builds its WebSocket URL from the page's own address, so on HTTPS it uses secure `wss://` automatically. Nothing to configure. Render supports WebSockets on ordinary web services; there's a `render.yaml` in the repo if you'd rather define the service as a Blueprint, but an existing dashboard-configured service keeps working as-is.

**Deploys end games in progress.** Rooms live in memory, so a deploy or restart drops every room; phones that try to reconnect are told the room ended. Deploy between game nights.

**No database needed.** Rooms live in memory and die with the game, so you skip the managed-Postgres line item that dominates most hosting bills. Bandwidth is negligible — this is a text game.

**What it costs:** free tiers work for testing but sleep after ~15 minutes idle, so the first visitor waits through a cold start. Open the host page a couple of minutes early and it's a non-issue. A small always-on instance runs roughly $5-7/mo, which is plenty for dozens of concurrent rooms. Watch out for usage-metered hosts with no spending cap.

**Tunables** (environment variables, all optional):

```
T_PICKING=12      seconds for the picker to choose a category
T_WRITING=60      seconds to write an answer
T_VOTING=25       seconds to vote
T_RESULTS=12      seconds on the reveal
PICKING=1         set to 0 to skip the category pick (server deals instead)
HOST_GRACE=120    seconds a room survives without its TV
PLAYER_GRACE=900  seconds a disconnected player keeps their seat mid-game
LOBBY_GRACE=90    seconds a disconnected player keeps their seat in the lobby
```

**Health check:** `GET /healthz` returns `{ok: true, rooms: N}` — point your host's monitor at it.

**Scaling:** one instance holds a lot. Rooms are per-process, so past one instance you'd need to route every connection for a room code to the same instance (e.g. hash the code in the path `/rooms/:code/…` to a backend).

---

## Files

```
server.js                        boots Express + the realtime core
server/core.js                   rooms, lookup, WebSocket protocol, entities, reconnects
games/index.js                   which games exist
games/party-box/logic.js         the game: rules, phases, timers, scoring (server-side)
games/party-box/dealer.js        prompt pool and dealing
prompts.js                       the prompt deck — edit this one
templates.js                     frames that expand into more prompts
seeds.js                         scraps players can borrow while writing
personal.js                      lobby questions and the frames they feed
public/index.html, js/phone.js   phone shell: lookup, join, reconnect
public/host.html, js/tv.js       TV shell: create/reclaim a room
public/js/realtime.js            browser side of the protocol (shared)
public/games/party-box/          the game's phone controller and TV view
public/manifest.webmanifest, sw.js, icons/   installable phone app
test/*.js                        protocol, reconnect, seeds, dealer, personal suites
test/e2e-browser.js              full browser run (npm run test:e2e)
run-tests.js                     runs every suite (npm test)
```

## Make it yours

**Prompts** — 276 in the pool, across twelve categories. They come from two places:

- **`prompts.js`** — 185 hand-written. Delete a line to cut one, copy a line to add one; keep the double quotes and the trailing comma. Write the blank as `______`.
- **`templates.js`** — 12 frames that expand into 91 more at boot. A frame like `"{X} would like a word about ______"` with eight fillers gives you eight prompts, because the frame carries the joke and the noun just changes the flavour.

**Dropping a category:** comment out one line in `ACTIVE` at the bottom of `prompts.js`. Playing with your in-laws and want religion gone? `//` in front of `RELIGION` and it's out for the night.

**On religion, politics and money:** these aim at the machinery, never at a side. Corruption, hypocrisy, fundraising, spin and bureaucracy are funny to everyone in the room; "your team is stupid" is only funny to half of it. Brutal doesn't mean partisan. No real names anywhere, deliberately — named targets date fast and start arguments instead of jokes.

**Timers** — the `TIMERS` object near the top of `games/party-box/logic.js`: `PICKING` (12s), `WRITING` (60s), `VOTING` (25s), `RESULTS` (12s), all in seconds. You can also override them without editing the file — `T_PICKING`, `T_WRITING`, `T_VOTING`, `T_RESULTS`, e.g. `T_WRITING=90 npm start`.

**Length, scoring, player cap** — `ROUNDS`, `POINTS_PER_VOTE` and `MAX_PLAYERS`, same spot.

## Adding the other game modes

Each game is two halves, and the core never needs to change:

1. **Server:** `games/<type>/logic.js` exports `{ type, title, maxPlayers, audience, create(ctx) }`. The game keeps its own state, handles messages in `onMessage(actor, opcode, payload)`, and describes what each screen should see in `views()` — `room`, `audience`, `host`, and one private view per player. After any change it calls `ctx.sync()`. Register it in `games/index.js`.
2. **Browser:** `public/games/<type>/controller.js` (the phone) and `public/games/<type>/tv.js` (the TV). The shells load them on demand from the game type the server reports, so a phone only ever downloads the game it's playing.

To add something like Fibbage: copy `games/party-box`, give the room a `truth`, have `WRITING` collect lies, mix the truth into the voting `choices`, and score for fooling people and for finding the truth. Then have the TV pass `?game=<type>` when creating a room (`/host?game=<type>`), or add a picker.

## Realtime protocol

```
GET  /rooms/:code   -> { exists, game, title, phase, joinable, full, inProgress, audience, players, maxPlayers }
POST /rooms         -> { code, hostSecret }                         (the TV)
WS   /rooms/:code/play?role=player|audience|host&name=…&user-id=…
```

- **Lookup first.** The phone asks `GET /rooms/:code` as soon as four letters are typed and only opens the WebSocket on Join.
- **Identity in the URL.** `user-id` is a UUID made once per device and kept in localStorage. Duplicate names get a number (`MIKE` → `MIKE2`). The one thing *not* in the URL is the reconnect secret — URLs end up in proxy logs — so the first frame is `hello { secret }`.
- **Envelope.** Every server frame is `{ seq, opcode, payload }`. `seq` goes up by one per frame on each connection, starting from the welcome; a client that ever sees a gap asks for `resync` and gets a fresh snapshot. (Counting per connection rather than per room means a private message to one phone doesn't look like a gap to every other phone.)
- **Welcome = full snapshot.** `welcome` carries your seat id, your secret, `reconnect: true|false`, who's `here` (with roles), the server clock, and every entity you're allowed to see.
- **Entities.** State travels as whole JSON entities with versions: `room` and `audience` (shared), `host` (TV only), `player:<user-id>` and `audience:<user-id>` (that one device only). Each update resends the whole entity with `version + 1`, and clients ignore anything not newer than what they hold. The game never sends anything itself — it calls `ctx.sync()` and the core sends only the entities that changed, only to the clients allowed to see them. That rule lives in one function (`canSee` in `server/core.js`).
- **Requests.** Client frames are `{ opcode, payload, rid }`; the server answers `reply { rid, ok, error? }`. A refused request (not your turn, already voted, your own answer) comes back as `ok: false`.
- **Refusals** arrive as an `error { code, message }` frame (`seat-taken`, `room-not-found`, `room-full`, `in-progress`, `replaced`, `room-closed`…), then the socket closes with a 4000-range code (`4003` wrong secret, `4004` no such room, `4009` full / in progress, `4001` opened elsewhere, `4010` room closed). Clients reconnect automatically after an accidental drop, never after a refusal. The `error` frame is what counts: Render's proxy replaces custom close codes with `1006`, so a client that only looked at the code would retry a refusal forever.

## Reconnection

- **A player drops.** Their seat, name, score, answer and vote stay put. The TV shows them dimmed with "reconnecting…". Mid-game they keep the seat for 15 minutes; in the lobby, 90 seconds.
- **A brief blip** (screen lock, Wi-Fi to cellular) reconnects on its own with backoff. Both screens show a red "Reconnecting" bar meanwhile, and a phone that comes back from a locked screen checks its socket straight away instead of waiting for it to time out.
- **A reload** lands on a one-tap **Reconnect** card (if the room and seat still exist). The phone sends its saved secret, the server checks it, restores the seat and sends a fresh welcome with `reconnect: true`, and the phone draws the current phase directly — mid-pick, mid-answer (the half-typed draft is kept), after voting, whatever.
- **The same seat opened twice** (second tab, second phone): the newest wins and the older one shows "Open somewhere else" with a button to take it back.
- **The game doesn't wait for anyone who's gone.** Advancing early only counts connected players; the phase timer covers the rest.
- **The TV drops or reloads.** It reclaims the room automatically with its saved secret. The room survives 2 minutes without a TV; the game keeps running on server timers.

Covered by `test/reconnect.js` and the browser run.

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
