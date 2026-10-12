const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const ADMIN = { Authorization: "Bearer admintok", "content-type": "application/json", Origin: BASE };
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
const human = (len) => ({ paste: false, keys: len + 1, typeMs: len * 180 + 300, blurMs: 0, refocusMs: 99999 });
const aiCalls = async () => (await (await fetch("http://127.0.0.1:9999/count")).json()).calls;

/** A tiny browser: keeps cookies, follows the OAuth redirects by hand like a real browser would. */
class Browser {
  jar = new Map();
  async req(path, o = {}) {
    const headers = { ...(o.headers || {}) };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...o, headers });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === "" || /Max-Age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  async json(path, o) { const r = await this.req(path, o); const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {} return { status: r.status, text, ...j }; }
  post(path, body) { return this.json(path, { method: "POST", headers: { "content-type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) }); }
  async signIn(sub) {
    const s = await this.req("/api/auth/mock/start");
    const authUrl = s.headers.get("location");
    const a = await this.req(authUrl + "&as=" + encodeURIComponent(sub));
    const cb = await this.req(a.headers.get("location"));
    return { start: s, authUrl, callback: cb };
  }
  async player(sub, name) { await this.signIn(sub); const n = await this.post("/api/me/name", { name }); if (n.error) throw new Error("name: " + n.error); return this; }
  // paced like a person: the server limits each account to 4 guesses a second
  async guess(text, sig) { const r = await this.post("/api/daily/guess", { text, sig: sig ?? human(text.length) }); await sleep(300); return r; }
}

console.log("providers and sign-in handshake");
const anon = new Browser();
const pv = await anon.json("/api/auth/providers");
ok(pv.providers?.some((p) => p.id === "mock"), "configured providers are listed (only those with keys set)");
ok((await anon.json("/api/me")).signedIn === false && (await anon.json("/api/daily/state")).status === 401, "signed-out visitors can't see or play the daily challenge");
const alice = new Browser();
const h = await alice.signIn("alice-sub");
const loc = new URL(h.authUrl);
ok(loc.searchParams.get("code_challenge_method") === "S256" && loc.searchParams.get("scope") === "openid" && loc.searchParams.get("state").length > 10, "uses PKCE (S256), a random state, and the minimal 'openid' scope");
ok(!/email|profile/.test(h.authUrl), "never asks the provider for email or profile");
ok(h.start.headers.getSetCookie().some((c) => /^tf_oauth=/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), "the in-flight state is a signed, HttpOnly cookie");
ok(h.callback.status === 302 && h.callback.headers.get("location") === "/#/daily", "callback finishes by returning to the daily page");
const sc = h.callback.headers.getSetCookie().find((c) => /^tf_session=/.test(c));
ok(!!sc && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && !/Secure/i.test(sc), "session cookie is HttpOnly + SameSite=Lax (Secure is added automatically on HTTPS)");
const log = await (await fetch("http://127.0.0.1:9998/log")).json();
ok(log.token.at(-1).code_verifier && log.token.at(-1).client_secret === "mock-secret" && log.userinfo >= 1, "code exchange used the PKCE verifier and client secret; only the user-info call was made");
ok((await alice.json("/api/me")).signedIn === true && (await alice.json("/api/me")).name === null, "signed in, with no display name yet");

console.log("sign-in security");
const bad = new Browser();
const s1 = await bad.req("/api/auth/mock/start"); const u1 = new URL(s1.headers.get("location"));
const a1 = await bad.req(u1.toString() + "&as=mallory"); const cb1 = new URL(a1.headers.get("location"));
cb1.searchParams.set("state", "forged");
const forged = await bad.req(cb1.toString());
ok(/autherror=state/.test(forged.headers.get("location")) && !(forged.headers.getSetCookie() ?? []).some((c) => /^tf_session=[^;]+/.test(c)), "a forged state is rejected and no session is created");
const tamper = new Browser(); const s2 = await tamper.req("/api/auth/mock/start"); const a2 = await tamper.req(s2.headers.get("location") + "&as=mallory");
tamper.jar.set("tf_oauth", tamper.jar.get("tf_oauth").replace(/.$/, (c) => (c === "A" ? "B" : "A")));
ok(/autherror=state/.test((await tamper.req(a2.headers.get("location"))).headers.get("location")), "a tampered cookie signature is rejected");
ok(/autherror=state/.test((await new Browser().req(a2.headers.get("location"))).headers.get("location")), "a callback with no cookie is rejected");
ok((await new Browser().req("/api/auth/nope/start")).status === 404, "unknown providers 404");
const noOrigin = await alice.json("/api/me/name", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Alice A"}' });
ok(noOrigin.status === 403, "changing data without a same-origin header is refused (cross-site protection)");

console.log("display names");
ok((await alice.post("/api/daily/start")).error?.includes("display name"), "you can't play before choosing a name");
for (const bad of ["a", "<b>x</b>", "Admin", "x".repeat(30), "  "]) { const r = await alice.post("/api/me/name", { name: bad }); if (!r.error) ok(false, "accepted bad name " + bad); }
ok(true, "too-short, markup, reserved and too-long names are all refused");
ok((await alice.post("/api/me/name", { name: "Alice A" })).name === "Alice A", "a valid name is accepted");
const clash = await new Browser().signIn("other-sub").then(async () => 0).catch(() => 0);
const dup = new Browser(); await dup.signIn("dup-sub");
ok((await dup.post("/api/me/name", { name: "alice a" })).status === 409, "names are unique, ignoring case");

console.log("the daily list is built once and shared");
const c0 = await aiCalls();
const st = await alice.post("/api/daily/start");
ok(st.status === "playing" && st.livesLeft === 3 && st.turnMs === 4000 && st.topic === "NATO alphabet, first ten", "starting builds today's list and begins the attempt: " + st.topic);
ok((await aiCalls()) === c0 + 1, "one AI request built the list");
ok(!st.text.includes("Alpha") && !st.text.includes("Juliet") && !("answers" in st), "answers never leave the server");
const bob = await new Browser().player("bob-sub", "Bob");
const c1 = await aiCalls(); await bob.post("/api/daily/start");
ok((await aiCalls()) === c1, "the next player reuses the same list (no new AI request)");
const adm = await (await fetch(BASE + "/api/admin/daily?date=" + today, { headers: ADMIN })).json();
ok(adm.exists && adm.attempts === 2 && adm.list.answers.length === 10, "owner can inspect today's list and attempt count");

console.log("playing and scoring");
const g1 = await alice.guess("alpha");
ok(g1.result.kind === "hit" && g1.result.rank === 1 && g1.result.points >= 150 && g1.result.points <= 200, "rank 1 is worth 100 to 200 depending on speed: " + g1.result.points);
const g2 = await alice.guess("Hotel");
ok(g2.result.rank === 8 && g2.result.points >= 30 && g2.result.points <= 60, "rank 8 is worth far less (30 to 60): " + g2.result.points);
ok(g1.result.points > g2.result.points, "higher-ranked answers score more");
ok((await alice.guess("zzz")).result.livesLeft === 2, "a wrong answer costs a life");
ok((await alice.guess("zzz")).result.kind === "repeat" && (await alice.guess("alpha")).result.kind === "dupe", "repeating a wrong or found answer is free");
const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => alice.guess("burst" + i)));
ok(burst.some((r) => r.status === 429), "rapid-fire guessing is rate limited");
ok(!/risk|flags|review|paste/i.test(JSON.stringify(g1)), "the player never sees the fair-play checks in any response");

console.log("the clock never pauses");
await sleep(4500);
const idle = await bob.json("/api/daily/state");
ok(idle.livesLeft === 2 && idle.status === "playing", "after one 4s turn with no answer, one life is gone (even with the tab closed)");
await sleep(9000);
const gone = await bob.json("/api/daily/state");
ok(gone.status === "done" && gone.livesLeft === 0 && gone.score === 0, "walking away burns all three lives and ends the attempt");
ok((await bob.post("/api/daily/start")).status === "done" && (await bob.guess("alpha")).result.kind === "over", "one attempt a day: no restart, no more guesses");

console.log("a clean full run");
const carol = await new Browser().player("carol-sub", "Carol"); await carol.post("/api/daily/start");
let last;
for (const n of names) { await sleep(1700); last = await carol.guess(n); } // a human takes a couple of seconds per answer
ok(last.status === "done" && last.found.length === 10, "finding all ten ends the attempt");
ok(last.score >= 550 && last.score <= 1100, "a full run scores 550 to 1100: " + last.score);
ok(last.source && last.place >= 1, "after finishing you see the source and your place");
const mid = await alice.json("/api/daily/state");
ok(mid.found.every((f) => f.answer) && mid.found.length === 2 && !mid.text.includes("Charlie"), "mid-game you only ever see answers you've found");

console.log("quiet fair-play checks");
const dave = await new Browser().player("dave-sub", "Dave"); await dave.post("/api/daily/start");
const pasted = (len) => ({ ...human(len), paste: true });
const d1 = await dave.guess("Alpha", pasted(5)); await sleep(260); const d2 = await dave.guess("Bravo", pasted(5)); await sleep(260);
for (const w of ["x1", "x2", "x3"]) { await dave.guess(w); await sleep(260); }
const dst = await dave.json("/api/daily/state");
ok(dst.status === "done" && !/risk|flags|review|paste|held/i.test(dst.text + JSON.stringify(d1) + JSON.stringify(d2)), "Dave's attempt ends normally and nothing in what he sees mentions any check");
const eve = await new Browser().player("eve-sub", "Eve"); await eve.post("/api/daily/start");
await eve.guess("Charlie", { ...human(7), keys: 0 }); await sleep(260); await eve.guess("Foxtrot", { ...human(7), keys: 0 }); await sleep(260);
for (const w of ["y1", "y2", "y3"]) { await eve.guess(w); await sleep(260); }
const frank = await new Browser().player("frank-sub", "Frank"); await frank.post("/api/daily/start");
await frank.guess("Echo", pasted(4)); await sleep(260); for (const w of ["z1", "z2", "z3"]) { await frank.guess(w); await sleep(260); }
const attempts = await (await fetch(BASE + "/api/admin/attempts?date=" + today, { headers: ADMIN })).json();
const by = (n) => attempts.find((a) => a.name === n);
ok(by("Dave").review === "held" && by("Dave").flags.includes("paste"), "two pasted answers hold Dave's attempt for review");
ok(by("Eve").review === "held" && by("Eve").flags.includes("no-typing"), "answers that appear with no typing hold Eve's attempt");
ok(by("Frank").review === "none" && by("Frank").risk === 2, "a single paste is noted but doesn't hold anyone (password managers, autofill)");
ok(by("Carol").review === "none" && by("Alice A").review === "none", "normal human-paced play isn't held (Carol's flawless run is noted, risk " + by("Carol").risk + ", but below the review line)");
ok(by("Dave").accountsOnSameConnection >= 4, "the owner can see when several accounts share one connection");
const gl = await (await fetch(BASE + "/api/admin/guesses?attempt=" + by("Dave").id, { headers: ADMIN })).json();
ok(gl.length >= 5 && gl[0].sig.paste === true && gl[0].text === "Alpha", "the owner can inspect every guess and its signals before deciding");

console.log("leaderboards");
const pub = await new Browser().json("/api/daily/leaderboard?scope=today");
const rows = pub.rows.map((r) => r.name);
ok(rows.includes("Carol") && rows.includes("Frank") && !rows.includes("Dave") && !rows.includes("Eve"), "held attempts are kept off the public board");
ok(pub.rows[0].name === "Carol" && pub.rows.every((r, i) => i === 0 || r.score <= pub.rows[i - 1].score), "sorted by score, best first");
const mine = await dave.json("/api/daily/leaderboard?scope=today");
ok(mine.rows.some((r) => r.name === "Dave" && r.me), "…but Dave still sees his own row, so nothing tips him off");
const month = await anon.json("/api/daily/leaderboard?scope=month");
ok(month.rows.find((r) => r.name === "Carol")?.days === 1 && !month.rows.some((r) => r.name === "Dave"), "the monthly table adds up each day's score and also excludes held attempts");

console.log("owner review");
ok((await fetch(BASE + "/api/admin/attempts?date=" + today)).status === 404, "admin tools don't exist without the token");
await fetch(BASE + "/api/admin/attempt", { method: "POST", headers: ADMIN, body: JSON.stringify({ id: by("Eve").id, action: "clear" }) });
await fetch(BASE + "/api/admin/attempt", { method: "POST", headers: ADMIN, body: JSON.stringify({ id: by("Dave").id, action: "void" }) });
const after = (await new Browser().json("/api/daily/leaderboard?scope=today")).rows.map((r) => r.name);
ok(after.includes("Eve") && !after.includes("Dave"), "clearing an attempt puts it on the board; voiding keeps it off");

console.log("yesterday's answers");
const y0 = await anon.json("/api/daily/yesterday");
ok(y0.available === false, "nothing to reveal until a list exists for yesterday");
await fetch(BASE + "/api/admin/daily", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: yesterday, list: { title: "Yesterday test", basis: "b", source: "s", answers: names.map((n, i) => ({ answer: "Old" + (i + 1), aliases: [] })) } }) });
const y1 = await anon.json("/api/daily/yesterday");
ok(y1.available && y1.answers.length === 10 && y1.answers[0].answer === "Old1", "yesterday's list is revealed in full");
ok(!y1.text.includes("Charlie") && !y1.text.includes("NATO"), "...and today's list is not");
const set = await fetch(BASE + "/api/admin/daily", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: today, list: { title: "x", answers: [] } }) });
ok(set.status === 400, "the owner can't save a list that doesn't have exactly ten answers");
const noforce = await fetch(BASE + "/api/admin/daily", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: today, list: { title: "x", basis: "", source: "", answers: names.map((n) => ({ answer: n })) } }) });
ok(noforce.status === 409, "replacing a list people have already played requires an explicit force");

console.log("cancelling a day");
await fetch(BASE + "/api/admin/daily/void", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: today, void: true }) });
const gina = await new Browser().player("gina-sub", "Gina");
ok((await gina.post("/api/daily/start")).status === 409, "a cancelled day can't be started");
ok(!(await anon.json("/api/daily/leaderboard?scope=month")).rows.some((r) => r.name === "Carol"), "…and its scores drop out of the monthly table");
await fetch(BASE + "/api/admin/daily/void", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: today, void: false }) });

console.log("reports, logout, and deleting your account");
ok((await carol.post("/api/daily/report")).ok === true, "a player can report a problem with today's list");
const fr = await frank.json("/api/me");
ok(fr.signedIn, "Frank is signed in");
const del = await frank.post("/api/me/delete");
ok(del.ok === true && (await frank.json("/api/me")).signedIn === false, "deleting your account signs you out immediately");
ok(!(await new Browser().json("/api/daily/leaderboard?scope=today")).rows.some((r) => r.name === "Frank"), "…and removes you from the leaderboard");
const again = new Browser(); await again.signIn("frank-sub");
ok((await again.json("/api/me")).name === null, "signing in again makes a brand-new, empty account");
await again.post("/api/me/name", { name: "Frank2" });
ok((await again.post("/api/daily/start")).status === 409, "…but deleting mid-day doesn't earn a second attempt today");
ok((await carol.post("/api/auth/logout")).ok === true && (await carol.json("/api/me")).signedIn === false, "logging out ends the session");
const stolen = new Browser(); stolen.jar.set("tf_session", "not-a-real-token");
ok((await stolen.json("/api/me")).signedIn === false, "a made-up session cookie is worthless");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nDAILY CHALLENGE CHECKS PASSED"); process.exit(failures ? 1 : 0);
