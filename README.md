# Tenfold

A multiplayer top-ten guessing game for Cloudflare. Pick any topic, an AI builds the ranked top ten, then players take turns guessing. Every miss costs a life.

Built as a single **Cloudflare Worker with static assets**, one **Durable Object per game room** (live play over WebSockets) and one small global Durable Object that enforces the free-tier budget. **Workers AI** builds the lists by default, so there is no API key and nothing to pay for. No build step, no framework.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:8787
```

Workers AI always runs against your real Cloudflare account, even in local dev. `wrangler dev` will ask you to log in (`npx wrangler login`), and test lists use the same daily free allowance as the live site. Open two browser windows (one private) to play against yourself.

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
- Reports are stored for you. Once **two different connections** flag the same AI list, the cached copy is deleted so nobody is served it again.
- **Show source** reveals where the ranking is normally checked, with a "Search to verify" link. For AI lists the source is the model's suggestion and is labelled *not verified*, because models can name pages that don't exist. Built-in lists show the Wikipedia article they were compiled from. After a game the source is always shown.

### Scoring

| Event | Points |
| --- | --- |
| Finding the answer at rank N | N (so 10th place is worth 10) |
| Quick-fire bonus (time limit on) | 0 to 3, depending on how much of your clock was left |
| Streak bonus | +1 per consecutive find, up to +3 |
| Completing the whole board | +5 |
| Each life left at the end | +2 |

Guessing is forgiving: capitalisation, accents, "the", punctuation and small typos are ignored, and the AI supplies aliases. Re-guessing something already found, or a wrong answer someone already tried, is free. If a player disconnects, their turn is skipped without penalty, and they can rejoin from the same tab.

## Staying inside the free tier

**The one rule: keep the account on the Workers Free plan.** On Free there is no billing at all. When a daily limit is reached, calls simply fail until 00:00 UTC. If you upgrade to Workers Paid, or use paid AI providers, things *can* cost money (Workers AI beyond the free 10,000 neurons/day is $0.011 per 1,000).

| Free limit (per day) | How Tenfold stays under it |
| --- | --- |
| Workers AI: 10,000 neurons | Default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Output is capped at 1,200 tokens, so one request costs at most about 270 neurons (typically about 180). A global cap of **30 requests/day** keeps the worst case near 8,000, leaving room for testing. Every model call is counted, including retries. |
| Repeat topics | Generated lists are cached for 30 days by topic and difficulty. A cache hit costs **zero** neurons. A room replaying its own topic gets a fresh list when budget allows, otherwise the saved one. |
| Individual abuse | 4 new AI lists per connection per day, 5 per room, 10 rooms per connection per hour. Connections are identified by a salted hash, never a stored IP. |
| When the allowance is gone | Six **built-in lists** need no AI and always work, and cached topics still start. The lobby shows how many AI lists are left. |
| Durable Objects: 13,000 GB-s duration | Open WebSockets keep a room awake. Rooms with **no activity for 15 minutes** have their sockets closed (a quiet player can rejoin with one tap, nothing is lost). 13,000 GB-s is roughly 29 hours of occupied rooms a day. |
| Durable Objects: 100,000 requests, 100,000 row writes | WebSocket messages count 20:1, and a game uses a few hundred writes, so this comfortably covers hundreds of games a day (my estimate). |

All of the numbers above are variables in `wrangler.jsonc`. If you change the model, check its neuron price on Cloudflare's Workers AI pricing page and adjust `DAILY_GENERATION_CAP` so that `cap x (about 270 neurons)` stays under 10,000. Some models (DeepSeek V4, Kimi, GLM 5.2 at the time of writing) need a paid plan: don't use those. The model must also support JSON mode.

### Watching it

Set an owner token and you can check usage and read player reports:

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

Starts a local copy of the app with a fake AI server (no login, no spend) and runs: game rules, the new features (hints, reports, difficulty, cache, budget caps), a simulated-browser UI pass, the idle disconnect, and the AI module (including the Workers AI response formats). The real Workers AI binding can't run offline, so it is covered by a stand-in; do one real round after deploying.

## Project layout

```
public/            Static front end (index.html, style.css, app.js)
src/index.ts       Worker: routes, per-connection hashing, room-creation limit, admin
src/room.ts        Durable Object per room: lobby, turns, timers, hints, reports, scoring
src/quota.ts       Global Durable Object: AI budget, limits, list cache, report log
src/ai.ts          Workers AI / OpenAI-compatible / Anthropic calls, prompts, validation
src/classics.ts    Built-in lists (no AI)
src/match.ts       Guess normalisation and typo-tolerant matching
test/              Test suites and the fake AI server
wrangler.jsonc     Cloudflare config (all the limits live here)
```

Rooms persist in Durable Object storage, so a refresh or dropped connection doesn't lose a game. Idle rooms delete themselves after about six hours.

"Tenfold" is a working title; the name lives in `public/index.html` and `public/favicon.svg`.
