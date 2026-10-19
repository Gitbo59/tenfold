const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const ADMIN = { Authorization: "Bearer admintok", "content-type": "application/json", Origin: BASE };
const admin = (path, body) => fetch(BASE + path, { method: "POST", headers: ADMIN, body: JSON.stringify(body) }).then((r) => r.json());
const aiCalls = async () => (await (await fetch("http://127.0.0.1:9999/count")).json()).calls;
// the six built-in lists are what ranked uses on a brand-new site; first three answers of each
const LISTS = {
  "Highest mountains in the world": ["Mount Everest", "K2", "Kangchenjunga"],
  "Largest islands in the world": ["Greenland", "New Guinea", "Borneo"],
  "Largest US states by total area": ["Alaska", "Texas", "California"],
  "Largest lakes in the world": ["Caspian Sea", "Lake Superior", "Lake Victoria"],
  "Largest countries in Africa by area": ["Algeria", "Democratic Republic of the Congo", "Sudan"],
  "Largest countries in South America by area": ["Brazil", "Argentina", "Peru"],
};
const NATURAL = { paste: false, keys: 6, typeMs: 1500, blurMs: 0, refocusMs: 99999 };
const PASTED = { paste: true, keys: 0, typeMs: 0, blurMs: 0, refocusMs: 99999 };

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
  async player(sub, name) {
    const s = await this.req("/api/auth/mock/start"); const a = await this.req(s.headers.get("location") + "&as=" + sub); await this.req(a.headers.get("location"));
    const n = await this.post("/api/me/name", { name }); if (n.error) throw new Error("name: " + n.error); this.name = name; return this;
  }
  /** Connects to a match room with this player's login cookie, like the real page does. */
  room(code) { return new RoomClient(code, this); }
}

class RoomClient {
  constructor(code, browser) {
    this.state = null; this.you = null; this.toasts = []; this.closed = null; this.name = browser.name;
    const headers = { Origin: BASE }; if (browser.jar.size) headers.Cookie = browser.cookie();
    this.ws = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers });
    this.ready = new Promise((res) => (this.ws.onopen = () => { this.send({ t: "join", pid: "ignored-" + Math.random().toString(36).slice(2, 10), name: "ignored" }); res(); }));
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") this.state = m; else if (m.t === "you") this.you = m.id; else if (m.t === "toast") this.toasts.push(m); };
    this.ws.onclose = (e) => (this.closed = e.code);
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  async until(pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.state && pred(this.state)) return this.state; await sleep(30); } throw new Error("timeout; state=" + JSON.stringify(this.state && { phase: this.state.phase, r: this.state.ranked && { w: this.state.ranked.waiting, res: this.state.ranked.result } })); }
  async guess(text, sig) { this.send({ t: "guess", text, sig: sig ?? NATURAL }); await sleep(120); }
}

async function matchUp(b1, b2, timeout = 9000) {
  await b1.post("/api/ranked/queue"); await b2.post("/api/ranked/queue");
  const t0 = Date.now(); let s1, s2;
  while (Date.now() - t0 < timeout) {
    s1 = await b1.json("/api/ranked/status"); s2 = await b2.json("/api/ranked/status");
    if (s1.status === "matched" && s2.status === "matched") return { code: s1.code, s1, s2, waited: Date.now() - t0 };
    await sleep(250);
  }
  throw new Error("no match: " + JSON.stringify([s1, s2]));
}
async function startMatch(b1, b2) {
  const m = await matchUp(b1, b2); const c1 = b1.room(m.code), c2 = b2.room(m.code); await c1.ready; await c2.ready;
  await c1.until((s) => s.phase === "playing"); await c2.until((s) => s.phase === "playing");
  return { ...m, c1, c2 };
}
const turn = (m) => (m.c1.state.turnPid === m.c1.you ? m.c1 : m.c2);
const winnerOf = (m, st) => st.ranked.players[st.ranked.result.outcome === "a" ? 0 : 1].id;
const me = (b) => b.json("/api/ranked/me");

console.log("sign-in required, ladder is public");
const anon = new Browser();
ok((await anon.post("/api/ranked/queue")).httpStatus === 401 && (await anon.json("/api/ranked/me")).httpStatus === 401, "queueing and your rating need an account");
ok((await anon.json("/api/ranked/ladder")).httpStatus === 200, "the ladder is public");
const [p1, p2, p3, p4, p5, p6, p7, p8] = await Promise.all(["Pia", "Quin", "Rex", "Sol", "Tia", "Uma", "Vik", "Wen"].map((n, i) => new Browser().player("rk-" + n, n)));
const noName = new Browser(); await noName.req("/api/auth/mock/start").then(async (s) => { const a = await noName.req(s.headers.get("location") + "&as=noname"); await noName.req(a.headers.get("location")); });
ok((await noName.post("/api/ranked/queue")).error?.includes("username"), "you need a display name first");
const base = await aiCalls();

console.log("the queue");
const first = await p1.post("/api/ranked/queue");
ok(first.status === "waiting" && first.rating === 1200, "joining with nobody else waiting puts you in the queue at 1200");
ok((await p1.post("/api/ranked/leave")).status === "idle" && (await p1.json("/api/ranked/status")).status === "idle", "you can leave the queue");
const m1 = await matchUp(p1, p2);
ok(m1.s1.code === m1.s2.code && /^[A-Z0-9]{5}$/.test(m1.code), "two waiting players are paired into one room: " + m1.code);
ok(m1.s1.opponent.name === "Quin" && m1.s2.opponent.name === "Pia" && m1.s1.opponent.rating === 1200, "each sees the other's name and rating");
const again = await p1.post("/api/ranked/queue");
ok(again.status === "matched" && again.code === m1.code, "queueing while you're in a match just returns you to it (refresh-safe)");

console.log("only the two matched accounts get in");
const c1 = p1.room(m1.code); await c1.ready;
const intruder = p5.room(m1.code); await intruder.ready; await sleep(400);
ok(intruder.closed === 4403 && intruder.toasts.some((t) => /isn't yours/.test(t.msg)), "another signed-in player is shut out of the room");
const guest = new Browser().room(m1.code); await guest.ready; await sleep(400);
ok(guest.closed === 4403, "so is someone who isn't signed in");
await c1.until((s) => s.ranked?.waiting === true);
ok(c1.you && c1.state.phase === "lobby", "the first player waits in the room; the server tells them who they are");
const c2 = p2.room(m1.code); await c2.ready;
await c1.until((s) => s.phase === "playing"); await c2.until((s) => s.phase === "playing");
ok(c1.you !== c2.you && c1.state.ranked.players.map((p) => p.id).sort().join() === [c1.you, c2.you].sort().join(), "the match starts when both are connected, and the two ids match the two accounts");
const st = c1.state;
ok(st.config.lives === 3 && st.config.timerEnabled && st.config.turnSeconds === 20 && st.config.hints === 0 && st.hostId === null, "rules are fixed: 3 lives, 20s turns, no hints, no host");
c1.send({ t: "config", lives: 10, hints: 5 }); c1.send({ t: "start", topic: "x" }); c1.send({ t: "rematch" }); c1.send({ t: "hint" }); c1.send({ t: "source" }); await sleep(250);
ok(c1.state.config.lives === 3 && c1.state.phase === "playing" && c1.state.hintsLeft === 0 && !c1.state.log.some((l) => /source/.test(l.text)), "settings, hints, source lookups and rematches are all ignored in ranked");
ok(st.source === "" && st.answers.every((a) => a.answer === undefined) && st.players.every((p) => p.rating === 1200), "no source or answers are sent mid-match; ratings are shown");
ok((await aiCalls()) === base, "a ranked match uses no AI requests");
const answers = LISTS[st.topic]; ok(!!answers, "list for this match: " + st.topic);

console.log("winning by elimination changes both ratings");
const m = { c1, c2 };
let hits = 0;
for (let i = 0; i < 40 && c1.state.phase === "playing"; i++) {
  const mover = turn(m);
  if (mover === c1 && hits < 3) { await mover.guess(answers[hits], hits < 2 ? PASTED : undefined); hits++; }
  else if (mover === c1) await mover.guess("filler" + i);
  else await mover.guess("nope-" + i);
}
const fin = await c1.until((s) => s.ranked?.result && s.ranked.result.pending === false);
ok(fin.phase === "finished" && winnerOf(m, fin) === c1.you, "Pia wins once Quin is out of lives and can't catch up");
ok(fin.ranked.result.reason === "completed", "...ending the match early instead of making her play on");
ok(fin.ranked.result.aDelta + fin.ranked.result.bDelta === 0 && Math.abs(fin.ranked.result.aDelta) === 20, "new players move 20 points each way (K=40, equal ratings)");
const w = await me(p1), l = await me(p2);
ok(w.rating === 1220 && w.wins === 1 && w.games === 1 && l.rating === 1180 && l.losses === 1, "winner 1220, loser 1180: " + w.rating + " / " + l.rating);
ok(w.provisional === true, "new players are marked provisional");
const ladder = (await anon.json("/api/ranked/ladder")).rows;
ok(ladder[0].name === "Pia" && ladder[0].rating === 1220 && ladder.some((r) => r.name === "Quin" && r.rating === 1180), "the ladder shows both, best first");

console.log("quiet fair-play signals are recorded for review");
const matches = await (await fetch(BASE + "/api/admin/matches", { headers: ADMIN })).json();
const rec1 = matches.find((x) => x.status === "done");
ok(rec1 && [rec1.aRisk, rec1.bRisk].sort().join() === "0,4" && JSON.stringify(rec1.flags).includes("paste"), "two pasted answers are logged against that player for review: " + JSON.stringify(rec1.flags));
ok(!JSON.stringify(c1.state).includes("paste") && !JSON.stringify(c2.state).includes("paste"), "...and nothing about it reaches either player");
const matchId = rec1.id;
c1.ws.close(); c2.ws.close();

console.log("resigning");
const m2 = await startMatch(p1, p2);
const resigner = turn(m2); resigner.send({ t: "resign" });
const f2 = await m2.c1.until((s) => s.ranked?.result?.pending === false);
ok(f2.ranked.result.reason === "resigned" && winnerOf(m2, f2) !== resigner.you, "resigning ends it immediately as a loss for the resigner, and the opponent wins");
const aftr = await me(p1);
ok(aftr.games === 2, "both players have now played 2 rated games");
m2.c1.ws.close(); m2.c2.ws.close();

console.log("the same two players can't farm each other");
await p1.post("/api/ranked/queue"); await p2.post("/api/ranked/queue");
let paired = false; for (let i = 0; i < 8 && !paired; i++) { await sleep(400); paired = (await p1.json("/api/ranked/status")).status === "matched"; await p2.json("/api/ranked/status"); }
ok(!paired, "after two games in a day, the matchmaker won't pair the same two again");
await p1.post("/api/ranked/leave"); await p2.post("/api/ranked/leave");

console.log("disconnecting");
const m3 = await startMatch(p3, p4);
const dropper = m3.c1; const stayer = m3.c2;
dropper.ws.close();
await sleep(1200);
const back = p3.room(m3.code); await back.ready;
await sleep(800);
ok(stayer.state.phase === "playing" && back.you === dropper.you, "reconnecting within the grace period keeps you in the match");
back.ws.close();
const f3 = await stayer.until((s) => s.ranked?.result?.pending === false, 9000);
ok(f3.ranked.result.reason === "disconnected" && winnerOf(m3, f3) === stayer.you, "staying away past the grace period forfeits the match to the opponent");
ok((await me(p4)).wins === 1 && (await me(p3)).losses === 1, "and the ratings follow");
stayer.ws.close();

console.log("a no-show cancels the match with no rating change");
const m4 = await matchUp(p5, p6);
const lone = p5.room(m4.code); await lone.ready;
const fa = await lone.until((s) => s.ranked?.result?.outcome === "abort", 9000);
ok(fa.phase === "finished" && /never connected/.test(fa.ranked.result.reason), "only one player turned up, so the match is cancelled");
ok((await me(p5)).games === 0 && (await me(p6)).games === 0 && (await me(p5)).rating === 1200, "nobody's rating or record changed");
ok((await p5.json("/api/ranked/status")).status === "idle", "both players are free to queue again");
lone.ws.close();

console.log("rating gaps and the weighting by opponent rating");
await admin("/api/admin/rating", { name: "Rex", rating: 2000 });
await p3.post("/api/ranked/queue"); const near = await p6.post("/api/ranked/queue");
const sr = await p3.json("/api/ranked/status");
ok(sr.status === "waiting" || sr.status === "matched", "(queued)");
await p3.post("/api/ranked/leave"); await p6.post("/api/ranked/leave");
const t0 = Date.now(); await p3.post("/api/ranked/queue"); const s0 = await p4.post("/api/ranked/queue"); // Sol is ~1200ish; Rex is 2000
ok(s0.status === "waiting", "a 2000 and a ~1200 are not paired at the start (gap 800 > starting window 100)");
let late; for (let i = 0; i < 20; i++) { late = await p3.json("/api/ranked/status"); await p4.json("/api/ranked/status"); if (late.status === "matched") break; await sleep(300); }
ok(late.status === "matched" && Date.now() - t0 > 1000, `the window widens while they wait, then they are paired (after ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const mt = await startMatch(p3, p4); mt.c1.send({ t: "resign" }); await mt.c1.until((s) => s.ranked?.result?.pending === false); mt.c1.ws.close(); mt.c2.ws.close();

// clean, controlled comparison with two fresh accounts each time
const lowRated = p7, highRated = p8;
await admin("/api/admin/rating", { name: "Vik", rating: 1200 }); await admin("/api/admin/rating", { name: "Wen", rating: 1600 });
const before = { v: (await me(lowRated)).rating, w: (await me(highRated)).rating };
const m5 = await startMatch(lowRated, highRated);
const idLow = m5.c1.state.ranked.players.find((p) => p.name === "Vik").id; const lowRoom = m5.c1.you === idLow ? m5.c1 : m5.c2; const highRoom = lowRoom === m5.c1 ? m5.c2 : m5.c1;
highRoom.send({ t: "resign" }); await lowRoom.until((s) => s.ranked?.result?.pending === false);
const aV = await me(lowRated), aW = await me(highRated);
ok(aV.rating - before.v === 36 && aW.rating - before.w === -36, `UPSET: the 1200 beating the 1600 gains +${aV.rating - before.v}; the 1600 loses ${aW.rating - before.w}`);
lowRoom.ws.close(); highRoom.ws.close();
await admin("/api/admin/rating", { name: "Vik", rating: 1200 }); await admin("/api/admin/rating", { name: "Wen", rating: 1600 });
const b2 = { v: (await me(lowRated)).rating, w: (await me(highRated)).rating };
const m6 = await startMatch(lowRated, highRated);
const lowRoom2 = m6.c1.state.ranked.players.find((p) => p.name === "Vik").id === m6.c1.you ? m6.c1 : m6.c2; const highRoom2 = lowRoom2 === m6.c1 ? m6.c2 : m6.c1;
lowRoom2.send({ t: "resign" }); await highRoom2.until((s) => s.ranked?.result?.pending === false);
const cV = await me(lowRated), cW = await me(highRated);
ok(cW.rating - b2.w === 4 && cV.rating - b2.v === -4, `EXPECTED: the 1600 beating the 1200 gains only +${cW.rating - b2.w}; the 1200 loses ${cV.rating - b2.v}`);
lowRoom2.ws.close(); highRoom2.ws.close();

console.log("profile: avatar, rank and recent games");
const meInfo = await p1.json("/api/me");
ok(/^\d+:\d+$/.test(meInfo.avatar), "everyone gets a default avatar (colour:emblem), so no photo is ever needed: " + meInfo.avatar);
ok(meInfo.avatar === (await p1.json("/api/me")).avatar, "the default is stable");
ok((await p1.post("/api/me/avatar", { color: 99, icon: 1 })).httpStatus === 400 && (await p1.post("/api/me/avatar", { color: "x", icon: 1 })).httpStatus === 400, "invalid avatar choices are refused");
ok((await fetch(BASE + "/api/me/avatar", { method: "POST", headers: { cookie: p1.cookie(), "content-type": "application/json" }, body: '{"color":1,"icon":1}' })).status === 403, "changing it from another site is refused (origin check)");
ok((await anon.post("/api/me/avatar", { color: 1, icon: 1 })).httpStatus === 401, "and it needs a login");
ok((await p1.post("/api/me/avatar", { color: 5, icon: 7 })).avatar === "5:7" && (await p1.json("/api/me")).avatar === "5:7", "choosing a colour and a picture is saved");
const lad = (await anon.json("/api/ranked/ladder")).rows;
ok(lad.find((r) => r.name === "Pia").avatar === "5:7" && lad.every((r) => /^\d+:\d+$/.test(r.avatar)) && !JSON.stringify(lad).includes("id\""), "the ladder shows avatars (and never account ids)");
const prof = await me(p1);
ok(prof.avatar === "5:7" && prof.rank >= 1 && prof.rank <= lad.length, "your profile includes your avatar and ladder position: #" + prof.rank);
const hist = await p1.json("/api/ranked/history");
const oldest = hist.rows.at(-1);
ok(hist.rows.length === 2 && hist.rows[0].time >= oldest.time, "recent games lists both finished matches, newest first");
ok(oldest.result === "win" && oldest.delta === 20 && oldest.ratingBefore === 1200 && oldest.ratingAfter === 1220 && oldest.opponent.name === "Quin" && oldest.opponent.rating === 1200, "each row has the result, rating change and opponent: " + JSON.stringify({ r: oldest.result, d: oldest.delta, o: oldest.opponent.name }));
ok(Object.keys(LISTS).includes(oldest.title) && /^\d+:\d+$/.test(oldest.opponent.avatar), "...plus the list that was played and the opponent's avatar");
ok(hist.trend[0] === 1200 && hist.trend.at(-1) === prof.rating && hist.trend.length === 3, "the rating trend runs from the starting rating to today's: " + hist.trend.join(" > "));
ok(Math.abs(hist.streak) >= 1, "there is a current streak: " + hist.streak);
ok((await p5.json("/api/ranked/history")).rows.length === 0, "cancelled matches don't appear in anyone's history");
ok((await anon.json("/api/ranked/history")).httpStatus === 401, "history needs a login");
ok(!JSON.stringify(hist).match(/[0-9a-f]{40,}/), "no account ids leak through the history");

console.log("owner tools");
ok((await fetch(BASE + "/api/admin/matches")).status === 404, "admin match list needs the token");
const pre = { p1: await me(p1), p2: await me(p2) };
const voided = await admin("/api/admin/match/void", { id: matchId });
const post = { p1: await me(p1), p2: await me(p2) };
ok(voided.ok && post.p1.games === pre.p1.games - 1 && post.p1.rating !== pre.p1.rating && post.p2.games === pre.p2.games - 1, "voiding a match reverses its rating change and record: Pia " + pre.p1.rating + " -> " + post.p1.rating);
ok((await admin("/api/admin/match/void", { id: matchId })).error, "a match can only be voided once");
ok((await admin("/api/admin/pool", { list: { title: "Pool test", basis: "b", source: "s", answers: Array.from({ length: 10 }, (_, i) => ({ answer: "P" + i })) } })).poolSize === 1, "the owner can add lists to the ranked pool");

console.log("safeguards");
await admin("/api/admin/ban", { name: "Uma", banned: true });
ok((await p6.post("/api/ranked/queue")).httpStatus === 401 || (await p6.post("/api/ranked/queue")).error, "a banned player can't queue");
const sneaky = await fetch(BASE + "/api/ranked/queue", { method: "POST", headers: { cookie: p7.cookie(), "content-type": "application/json" }, body: "{}" });
ok(sneaky.status === 403, "joining the queue from another site is refused (origin check)");
const gone = await p8.post("/api/me/delete");
ok(gone.ok && !(await anon.json("/api/ranked/ladder")).rows.some((r) => r.name === "Wen"), "deleting your account removes your rating from the ladder");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nRANKED CHECKS PASSED"); process.exit(failures ? 1 : 0);
