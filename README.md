# Tenfold

A multiplayer top-ten guessing game for Cloudflare. Pick any topic, an AI builds the ranked top ten, then players take turns guessing. Every miss costs a life.

Built as a single **Cloudflare Worker with static assets**, one **Durable Object per game room** (live play over WebSockets) and one small global Durable Object that enforces the free-tier budget. **Workers AI** builds the lists by default, so there is no API key and nothing to pay for. No build step, no framework.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:8787 (real AI and sign-in; see the next section for an offline version)
```

Workers AI always runs against your real Cloudflare account, even in local dev. `wrangler dev` will ask you to log in (`npx wrangler login`), and test lists use the same daily free allowance as the live site. Open two browser windows (one private) to play against yourself.

## Previewing your changes in VS Code

The site has no build step, so previewing is just "save, then refresh". The easiest way to start is the **offline preview**, which fakes the AI and the Google/GitHub/Discord sign-in so you need no accounts, keys or internet:

1. Open the project folder in VS Code and open a terminal (Terminal > New Terminal).
2. First time only: `npm install`.
3. Run `npm run dev:offline`. After a few seconds it prints `Preview ready: http://localhost:8787`.
4. Open that address, either in your browser (Ctrl+click the link in the terminal) or inside VS Code: press Ctrl+Shift+P, choose **Simple Browser: Show**, and paste the address.
5. Edit anything in `public/` (pages, styles, scripts), save, and refresh the browser. If a change doesn't show, do a hard refresh (Ctrl+Shift+R), or tick "Disable cache" in the browser's DevTools Network tab while you work. Edits in `src/` restart the server by itself.
6. To see a phone layout, open DevTools (F12) and toggle the device toolbar (Ctrl+Shift+M).
7. To be two players (friends, ranked, rooms), use two browser windows, one of them private. "Continue with Test provider" opens a fake sign-in page where you type any name, and the same name always gives you the same account.
8. Everything you create is kept in the `.wrangler-dev` folder. Stop the preview with Ctrl+C and delete that folder to start from scratch.

In this mode every topic returns the same fake list (the NATO alphabet), username changes have no cooldown, and everything else uses the real timings (30 seconds an answer in the daily challenge, 20 in ranked). To preview with the **real AI and real sign-in** instead, use `npm run dev`: it needs `npx wrangler login`, a `.dev.vars` file (see `.dev.vars.example`), and OAuth apps registered with `http://localhost:8787/api/auth/<provider>/callback` as the callback. If the preview won't start, another program may be using ports 8787, 9998 or 9999.

To check you haven't broken anything, run `npm test`.

## Deploy

```bash
npx wrangler login
npm run deploy
```

That's it: the AI is a binding, so there are no secrets to set. You get a `*.workers.dev` URL; add a custom domain under Workers & Pages > your Worker > Settings > Domains & Routes. To deploy from Git instead, connect the repo under Workers & Pages > Create > Import a repository and keep the defaults.

> Why not Pages? Pages Functions can't host Durable Objects, which are what make live rooms simple. A Worker with static assets does everything Pages does.

## How the game works

1. One player creates a room and shares the code or invite link (up to 8 players).
2. The host sets **lives**, the **time limit** (on or off, 5 to 120 seconds a turn), the **list difficulty** (Easy or Hard) and how many **hints** the round allows (0 to 5).
3. The host types a topic, taps a suggestion, or picks a built-in list. Answers stay on the server until they're found, so nobody can peek in dev tools.
4. Players take turns. A right guess reveals the answer for everyone. A wrong guess, or running out of time, costs a life. At zero lives you're out.
5. The round ends when the board is cleared or everyone is out. The last player standing keeps guessing until they run out of lives or finish the board.

### Easy and Hard

The difficulty changes how the AI builds the list. **Easy** reads the topic in its most mainstream sense, so every answer is something a general audience knows. **Hard** looks for a less obvious ranking measure or narrower scope, so ranks 5 to 10 take real thought. Hard lists must still be verifiable. The topic suggestions ("Surprise me" and the chips) switch with the difficulty too.

### Hints

Anyone still in the game can vote for a hint, and can withdraw the vote. When **every active, connected player** has voted, a clue appears on the board for the easiest answer not yet found: how many letters (and words) it has and what it starts with. Players who are out or disconnected don't block the vote. The host chooses 0 to 5 hints per round.

### Reporting and sources

- **Report** appears on every revealed answer: "this answer isn't correct" or "it's in the wrong place". The flag is shown to the whole room.
- Tap a wrong guess under **Already tried** to report a guess that should have counted (a missing alias).
- **Where reports go:** into the global Quota Durable Object's database (the last 1,000 are kept, with the topic, difficulty, answer, rank and the reason). Nothing is emailed and there is no dashboard page: you read them with the owner endpoint below. Each report also flags the answer for everyone in that room. Once **two different connections** flag the same AI list, the cached copy is deleted so nobody is served it again.
- **Show source** reveals where the ranking is normally checked, with a "Search to verify" link. Opening it during a round is announced in the game feed (once per player) so nobody quietly looks answers up, and it is never remembered between games. For AI lists the source is the model's suggestion and is labelled *not verified*, because models can name pages that don't exist. Built-in lists show the Wikipedia article they were compiled from. After a game the source is always shown.

### Scoring

| Event | Points |
| --- | --- |
| Finding the answer at rank N | 11 minus N: 1st place is worth 10, 10th place is worth 1 |
| Quick-fire bonus (time limit on) | 0 to 3, depending on how much of your clock was left |
| Streak bonus | +1 per consecutive find, up to +3 |
| Completing the whole board | +5 |
| Each life left at the end | +2 |

**Close answers count.** Capitalisation, accents, "the" and punctuation are ignored. Small typos are accepted (longer answers allow more). A partial name counts when it points to one answer: "Everest" for "Mount Everest", "Parbat" for "Nanga Parbat", "Lake Victoria" for "Victoria". It doesn't count when it could mean two answers ("Kane" with both Harry Kane and Kane Williamson on the list), when it is only a filler word ("Lake", "United", "New"), or when it contains a second name ("Chad Kenya"), so nobody can hedge. When a typo or partial name is accepted, the feed shows what was typed. The AI also supplies aliases. Re-guessing something already found, or a wrong answer someone already tried, is free. If a player disconnects, their turn is skipped without penalty, and they can rejoin from the same tab.

## The two sides of the site

A pill at the top centre switches between them (it hides while you're inside a game room):

- **For fun** is the home page: the original room-based game with friends, no account needed.
- **Ranked** needs a sign-in. Once you're in, the Ranked page is a hub with:
  - **Your profile:** your picture, display name and rating, with peak rating, games played, win rate, won-lost-drawn record, your current streak, your place on the ladder and a small chart of your last 20 ratings.
  - **Ranked match:** the queue button, and a short "how ranked works" panel.
  - **Recent ranked games:** each opponent (with their picture and rating), the result, how many points you gained or lost, your rating afterwards, the list that was played and how it ended.
  - **Daily challenge:** today's status (not started, in progress, or your score and place), a button to play, and the daily and monthly leaderboards.
  - **Friends:** add a friend by username, accept or decline requests, and see what your friends are up to (looking for a match, or in one).
  - **Ranked ladder:** the top 20 by rating, with your own row added if you're further down.

Clicking your picture or name on the hub opens **your profile** (`#/me`), and clicking anyone else's name anywhere (ladder, leaderboards, recent games, friends) opens **their profile** (`#/u/Username`).

**Profile pictures** are chosen from a fixed set: 12 colours and 12 pictures (stable defaults are assigned until you pick). They are stored as two small numbers, never as photos or links to photos. That is deliberate: sign-in providers' profile photos are personal data, and keeping them out of your database fits the "nothing sensitive to look after" design. If you later want provider photos, they could be added as an opt-in (GitHub and Discord already send an avatar link in the sign-in response, Google needs an extra permission), but you would then be storing a link to someone's photo.

## Daily challenge (competitive mode)

The **Daily challenge** is solo and ranked. It's reached from the Ranked hub:

- One list a day, the same for everyone, starting at 00:00 UTC. The list is built ahead of time (a scheduled job at 03:15 UTC makes sure the next three days exist) so you can review it before anyone plays.
- Sign-in required, one attempt a day, three lives, 30 seconds per answer. The clock runs on the server and keeps running if you close the page.
- Score = (11 minus rank) x (1 + time bonus) x 10, so the top answer is worth 100 to 200 points and the 10th is worth 10 to 20. Ties go to the lower total time.
- Daily and monthly leaderboards (on the Ranked hub and on the challenge page), and a "Yesterday's answers" tab. Today's missed answers are never shown until the day ends, so nobody can pass them on.
- Quiet fair-play checks (see below), a rules and privacy page at `/rules`, and a free-to-enter design (nothing you can buy affects a score).

### How accounts work (and what you don't store)

There are **no passwords and no email addresses** anywhere. Players use "Sign in with Google / GitHub / Discord":

1. The player is sent to the provider, who checks who they are. We request the minimum permission (`openid` for Google, none for GitHub, `identify` for Discord), so the provider doesn't even send an email address.
2. The provider hands back an opaque user ID. We immediately turn it into a keyed one-way hash (HMAC-SHA256 with `ID_PEPPER`) and **only that hash is stored**, with the display name the player picks and their results.
3. A random session token (stored hashed) is put in an HttpOnly, SameSite=Lax cookie, valid for 30 days.

Sign-in uses the authorisation-code flow with PKCE and a signed, short-lived state cookie. Every request that changes data must come from your own pages (an Origin check).

This greatly reduces your risk (nothing to leak or reset, no password handling), but it does **not** remove your responsibilities. A hashed ID plus a display name and play history is still personal data under UK data protection law, so you remain the data controller. What helps: the privacy notice at `/rules` (fill in the brackets and have it checked), the in-page "Delete my account" button (erases everything straight away), 60-day retention of per-answer details, and never storing raw IP addresses. You may also need to register with the ICO and pay its data protection fee unless you're exempt: their online self-assessment tells you.

### Setting it up

1. Generate a secret and store it:
   ```bash
   npx wrangler secret put AUTH_SECRET        # paste the output of: openssl rand -hex 32
   ```
   (Optionally also `ID_PEPPER`. It defaults to `AUTH_SECRET`. Changing `AUTH_SECRET` signs everyone out. Changing `ID_PEPPER` orphans every account, so don't.)
2. Register an OAuth app with at least one provider and set its callback URL to `https://YOUR-SITE/api/auth/<provider>/callback` (use `http://localhost:8787/...` for local dev):

   | Provider | Where to register | Secrets to set |
   | --- | --- | --- |
   | GitHub | Settings > Developer settings > OAuth Apps | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
   | Google | Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
   | Discord | Discord Developer Portal > Applications > OAuth2 | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |

   Set each with `npx wrangler secret put NAME`. A provider appears on the sign-in panel only once both of its values are set. GitHub is the quickest to try.
3. Edit `public/rules.html`: fill in the bracketed parts (your name, address, contact email, prize terms) and remove the draft box.
4. Deploy, then do one real sign-in with each provider you enabled. The provider endpoints are the standard published ones, but they can only be tested against the real services once deployed.

### Fair play, in practice

Each answer is submitted with a few facts about how it was entered: pasted or typed, key presses, how fast it appeared, and whether the tab was in the background just before. Server-side rules turn that into a small risk score (a paste adds 2, text appearing with no typing adds 2, superhuman typing adds 2, answering right after leaving the tab adds 1, an instant answer to a hard rank adds 1, a flawless and very fast run adds 2). At **4 or more** the attempt is held off the public boards for review. Players never see any of this, and a single paste on its own doesn't hold anyone (password managers and autofill look like that).

Review is yours to do. These calls use your `ADMIN_TOKEN` (see "Watching it"):

```bash
# who is held, with their flags, and how many accounts share a connection
curl -H "Authorization: Bearer $TOKEN" "https://YOUR-SITE/api/admin/attempts?date=2026-10-12"
# every guess of one attempt with its signals
curl -H "Authorization: Bearer $TOKEN" "https://YOUR-SITE/api/admin/guesses?attempt=17"
# clear (shows on the board), hold, or void (removed) an attempt
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"id":17,"action":"clear"}' https://YOUR-SITE/api/admin/attempt
# look at, replace, or cancel a day's list
curl -H "Authorization: Bearer $TOKEN" "https://YOUR-SITE/api/admin/daily?date=2026-10-13"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"date":"2026-10-13","list":{"title":"...","basis":"...","source":"...","answers":[{"answer":"...","aliases":[]}, ...10 in total]}}' https://YOUR-SITE/api/admin/daily
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"date":"2026-10-13","void":true}' https://YOUR-SITE/api/admin/daily/void
# stop a player
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"name":"SomeName"}' https://YOUR-SITE/api/admin/ban
```

None of this stops someone who looks answers up and types them naturally. It makes lazy cheating (pasting, scripts, tab-hopping) visible, and holds suspicious results until a person looks. Keep prizes modest, and verify any winner before paying out (see the rules page).

Free-tier note: building the daily list is reserved separately (up to 6 AI requests a day, even if players have used up the public allowance), so the worst case is about 36 requests, roughly 9,700 neurons, still under the 10,000 daily free allowance.

## Ranked 1v1

A third mode, separate from the friends rooms and from the daily challenge. It has its own rating and ladder, and nothing in it affects the daily or monthly leaderboards.

- **Queue:** sign in, press **Find a match**, and the matchmaker pairs you with someone waiting at a similar rating. It starts looking within 100 rating points and widens by 15 points a second the longer you wait (up to 1,500), so nobody waits forever for a perfect match. The same two accounts can't be paired more than twice in 24 hours, which stops two accounts trading wins.
- **Rules are fixed:** 3 lives, 20 seconds an answer, no hints, one shared board, and the same scoring as friends rooms. Score more than your opponent to win. If they run out of lives while you're ahead, the match ends immediately. Source lookups are disabled until it's over.
- **Rating:** Elo. Everyone starts at 1200, and after each match your rating moves by K x (result minus expected result). The expected result comes from the rating gap, so beating a higher-rated player earns much more than beating a lower-rated one, and losing to a weaker player costs more. K is 40 for your first 20 games and 20 after that, and ratings never go below 100. A draw (equal scores) counts as half a win. This is the classic Elo formula. chess.com uses Glicko, which tracks a separate "rating deviation" per player; that would be a possible later upgrade.
- **Leaving:** resigning is a loss. A disconnect gets 60 seconds to reconnect (refreshing the page is fine) before it counts as a forfeit. If someone never connects at all, the match is cancelled and nobody's rating changes.
- **Ladder:** the top 20 by rating on the Ranked page, with your own row added if you're lower. Players appear after 3 rated games, and a `?` marks a still-provisional rating (under 20 games).
- **Security:** a ranked room only lets in the two matched accounts, identified by their login cookie, and shows names from their accounts, so nobody can claim to be someone else.
- **Fair play:** answers carry the same quiet typing signals as the daily challenge (plus a small flag for any answer sent without them, which means someone is calling the API directly). They're stored with the match for you to review and never shown to players. Ratings still apply when a match is flagged; you void a match if you confirm cheating.
- **Cost:** a match uses no AI requests. Lists come from the built-in lists, past daily lists, and a pool that the scheduled job tops up by 2 a day (to 60). To fill the pool faster, run the seed call below. It uses the same small reserve as the daily list.
- **No bots:** matchmaking only works while two people are searching at once. On a quiet site many people will wait without a match, so announce "ranked hours" or run the friends mode alongside until you have more players.

Owner tools for ranked (same `ADMIN_TOKEN` as above):

```bash
# recent matches: players, result, rating changes, fair-play risk and flags
curl -H "Authorization: Bearer $TOKEN" "https://YOUR-SITE/api/admin/matches"
# undo one match's rating changes (after confirming cheating). Use the id from the list above.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"id":"MATCH_ID"}' https://YOUR-SITE/api/admin/match/void
# set a rating by hand (support cases)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"name":"SomeName","rating":1300}' https://YOUR-SITE/api/admin/rating
# fill the ranked list pool now (up to 10 at a time) or add your own list
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"count":6}' https://YOUR-SITE/api/admin/pool/seed
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Origin: https://YOUR-SITE" -d '{"list":{"title":"...","basis":"...","source":"...","answers":[{"answer":"...","aliases":[]}, ...10 in total]}}' https://YOUR-SITE/api/admin/pool
```

Free-tier note: while someone waits in the queue their page asks the server for an update every 1.5 seconds, about 40 requests a minute. Worker requests are free up to 100,000 a day, so that's roughly 2,500 waiting-minutes a day across everyone. Deleting an account removes its rating and match history. The privacy section of `/rules` covers this.

## Profiles, friends and linked accounts

**Your profile screen** (`#/me`) holds everything you can configure, plus **Sign out** and **Delete my account** (they live only here now):

- **Username:** globally unique, ignoring case, 3 to 16 letters, numbers, spaces, hyphens or underscores. It's the same name that shows on leaderboards and in matches, and what friends search for. The first one is free to set; after you change it there's a cooldown (7 days, set by `NAME_CHANGE_DAYS`) so names can't be swapped to confuse people. Releasing a name lets someone else claim it.
- **Profile picture:** the colour and picture editor.
- **Linked accounts:** every way you can sign in to the account. You can link a second provider (Google, GitHub, Discord) so any of them gets you into the same account, and unlink one at any time as long as at least one remains. Linking uses the same callback addresses you already registered for sign-in, so there's nothing new to set up with the providers. An account can't be merged with another one: if a provider account is already used elsewhere, linking is refused with an explanation. Accounts created before linking existed show their first method as "Original sign-in" until they next sign in.
- **Privacy:** turn friend requests off, and choose whether your full profile (stats and recent games) is public or friends-only. Everyone can always see your username, picture and rating.

**Friends:** send a request by username from the hub's Friends card or from someone's profile page. They can accept or decline; you can cancel a request you sent, and remove a friend at any time. If two people ask each other it becomes a friendship straight away. A declined request is quietly remembered for a week so the same person can't keep re-sending it, and the person who declined isn't told anything. Limits: 25 pending requests and 100 friends each.

**Other people's profiles** show their picture, username, rating, ladder position, member-since month, record, streak, rating trend and last five ranked games. Linked accounts and anything else private are never shown. A player with a friends-only profile shows strangers only their username, picture and rating.

Deleting an account removes its username, rating, matches, daily results, linked sign-in methods and every friendship and request.

## Staying inside the free tier

**The one rule: keep the account on the Workers Free plan.** On Free there is no billing at all. When a daily limit is reached, calls simply fail until 00:00 UTC. If you upgrade to Workers Paid, or use paid AI providers, things *can* cost money (Workers AI beyond the free 10,000 neurons/day is $0.011 per 1,000).

| Free limit (per day) | How Tenfold stays under it |
| --- | --- |
| Workers AI: 10,000 neurons | Default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Output is capped at 1,200 tokens, so one request costs at most about 270 neurons (typically about 180). A global cap of **30 requests/day** keeps the worst case near 8,000, leaving room for testing. Every model call is counted, including retries. |
| Repeat topics | Generated lists are cached for 30 days by topic and difficulty. A cache hit costs **zero** neurons. A room replaying its own topic gets a fresh list when budget allows, otherwise the saved one. |
| Individual abuse | 4 new AI lists per connection per day, 5 per room, 10 rooms per connection per hour. Connections are identified by a salted hash, never a stored IP. |
| When the allowance is gone | Six **built-in lists** need no AI and always work, and cached topics still start. The lobby shows how many AI lists are left. |
| Durable Objects: 13,000 GB-s duration | Open WebSockets keep a room awake. Rooms with **no activity for 15 minutes** have their sockets closed (a quiet player can rejoin with one tap, nothing is lost). 13,000 GB-s is roughly 29 hours of occupied rooms a day. |
| Daily challenge database writes | Each finished attempt costs roughly 60 database row writes against the 100,000-a-day free limit, so on the order of a thousand players a day (a rough estimate). Past that, the daily challenge pauses until midnight UTC and nothing is billed. |
| Durable Objects: 100,000 requests, 100,000 row writes | WebSocket messages count 20:1, and a game uses a few hundred writes, so this comfortably covers hundreds of games a day (my estimate). |

All of the numbers above are variables in `wrangler.jsonc`. If you change the model, check its neuron price on Cloudflare's Workers AI pricing page and adjust `DAILY_GENERATION_CAP` so that `cap x (about 270 neurons)` stays under 10,000. Some models (DeepSeek V4, Kimi, GLM 5.2 at the time of writing) need a paid plan: don't use those. The model must also support JSON mode.

### Watching it

Set an owner token and you can check usage and read player reports (newest first, last 100):

```bash
npx wrangler secret put ADMIN_TOKEN
curl -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-SITE/api/admin/stats
curl -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-SITE/api/admin/reports
```

Without the token those endpoints don't exist. Cloudflare's dashboard also shows Workers AI neuron usage.

### Other AI providers (optional, may cost money)

Set `AI_PROVIDER` in `wrangler.jsonc`:

| Provider | Variables |
| --- | --- |
| `workers-ai` (default, free) | `AI_MODEL` optional |
| `openai` (any OpenAI-compatible API such as Groq, GitHub Models, OpenRouter, Mistral) | `AI_BASE_URL`, `AI_MODEL`, and the secret `AI_API_KEY` |
| `anthropic` | secret `ANTHROPIC_API_KEY`, `AI_MODEL` optional (default `claude-sonnet-5-5`) |

The caps above still apply, but they count requests, not money, so set a spend limit with that provider.

## Tests

```bash
npm test
```

Starts a local copy of the app with a fake AI server (no login, no spend) and runs: game rules, the new features (hints, reports, difficulty, cache, budget caps), the daily challenge (sign-in handshake, scoring, the clock, fair-play holds, leaderboards, deletion), ranked 1v1 (queue, rating-gap matching, upset vs expected rating changes, forfeits, no-shows, safeguards), the rating maths, simulated-browser passes for each mode, the idle disconnect, answer matching, and the AI module (including the Workers AI response formats). The real Workers AI binding can't run offline, so it is covered by a stand-in; do one real round after deploying.

## Project layout

```
public/            Static front end (index.html, style.css, app.js, daily.js, ranked.js, profile.js, rules.html)
src/index.ts       Worker: routes, per-connection hashing, room-creation limit, admin
src/room.ts        Durable Object per room: lobby, turns, timers, hints, reports, scoring
src/quota.ts       Global Durable Object: AI budget, limits, list cache, report log
src/arena.ts       Global Durable Object: accounts, daily list, timed attempts, leaderboards, review
src/auth.ts        Sign in with Google/GitHub/Discord (OAuth + PKCE), cookies, hashed IDs
src/anticheat.ts   The quiet fair-play rules
src/elo.ts         Elo rating maths for ranked
src/daily-topics.ts  The rotation of daily topics
src/ai.ts          Workers AI / OpenAI-compatible / Anthropic calls, prompts, validation
src/classics.ts    Built-in lists (no AI)
src/match.ts       Guess normalisation and typo-tolerant matching
test/              Test suites and the fake AI server
wrangler.jsonc     Cloudflare config (all the limits live here)
```

Rooms persist in Durable Object storage, so a refresh or dropped connection doesn't lose a game. Idle rooms delete themselves after about six hours.

"Tenfold" is a working title; the name lives in `public/index.html` and `public/favicon.svg`.
