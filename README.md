# Tenfold

A multiplayer top-ten guessing game for Cloudflare. Pick any topic, an AI builds the ranked top ten, then players take turns guessing. Every miss costs a life.

Built as a single **Cloudflare Worker with static assets** plus one **Durable Object per room** (real-time play over WebSockets). No build step, no framework.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars      # then put your Anthropic API key in it
npm run dev                         # http://localhost:8787
```

Open the page in two browser windows (use a private window for the second) to play against yourself.

## Deploy

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

You'll get a `*.workers.dev` URL. Add a custom domain under Workers & Pages > your Worker > Settings > Domains & Routes.

**Deploying from Git instead:** connect the repo under Workers & Pages > Create > Import a repository, keep the defaults (deploy command `npx wrangler deploy`), then add `ANTHROPIC_API_KEY` as a secret in the Worker's settings.

> Why not Pages? Pages Functions can't host Durable Objects, which are what make live multiplayer rooms simple. Workers with static assets does everything Pages does and is where Cloudflare now recommends starting new projects.

## How the game works

1. One player creates a room and shares the code or invite link (up to 8 players).
2. The host sets **lives**, switches the **time limit** on or off, and chooses the **seconds per turn** (5 to 120).
3. The host types a topic. The server asks the AI for a ranked top ten and the game starts. Answers stay on the server until they're found, so nobody can peek in dev tools.
4. Players take turns. A right guess reveals the answer for everyone. A wrong guess, or running out of time, costs a life. At zero lives you're out.
5. The round ends when the board is cleared or everyone is out. The last player standing keeps guessing until they run out of lives or finish the board.

### Scoring

| Event | Points |
| --- | --- |
| Finding the answer at rank N | N (so 10th place is worth 10) |
| Quick-fire bonus (time limit on) | 0 to 3, depending on how much of your clock was left |
| Streak bonus | +1 per consecutive find, up to +3 |
| Completing the whole board | +5 |
| Each life left at the end | +2 |

Guessing is forgiving: capitalisation, accents, "the", punctuation and small typos are ignored, and the AI supplies aliases ("USA", "United States of America"). Re-guessing something already found, or a wrong answer someone already tried, is free.

If a player disconnects, their turn is skipped without penalty after the clock runs out (or after 20 seconds when the time limit is off). They can rejoin with the same tab and keep their seat.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret (`wrangler secret put`) | required |
| `AI_MODEL` | `wrangler.jsonc` vars | `claude-sonnet-5-5` (try `claude-haiku-5-5` for faster, cheaper lists) |
| `AI_BASE_URL` | `wrangler.jsonc` vars | Anthropic API; set to a Cloudflare AI Gateway URL for caching and logs |
| Game constants | top of `src/room.ts` | 8 players, 10 topic generations per room, bonus values |

## Protect your API bill

Each topic is one AI request. The code limits a room to 10 generations, but anyone can create rooms, so before sharing the URL widely:

- Add a Cloudflare **rate limiting rule** for `POST /api/rooms` (Security > WAF > Rate limiting rules).
- Put the AI calls behind **AI Gateway** (set `AI_BASE_URL`) and set a spend limit on your Anthropic key.
- Optionally add Cloudflare Turnstile to room creation.

## Project layout

```
public/          Static front end (index.html, style.css, app.js)
src/index.ts     Worker: routes /api/rooms and /ws/:code to the right room
src/room.ts      Durable Object: lobby, turns, timers, scoring, persistence
src/ai.ts        Anthropic request, structured output and validation
src/match.ts     Guess normalisation and typo-tolerant matching
wrangler.jsonc   Cloudflare config
```

Rooms persist their state in Durable Object storage, so a refresh or dropped connection doesn't lose the game. Idle rooms delete themselves after about six hours.

"Tenfold" is a working title; the name lives in `public/index.html` (title and brand) and `public/favicon.svg`.
