const BASE = "http://localhost:8787";
let failures = 0;
const ok = (condition, message) => {
  console.log(condition ? "  PASS" : "  FAIL", message);
  if (!condition) failures++;
};

const first = await fetch(`${BASE}/api/me`);
const me = await first.json();
const cookie = first.headers.getSetCookie().find((value) => value.startsWith("tf_session="));
ok(me.signedIn && me.name === "Preview Player", "preview automatically signs in as the named dummy account");
ok(!!cookie && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), "preview session uses the normal protected session cookie");

const session = cookie?.split(";")[0] ?? "";
const headers = { cookie: session };
const ranked = await (await fetch(`${BASE}/api/ranked/me`, { headers })).json();
ok(ranked.ok && ranked.name === "Preview Player" && ranked.games === 8 && ranked.wins === 5 && ranked.losses === 2 && ranked.draws === 1, "dummy account has a seeded ranked record");
ok(ranked.ladder.rows.some((row) => row.name === "Avery Demo") && ranked.rank !== null, "preview rivals populate the ranked ladder");

const history = await (await fetch(`${BASE}/api/ranked/history`, { headers })).json();
ok(history.ok && history.rows.length === 8 && history.rows.some((row) => row.result === "win") && history.rows.some((row) => row.result === "loss"), "ranked match history includes varied results");

const friends = await (await fetch(`${BASE}/api/friends`, { headers })).json();
ok(friends.ok && friends.friends.length === 5 && friends.incoming.length === 1 && friends.outgoing.length === 1, "preview friends, incoming requests, and outgoing requests are populated");

const todayBoard = await (await fetch(`${BASE}/api/daily/leaderboard?scope=today`, { headers })).json();
ok(todayBoard.ok && todayBoard.rows.length >= 6 && todayBoard.rows.every((row) => row.name.endsWith("Demo")), "today's daily leaderboard contains synthetic players");
const monthBoard = await (await fetch(`${BASE}/api/daily/leaderboard?scope=month`, { headers })).json();
const dayOfMonth = new Date().getUTCDate();
ok(monthBoard.ok && monthBoard.rows.some((row) => row.name.endsWith("Demo")), "monthly daily leaderboard contains preview results");
ok(dayOfMonth === 1 || monthBoard.rows.some((row) => row.name === "Preview Player"), "previous daily results include Preview Player in the monthly leaderboard");

const dailyStart = await fetch(`${BASE}/api/daily/start`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json", Origin: BASE },
  body: "{}",
});
ok((await dailyStart.json()).status === "playing", "seeded leaderboard data leaves Preview Player's daily attempt available");

const queue = await fetch(`${BASE}/api/ranked/queue`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json", Origin: BASE },
  body: "{}",
});
const waiting = await queue.json();
ok(waiting.ok && waiting.status === "waiting", "dummy account can enter ranked matchmaking");

const leave = await fetch(`${BASE}/api/ranked/leave`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json", Origin: BASE },
  body: "{}",
});
ok((await leave.json()).status === "idle", "dummy account can leave the ranked queue");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nPREVIEW LOGIN CHECKS PASSED");
process.exit(failures ? 1 : 0);
