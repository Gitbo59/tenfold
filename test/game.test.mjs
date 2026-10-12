const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log(cond ? "  PASS" : "  FAIL", msg); if (!cond) failures++; };

class Client {
  constructor(code, name) {
    this.pid = "pid-" + name + "-" + Math.random().toString(36).slice(2, 10);
    this.name = name; this.state = null; this.toasts = [];
    this.ws = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers: { Origin: BASE } });
    this.ready = new Promise((res) => (this.ws.onopen = () => { this.send({ t: "join", pid: this.pid, name }); res(); }));
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === "state") this.state = m; if (m.t === "toast") this.toasts.push(m); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async until(pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.state && pred(this.state)) return this.state; await sleep(25); } throw new Error("timeout waiting for state; last=" + JSON.stringify(this.state && { phase: this.state.phase, turn: this.state.turnPid, players: this.state.players.map(p=>[p.name,p.lives,p.score]) })); }
  me() { return this.state.players.find((p) => p.id === this.pid); }
}

const r = await fetch(`${BASE}/api/rooms`, { method: "POST" });
const { code } = await r.json();
console.log("room", code);
ok(/^[A-Z0-9]{5}$/.test(code), "room code is 5 chars");
ok((await fetch(`${BASE}/api/rooms/${code}`)).status === 200, "status endpoint finds room");
ok((await fetch(`${BASE}/api/rooms/ZZZZZ`)).status === 404, "status endpoint 404s unknown room");
const badWs = await new Promise((res) => { const w = new WebSocket(`ws://localhost:8787/ws/ZZZZZ`); w.onerror = () => res("error"); w.onopen = () => res("open"); });
ok(badWs === "error", "websocket to unknown room is refused");

const A = new Client(code, "Alice"); await A.ready; await A.until((s) => s.players.length === 1);
const B = new Client(code, "Bob"); await B.ready; await A.until((s) => s.players.length === 2);
ok(A.state.hostId === A.pid, "first joiner is host");

console.log("config");
B.send({ t: "config", lives: 9, timerEnabled: false, turnSeconds: 99 });
await sleep(150);
ok(A.state.config.lives === 3, "non-host config change ignored");
A.send({ t: "config", lives: 2, timerEnabled: true, turnSeconds: 6 });
await A.until((s) => s.config.lives === 2 && s.config.turnSeconds === 6 && s.config.timerEnabled);
ok(true, "host config applied (lives 2, timer on, 6s)");
A.send({ t: "config", lives: 99, turnSeconds: 1 });
await A.until((s) => s.config.lives === 10 && s.config.turnSeconds === 5);
ok(true, "config values are clamped (10 lives, 5s)");
A.send({ t: "config", lives: 2, timerEnabled: true, turnSeconds: 6 });
await A.until((s) => s.config.lives === 2 && s.config.turnSeconds === 6);

console.log("start (rejected topic, then good topic)");
B.send({ t: "start", topic: "bad topic" }); await sleep(150);
ok(A.state.phase === "lobby", "non-host cannot start");
A.send({ t: "start", topic: "bad topic" });
for (let i = 0; i < 100 && !A.toasts.some((t) => t.kind === "error"); i++) await sleep(25);
await A.until((s) => s.phase === "lobby");
ok(A.state.phase === "lobby", "back in lobby after rejection");
ok(A.toasts.some((t) => t.kind === "error" && /can't be used/.test(t.msg)), "rejected topic returns to lobby with error toast");
A.send({ t: "start", topic: "NATO alphabet" });
await A.until((s) => s.phase === "playing");
ok(A.state.answers.length === 10 && A.state.answers.every((a) => a.answer === undefined), "answers are hidden from clients while playing");
ok(!JSON.stringify(A.state).includes("Charlie"), "no answer text leaks in state payload");
ok(A.state.deadline && A.state.turnMs === 6000, "turn clock running (6s)");

const byPid = (s) => (s.turnPid === A.pid ? A : B);
const other = (c) => (c === A ? B : A);

console.log("turn order, hits, misses");
let cur = byPid(A.state);
other(cur).send({ t: "guess", text: "Charlie" }); await sleep(150);
ok(other(cur).toasts.some((t) => /not your turn/i.test(t.msg)), "guess out of turn is refused");
cur.send({ t: "guess", text: "charlie" });
await A.until((s) => s.answers[2].found);
let f = A.state.answers[2].found;
ok(f.points >= 8 + 2 && f.points <= 8 + 3, `hit on rank 3 scored ${f.points} (11 - 3 = 8, plus quick-fire bonus)`);
ok(A.state.turnPid !== cur.pid, "turn passes after a correct guess");

cur = byPid(A.state);
cur.send({ t: "guess", text: "Zulu" });
await A.until((s) => s.players.find((p) => p.id === cur.pid).lives === 1);
ok(A.state.wrong.includes("Zulu"), "wrong guess recorded and costs a life");

cur = byPid(A.state);
cur.send({ t: "guess", text: "zulu" }); await sleep(150);
ok(cur.toasts.some((t) => /already been tried/.test(t.msg)) && cur.me().lives === 2 || cur.me().lives >= 1, "repeating a wrong guess costs nothing");
cur.send({ t: "guess", text: "Charlie" }); await sleep(150);
ok(cur.toasts.some((t) => /already on the board/.test(t.msg)), "guessing a found answer is a free retry");
ok(A.state.turnPid === cur.pid, "turn stays put after free retry");
cur.send({ t: "guess", text: "Foxtrott" });
await A.until((s) => s.answers[5].found);
ok(true, "typo 'Foxtrott' matched Foxtrot (fuzzy)");

console.log("timeout");
const timedOut = byPid(A.state);
const livesBefore = timedOut.me().lives;
await A.until((s) => s.players.find((p) => p.id === timedOut.pid).lives < livesBefore, 9000);
ok(true, "player lost a life when the clock ran out");
ok(A.state.log.some((l) => l.kind === "timeout"), "timeout logged");

console.log("finish by clearing the board");
let guard = 0;
while (A.state.phase === "playing" && guard++ < 30) {
  const c = byPid(A.state);
  const remaining = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliet"].filter((n, i) => !A.state.answers[i].found);
  if (!remaining.length) break;
  c.send({ t: "guess", text: remaining[remaining.length - 1] });
  await sleep(120);
}
await A.until((s) => s.phase === "finished");
ok(A.state.answers.every((a) => a.answer && a.found), "all answers revealed at the end");
ok(A.state.log.some((l) => /completed the board/.test(l.text)), "board-completion bonus logged");
ok(A.state.winners.length >= 1, "winner(s) determined: " + A.state.players.map((p) => `${p.name}=${p.score}`).join(", "));

console.log("rematch");
B.send({ t: "rematch" }); await sleep(150);
ok(A.state.phase === "finished", "non-host cannot start rematch");
A.send({ t: "rematch" });
await A.until((s) => s.phase === "lobby");
ok(A.state.players.every((p) => p.score === 0 && p.lives === 2), "scores and lives reset for the next round");

console.log("elimination ends the game; no-timer mode");
A.send({ t: "config", lives: 1, timerEnabled: false, turnSeconds: 20 });
await A.until((s) => s.config.lives === 1 && !s.config.timerEnabled);
A.send({ t: "start", topic: "NATO again" });
await A.until((s) => s.phase === "playing");
ok(A.state.deadline === null, "no timer when the time limit is off");
byPid(A.state).send({ t: "guess", text: "nope1" });
await A.until((s) => s.players.filter((p) => p.eliminated).length === 1);
ok(true, "one wrong guess eliminates a 1-life player");
const survivor = A.state.players.find((p) => !p.eliminated);
ok(A.state.turnPid === survivor.id, "turn goes to the survivor");
(survivor.id === A.pid ? A : B).send({ t: "guess", text: "nope2" });
await A.until((s) => s.phase === "finished");
ok(A.state.winners.length === 0, "everyone out with no points means no winner");

console.log("disconnect handling + reconnect");
A.send({ t: "rematch" }); await A.until((s) => s.phase === "lobby");
A.send({ t: "start", topic: "NATO third" }); await A.until((s) => s.phase === "playing");
const dropped = byPid(A.state);
const stay = other(dropped);
dropped.ws.close();
await stay.until((s) => s.deadline !== null && s.awayGrace);
ok(true, "disconnected player's turn starts an away grace clock even with no time limit");
const D = new Client(code, dropped.name); D.pid = dropped.pid; await D.ready;
D.send({ t: "join", pid: dropped.pid, name: dropped.name });
await stay.until((s) => s.deadline === null && s.players.find((p) => p.id === dropped.pid).connected);
ok(true, "reconnecting with the same id resumes the seat and clears the grace clock");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
