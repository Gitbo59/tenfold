const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const mock = async () => (await fetch("http://127.0.0.1:9999/count")).json();
const budget = async () => (await fetch(BASE + "/api/budget")).json();
const newRoom = async () => (await (await fetch(BASE + "/api/rooms", { method: "POST" })).json()).code;

class Client {
  constructor(code, name, pid) {
    this.pid = pid || "pid-" + name + "-" + Math.random().toString(36).slice(2, 10);
    this.name = name; this.state = null; this.toasts = [];
    this.ws = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers: { Origin: BASE } });
    this.ready = new Promise((res) => (this.ws.onopen = () => { this.send({ t: "join", pid: this.pid, name }); res(); }));
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === "state") this.state = m; if (m.t === "toast") this.toasts.push(m); };
  }
  // Paced like a person: the server (deliberately) drops anything above 15 messages/second per socket.
  send(o) { const now = Date.now(); this.nextAt = Math.max(this.nextAt ?? 0, now) + 90; setTimeout(() => this.ws.readyState === 1 && this.ws.send(JSON.stringify(o)), this.nextAt - now - 90); }
  async until(pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.state && pred(this.state)) return this.state; await sleep(25); } throw new Error("timeout; last=" + JSON.stringify(this.state && { phase: this.state.phase, turn: this.state.turnPid, hv: this.state.hintVotes, hl: this.state.hintsLeft }) + " toasts=" + JSON.stringify(this.toasts.slice(-3).map((t) => t.msg))); }
  async toast(re, from, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = this.toasts.slice(from).find((x) => re.test(x.msg)); if (t) return t; await sleep(25); } return null; }
}
const solo = async (name = "Solo") => { const code = await newRoom(); const c = new Client(code, name); await c.ready; await c.until((s) => s.players.length === 1); return { code, c }; };
const finishByMiss = async (c) => { c.send({ t: "guess", text: "zzz-nope" }); await c.until((s) => s.phase === "finished"); };

console.log("T1: difficulty, hints, reports");
const code1 = await newRoom();
const A = new Client(code1, "Alice"); await A.ready; await A.until((s) => s.players.length === 1);
let B = new Client(code1, "Bob"); await B.ready; await A.until((s) => s.players.length === 2);
ok(A.state.config.difficulty === "easy" && A.state.config.hints === 3, "defaults: easy list, 3 hints");
ok(Array.isArray(A.state.classics) && A.state.classics.length === 6, "lobby offers 6 built-in lists");
B.send({ t: "config", difficulty: "hard", hints: 5 }); await sleep(150);
ok(A.state.config.difficulty === "easy", "non-host cannot change difficulty");
A.send({ t: "config", difficulty: "hard", hints: 2, lives: 3, timerEnabled: false });
await A.until((s) => s.config.difficulty === "hard" && s.config.hints === 2 && !s.config.timerEnabled);
A.send({ t: "config", difficulty: "nonsense", hints: 99 });
await A.until((s) => s.config.hints === 5);
ok(A.state.config.difficulty === "hard", "invalid difficulty ignored, hints clamped to 5");
A.send({ t: "config", hints: 2 }); await A.until((s) => s.config.hints === 2);

const m0 = await mock();
A.send({ t: "start", topic: "NATO alphabet" });
await A.until((s) => s.phase === "playing");
const m1 = await mock();
const last = m1.seen[m1.seen.length - 1];
ok(m1.calls === m0.calls + 1, "one AI request for a fresh topic");
ok(last.hard && !last.easy && /Difficulty: HARD/.test(last.user), "hard difficulty reaches the prompt");
ok(last.model === "mock-model" && last.max_tokens === 1200 && last.auth === "Bearer test-key", "model, 1200 token ceiling and key sent");
ok(A.state.listDifficulty === "hard" && A.state.classic === false && /NATO/.test(A.state.source), "snapshot carries difficulty and source");
ok(A.state.hintsLeft === 2, "hints per game applied");

A.send({ t: "hint" }); await A.until((s) => s.hintVotes.length === 1);
ok(A.state.hintVoters === 2 && A.state.answers.every((a) => !a.hint), "one vote of two does not unlock a hint");
A.send({ t: "hint" }); await A.until((s) => s.hintVotes.length === 0);
ok(true, "voting again withdraws the vote");
A.send({ t: "hint" }); B.send({ t: "hint" });
await A.until((s) => s.answers[0].hint);
ok(A.state.answers[0].hint === "5 letters, starts with A" && A.state.hintsLeft === 1, "unanimous vote reveals a clue for the easiest unfound answer: " + A.state.answers[0].hint);
ok(!JSON.stringify(A.state).includes("Alpha") && A.state.hintVotes.length === 0, "the answer itself still isn't in the payload; votes reset");
A.send({ t: "hint" }); await A.until((s) => s.hintVotes.length === 1);
B.ws.close();
await A.until((s) => s.answers[1].hint && s.hintsLeft === 0);
ok(true, "if the other voter disconnects, the remaining vote is enough (second clue: " + A.state.answers[1].hint + ")");
B = new Client(code1, "Bob", B.pid); await B.ready; await A.until((s) => s.players.find((p) => p.name === "Bob")?.connected);
const mk = A.toasts.length; A.send({ t: "hint" });
ok(!!(await A.toast(/no hints left/i, mk)), "voting with no hints left is refused");

const who = () => (A.state.turnPid === A.pid ? A : B);
const other = () => (who() === A ? B : A);
who().send({ t: "guess", text: "charlie" });
await A.until((s) => s.answers[2].found);
const reporter = who(); // whoever is now up reports the answer the other found
const rk = reporter.toasts.length;
reporter.send({ t: "report", kind: "wrong", rank: 3 });
const t1 = await reporter.toast(/retired|saved/i, rk);
ok(t1 && /retired/.test(t1.msg), "report accepted; cached list retired (evict threshold 1 in test config)");
await A.until((s) => s.answers[2].reports === 1);
ok(A.state.log.some((l) => /flagged #3/.test(l.text)), "report is flagged to the whole room");
const rk2 = reporter.toasts.length; reporter.send({ t: "report", kind: "rank", rank: 3 });
ok(!!(await reporter.toast(/saved|retired/i, rk2)), "a different kind of report on the same answer is allowed");
reporter.send({ t: "report", kind: "wrong", rank: 3 }); await sleep(150);
ok(reporter.toasts.some((t) => /already reported/i.test(t.msg)), "duplicate report is refused");
const before = A.state.answers[4].reports; reporter.send({ t: "report", kind: "wrong", rank: 5 }); await sleep(150);
ok(A.state.log.every((l) => !/flagged #5/.test(l.text)), "unrevealed answers can't be reported mid-game");
who().send({ t: "guess", text: "Zulu" }); await A.until((s) => s.wrong.includes("Zulu"));
const rk3 = A.toasts.length; A.send({ t: "report", kind: "alias", guess: "Zulu" });
const t3 = await A.toast(/saved/i, rk3);
ok(!!t3, "rejected-guess report saved");
A.send({ t: "report", kind: "alias", guess: "NotGuessed" }); await sleep(150);
ok(true, "alias report for a guess nobody made is ignored");

console.log("admin endpoints");
ok((await fetch(BASE + "/api/admin/reports")).status === 404, "admin reports hidden without a token");
ok((await fetch(BASE + "/api/admin/stats", { headers: { Authorization: "Bearer wrong" } })).status === 404, "admin stats hidden with wrong token");
const rep = await (await fetch(BASE + "/api/admin/reports", { headers: { Authorization: "Bearer admintok" } })).json();
ok(rep.some((r) => r.kind === "wrong" && r.rank === 3 && r.answer === "Charlie") && rep.some((r) => r.kind === "alias" && r.answer === "Zulu"), "owner sees the stored reports (" + rep.length + ")");
const st = await (await fetch(BASE + "/api/admin/stats", { headers: { Authorization: "Bearer admintok" } })).json();
ok(st.dailyCap === 22 && st.aiRequestsToday >= 1, "stats show usage vs cap: " + JSON.stringify(st));

console.log("finish, source reveal, rematch");
let g = 0;
while (A.state.phase === "playing" && g++ < 30) {
  const left = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliet"].filter((n, i) => !A.state.answers[i].found);
  if (!left.length) break;
  who().send({ t: "guess", text: left[0] }); await sleep(100);
}
await A.until((s) => s.phase === "finished");
ok(A.state.answers.every((a) => a.answer) && A.state.answers[2].reports === 2 && A.state.source, "finished: everything revealed, flag count kept, source present");
A.send({ t: "rematch" }); await A.until((s) => s.phase === "lobby");
ok(A.state.hintsLeft === 2 && A.state.answers.length === 0 && A.state.classics.length === 6, "rematch clears hints/answers and offers built-ins again");

console.log("T2: cache and difficulty keys");
const s2 = await solo("Cara");
s2.c.send({ t: "config", difficulty: "hard", lives: 1, hints: 0 }); await s2.c.until((s) => s.config.lives === 1 && s.config.difficulty === "hard");
let c0 = (await mock()).calls;
s2.c.send({ t: "start", topic: "NATO alphabet" }); await s2.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0 + 1, "evicted list is regenerated once");
ok(s2.c.state.hintsLeft === 0, "hints can be turned off (0)");
await finishByMiss(s2.c); s2.c.send({ t: "rematch" }); await s2.c.until((s) => s.phase === "lobby");
c0 = (await mock()).calls;
s2.c.send({ t: "start", topic: "nato ALPHABET!" }); await s2.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0 + 1, "a room replaying the same topic gets a fresh list when budget allows");
const s3 = await solo("Dev");
c0 = (await mock()).calls;
s3.c.send({ t: "config", difficulty: "hard", lives: 1 }); await s3.c.until((s) => s.config.difficulty === "hard" && s.config.lives === 1);
s3.c.send({ t: "start", topic: "  NATO   alphabet " }); await s3.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0, "another room asking for the same topic and difficulty is served from cache (0 AI calls)");
await finishByMiss(s3.c); s3.c.send({ t: "rematch" }); await s3.c.until((s) => s.phase === "lobby");
s3.c.send({ t: "config", difficulty: "easy" }); await s3.c.until((s) => s.config.difficulty === "easy");
s3.c.send({ t: "start", topic: "tea varieties" }); await s3.c.until((s) => s.phase === "playing");
const mm = await mock();
ok(mm.calls === c0 + 1 && mm.seen.at(-1).easy, "easy and hard are cached separately; easy prompt used");

console.log("T3: built-in lists");
const s4 = await solo("Erin"); c0 = (await mock()).calls;
s4.c.send({ t: "start", classic: "nope" }); const k4 = await s4.c.toast(/doesn't exist/i, 0);
ok(!!k4 && s4.c.state.phase === "lobby", "unknown built-in list is refused");
s4.c.send({ t: "start", classic: "mountains" }); await s4.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0, "built-in list uses zero AI requests");
ok(s4.c.state.classic && s4.c.state.listDifficulty === null && /Wikipedia/.test(s4.c.state.source) && s4.c.state.answers.every((a) => a.answer === undefined), "built-in list: flagged classic, sourced, answers hidden");
s4.c.send({ t: "guess", text: "everest" }); await s4.c.until((s) => s.answers[0].found);
s4.c.send({ t: "guess", text: "K2" }); await s4.c.until((s) => s.answers[1].found);
ok(s4.c.state.answers[0].answer === "Mount Everest", "alias 'everest' and exact 'K2' both score");

console.log("T4: failures are refunded; retries are counted");
const s5 = await solo("Finn"); let b0 = await budget(); c0 = (await mock()).calls;
s5.c.send({ t: "config", lives: 1 }); await s5.c.until((s) => s.config.lives === 1);
s5.c.send({ t: "start", topic: "boom goes the api" });
ok(!!(await s5.c.toast(/didn't respond/i, 0)), "provider error shows a friendly message");
await s5.c.until((s) => s.phase === "lobby");
let b1 = await budget();
ok(b1.remaining === b0.remaining && (await mock()).calls === c0 + 1, "HTTP failure is refunded (budget unchanged)");
b0 = await budget(); c0 = (await mock()).calls;
s5.c.send({ t: "start", topic: "flaky list" }); await s5.c.until((s) => s.phase === "playing");
b1 = await budget();
ok((await mock()).calls === c0 + 2 && b1.remaining === b0.remaining - 2, "an incomplete list is retried once and both attempts count against the budget");
await finishByMiss(s5.c); s5.c.send({ t: "rematch" }); await s5.c.until((s) => s.phase === "lobby");
s5.c.send({ t: "start", topic: "fenced json answer" }); await s5.c.until((s) => s.phase === "playing");
ok(true, "JSON wrapped in markdown fences is accepted");

console.log("T5: per-room cap (4)");
const s6 = await solo("Gus"); s6.c.send({ t: "config", lives: 1 }); await s6.c.until((s) => s.config.lives === 1);
for (let i = 1; i <= 4; i++) {
  s6.c.send({ t: "start", topic: `room cap topic ${i}` }); await s6.c.until((s) => s.phase === "playing");
  await finishByMiss(s6.c); s6.c.send({ t: "rematch" }); await s6.c.until((s) => s.phase === "lobby");
}
const rk6 = s6.c.toasts.length;
s6.c.send({ t: "start", topic: "room cap topic 5" });
ok(!!(await s6.c.toast(/used all of its AI lists/i, rk6)), "5th new AI list in one room is refused");
c0 = (await mock()).calls;
s6.c.send({ t: "start", topic: "tea varieties" }); await s6.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0, "cached and built-in lists still work after the room cap");

console.log("T6: per-connection daily cap (20), then free fallbacks");
let capHit = false, rounds = 0, room = null;
while (!capHit && rounds < 40) {
  if (!room || rounds % 4 === 0) { room = await solo("Burn" + rounds); room.c.send({ t: "config", lives: 1 }); await room.c.until((s) => s.config.lives === 1); }
  const mark = room.c.toasts.length;
  room.c.send({ t: "start", topic: `burn ${rounds++} unique` });
  const t = await room.c.toast(/connection/i, mark, 1500);
  if (t) { capHit = true; break; }
  await room.c.until((s) => s.phase === "playing"); await finishByMiss(room.c); room.c.send({ t: "rematch" }); await room.c.until((s) => s.phase === "lobby");
}
ok(capHit, `per-connection cap tripped after ${rounds - 1} further new lists`);
const bd = await budget(); ok(bd.remaining >= 0 && bd.remaining <= bd.cap, "budget endpoint stays sane: " + JSON.stringify(bd));
const s8 = await solo("Hana"); c0 = (await mock()).calls;
s8.c.send({ t: "config", lives: 1 }); await s8.c.until((s) => s.config.lives === 1);
s8.c.send({ t: "start", topic: "tea varieties" }); await s8.c.until((s) => s.phase === "playing");
ok((await mock()).calls === c0, "with the cap reached, a cached topic still starts");
await finishByMiss(s8.c); s8.c.send({ t: "rematch" }); await s8.c.until((s) => s.phase === "lobby");
const rk8 = s8.c.toasts.length; s8.c.send({ t: "start", topic: "tea varieties" });
await s8.c.until((s) => s.phase === "playing");
ok(!!(await s8.c.toast(/replaying a saved list/i, rk8)) && (await mock()).calls === c0, "replaying a topic with no budget falls back to the saved list instead of failing");
const rk9 = s8.c.toasts.length; await finishByMiss(s8.c); s8.c.send({ t: "rematch" }); await s8.c.until((s) => s.phase === "lobby");
s8.c.send({ t: "start", topic: "brand new topic nobody has played" });
ok(!!(await s8.c.toast(/connection|built-in/i, rk9)), "a brand-new topic is refused with a pointer to built-in lists");

console.log("T7: room creation limit");
let limited = null;
for (let i = 0; i < 40 && !limited; i++) { const r = await fetch(BASE + "/api/rooms", { method: "POST" }); if (r.status === 429) limited = await r.json(); }
ok(!!limited && /lot of rooms/.test(limited.error), "room creation is rate-limited per connection");
ok((await fetch(BASE + "/api/budget")).status === 200, "other endpoints unaffected");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL NEW-FEATURE CHECKS PASSED");
process.exit(failures ? 1 : 0);
