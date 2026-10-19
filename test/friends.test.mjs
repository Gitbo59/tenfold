const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };

class Browser {
  jar = new Map();
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path, o = {}) {
    const headers = { ...(o.headers || {}) }; if (this.jar.size) headers.cookie = this.cookie();
    const r = await fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...o, headers });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === "" || /Max-Age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  async json(path, o) { const r = await this.req(path, o); const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {} return { httpStatus: r.status, text, ...j }; }
  post(path, body) { return this.json(path, { method: "POST", headers: { "content-type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) }); }
  async signIn(provider, sub) { const s = await this.req(`/api/auth/${provider}/start`); const a = await this.req(s.headers.get("location") + "&as=" + sub); return this.req(a.headers.get("location")); }
  async link(provider, sub) {
    const s = await this.req(`/api/auth/${provider}/start?link=1`);
    const loc = s.headers.get("location") || "";
    if (!loc.includes("127.0.0.1:9998")) return s;
    const a = await this.req(loc + "&as=" + sub);
    return this.req(a.headers.get("location"));
  }
  async player(sub, name) { await this.signIn("mock", sub); const n = await this.post("/api/me/name", { name }); if (n.error) throw new Error("name: " + n.error); this.name = name; return this; }
  friends() { return this.json("/api/friends"); }
  act(action, name) { return this.post(`/api/friends/${action}`, { name }); }
}
const names = (list) => list.map((f) => f.name).sort().join(",");
const noIds = (...texts) => texts.every((t) => !/[0-9a-f]{40,}/.test(t));

console.log("usernames are globally unique and changeable (with a cooldown)");
const alfie = await new Browser().player("fr-alfie", "Alfie");
const other = new Browser(); await other.signIn("mock", "fr-other");
ok((await other.post("/api/me/name", { name: "alfie" })).httpStatus === 409, "a username can't be taken twice, ignoring case");
ok((await alfie.post("/api/me/name", { name: "Alfie" })).ok === true, "setting your current name again is harmless");
const prof0 = await alfie.json("/api/me/profile");
ok(/^\d{4}-\d{2}$/.test(prof0.memberSince) && prof0.nameChangeDays === 7 && prof0.nextNameChange === null, "profile shows member-since and no cooldown yet");
ok((await alfie.post("/api/me/name", { name: "Alfie B" })).name === "Alfie B", "the first change is allowed straight away");
const again = await alfie.post("/api/me/name", { name: "Alfie C" });
ok(again.httpStatus === 429 && /again on \d{4}-\d{2}-\d{2}/.test(again.error), "a second change is held for a week: " + again.error);
ok((await alfie.json("/api/me/profile")).nextNameChange !== null && (await alfie.json("/api/me")).name === "Alfie B", "the profile says when you can change it again, and the name stayed");
ok((await other.post("/api/me/name", { name: "Alfie" })).name === "Alfie", "a name that was released can be claimed by someone else");
alfie.name = "Alfie B";

console.log("linked sign-in accounts");
const linky = await new Browser().player("lk-a", "Linky");
let pr = await linky.json("/api/me/profile");
ok(pr.identities.length === 1 && pr.identities[0].provider === "mock", "a new account has one sign-in method");
const done = await linky.link("mock2", "lk-a2");
ok(done.status === 302 && done.headers.get("location") === "/?linked=mock2#/me", "linking a second provider returns you to your profile page");
pr = await linky.json("/api/me/profile");
ok(pr.identities.map((i) => i.provider).sort().join() === "mock,mock2", "both methods are listed");
ok(noIds(pr.text) && !pr.text.includes("lk-a"), "no provider ids or hashes are ever shown");
const viaSecond = new Browser(); await viaSecond.signIn("mock2", "lk-a2");
ok((await viaSecond.json("/api/me")).name === "Linky", "signing in with the second provider lands in the same account");
const other2 = await new Browser().player("lk-b", "Linkb");
const taken = await other2.link("mock2", "lk-a2");
ok(taken.headers.get("location") === "/?linkerror=taken#/me", "a provider account already used by someone else can't be linked (no merging)");
const dupProv = await linky.link("mock2", "lk-a3");
ok(dupProv.headers.get("location") === "/?linkerror=provider#/me", "an account can't link two accounts from the same provider");
const nobody = await new Browser().req("/api/auth/mock2/start?link=1");
ok(nobody.status === 302 && /autherror=state#\/ranked/.test(nobody.headers.get("location")), "linking needs you to be signed in");
ok((await linky.json("/api/me/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: '{"provider":"mock2"}' })).httpStatus === 403, "unlinking from another site is refused (origin check)");
ok((await linky.post("/api/me/unlink", { provider: "nope" })).httpStatus === 404, "unlinking something that isn't linked is a 404");
ok((await linky.post("/api/me/unlink", { provider: "mock2" })).ok === true, "you can unlink a method");
pr = await linky.json("/api/me/profile");
ok(pr.identities.length === 1 && pr.identities[0].provider === "mock", "...leaving the other");
ok((await linky.post("/api/me/unlink", { provider: "mock" })).httpStatus === 400, "but never your only way in");
const fresh = new Browser(); await fresh.signIn("mock2", "lk-a2");
ok((await fresh.json("/api/me")).name === null, "after unlinking, that provider account is no longer yours: signing in with it makes a new empty account");
ok((await linky.link("mock2", "lk-a2")).headers.get("location") === "/?linkerror=taken#/me", "(and it now belongs to that new account)");

console.log("friend requests");
const [fran, gus, hal, ivy, jo] = await Promise.all(["Fran", "Gus", "Hal", "Ivy", "Joel"].map((n) => new Browser().player("fr-" + n, n)));
ok((await new Browser().friends()).httpStatus === 401, "friends need a login");
const r1 = await fran.act("request", "gus");
ok(r1.status === "requested", "Fran sends Gus a request (usernames are matched ignoring case)");
const fl1 = await fran.friends(), gl1 = await gus.friends();
ok(names(fl1.outgoing) === "Gus" && fl1.friends.length === 0 && names(gl1.incoming) === "Fran" && gl1.incoming[0].rating === 1200 && /^\d+:\d+$/.test(gl1.incoming[0].avatar), "it shows as sent for Fran and incoming for Gus, with rating and avatar");
ok(noIds(fl1.text, gl1.text), "no account ids in the lists");
ok((await fran.act("request", "Gus")).httpStatus === 409, "asking twice is refused");
ok((await fran.act("request", "Fran")).httpStatus === 400 && (await fran.act("request", "Nobody")).httpStatus === 404, "you can't add yourself, and unknown usernames are a 404");
ok((await fran.json("/api/friends/request", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Hal"}' })).httpStatus === 403, "requests from another site are refused (origin check)");
ok((await fran.act("accept", "Gus")).httpStatus === 404, "you can't accept a request you sent yourself");
ok((await gus.act("accept", "Fran")).status === "friends", "Gus accepts");
const f2 = await fran.friends(), g2 = await gus.friends();
ok(names(f2.friends) === "Gus" && names(g2.friends) === "Fran" && f2.incoming.length + f2.outgoing.length + g2.incoming.length + g2.outgoing.length === 0, "both lists show the friendship and no leftover requests");
ok(f2.friends[0].rating === 1200 && f2.friends[0].activity === null, "friends show their rating and what they're up to (nothing right now)");

console.log("both asking each other just makes friends");
await hal.act("request", "Ivy");
ok((await ivy.act("request", "Hal")).status === "friends" && names((await hal.friends()).friends) === "Ivy", "if Ivy asks Hal back, it's treated as accepting");

console.log("declining, cancelling, removing");
await fran.act("request", "Joel");
ok(names((await jo.friends()).incoming) === "Fran" && (await jo.act("decline", "Fran")).ok, "Joel declines Fran's request");
ok((await fran.friends()).outgoing.length === 0, "it disappears for Fran, who isn't told");
ok((await fran.act("request", "Joel")).httpStatus === 403, "Fran can't send it again straight away");
ok((await jo.act("request", "Fran")).status === "requested", "but Joel can ask Fran");
ok((await fran.act("accept", "Joel")).status === "friends", "and Fran can accept that");
await ivy.act("request", "Gus");
ok((await ivy.friends()).outgoing.length === 1 && (await ivy.act("cancel", "Gus")).ok && (await ivy.friends()).outgoing.length === 0 && (await gus.friends()).incoming.length === 0, "a sent request can be cancelled");
ok((await ivy.act("cancel", "Gus")).httpStatus === 404, "cancelling nothing is a 404");
ok((await fran.act("remove", "Gus")).ok && (await gus.friends()).friends.length === 0 && (await fran.friends()).friends.length === 1, "removing a friend removes them from both lists");
ok((await fran.act("remove", "Gus")).httpStatus === 404, "...once");

console.log("privacy: friend requests");
const upd = await jo.post("/api/me/settings", { allowRequests: false, profilePublic: "yes" });
ok(upd.allowRequests === false && upd.profilePublic === true, "you can turn requests off (a wrong type is ignored)");
const blocked = await gus.act("request", "Joel");
ok(blocked.httpStatus === 403 && /isn't accepting/.test(blocked.error), "nobody can send you a request while it's off: " + blocked.error);
await jo.post("/api/me/settings", { allowRequests: true });
ok((await gus.act("request", "Joel")).status === "requested", "and it works again when you turn it back on");

console.log("what your friends can see");
await gus.act("cancel", "Joel"); await gus.act("request", "Fran"); await fran.act("accept", "Gus");
await gus.post("/api/ranked/queue");
ok((await fran.friends()).friends.find((f) => f.name === "Gus").activity === "Looking for a match", "a friend who is searching for a ranked match shows as such");
await gus.post("/api/ranked/leave");

console.log("other players' profiles");
const vp = await fran.json("/api/players/Gus");
ok(vp.name === "Gus" && vp.rating === 1200 && vp.relationship === "friends" && vp.restricted === false && Array.isArray(vp.recent) && /^\d{4}-\d{2}$/.test(vp.memberSince) && vp.games === 0, "you can view another player's profile: rating, record, member since, recent games");
ok(noIds(vp.text), "...with no account ids");
ok((await fran.json("/api/players/gus")).name === "Gus" && (await hal.json("/api/players/Alfie%20B")).name === "Alfie B" && (await hal.json("/api/players/alfie")).name === "Alfie", "lookups ignore case and handle spaces, and a username that was released now belongs to its new owner");
ok((await fran.json("/api/players/Nobody")).httpStatus === 404 && (await new Browser().json("/api/players/Gus")).httpStatus === 401, "unknown players are a 404, and viewing needs a login");
ok((await fran.json("/api/players/Fran")).relationship === "self", "your own name shows as 'self'");
ok((await hal.json("/api/players/Gus")).relationship === "none" && (await hal.json("/api/players/Joel")).relationship === "none", "strangers show as 'none'");
await fran.act("request", "Hal");
ok((await hal.json("/api/players/Fran")).relationship === "incoming" && (await fran.json("/api/players/Hal")).relationship === "outgoing", "pending requests show in the right direction");
await gus.post("/api/me/settings", { profilePublic: false });
const priv = await hal.json("/api/players/Gus");
ok(priv.restricted === true && priv.rating === 1200 && priv.recent === undefined && priv.wins === undefined && priv.memberSince === undefined, "a private profile shows strangers only a name, picture and rating");
ok((await fran.json("/api/players/Gus")).restricted === false && (await gus.json("/api/players/Gus")).restricted === false, "...but friends and the owner still see everything");

console.log("deleting an account cleans up");
ok((await hal.post("/api/me/delete")).ok === true, "Hal deletes their account");
ok(!(await fran.friends()).outgoing.some((f) => f.name === "Hal") && (await ivy.friends()).friends.length === 0, "their friendships and requests disappear for everyone else");
ok((await fran.json("/api/players/Hal")).httpStatus === 404, "and their profile is gone");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nFRIENDS & PROFILE CHECKS PASSED"); process.exit(failures ? 1 : 0);
