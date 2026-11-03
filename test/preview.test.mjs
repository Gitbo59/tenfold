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
ok(ranked.ok && ranked.name === "Preview Player" && ranked.rating === 1200, "dummy account can access ranked profile and starts at the default rating");

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
