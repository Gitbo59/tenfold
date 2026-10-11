const BASE = "http://localhost:8788";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const code = (await (await fetch(BASE + "/api/rooms", { method: "POST" })).json()).code;
const pid = "pid-idle-12345678";
const connect = () => new Promise((res) => { const w = new WebSocket(`ws://localhost:8788/ws/${code}`, { headers: { Origin: BASE } }); const o = { w, closed: null, state: null }; w.onopen = () => { w.send(JSON.stringify({ t: "join", pid, name: "Idle" })); res(o); }; w.onclose = (e) => (o.closed = e.code); w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") o.state = m; }; });
const a = await connect(); await sleep(300);
ok(a.state && a.state.players.length === 1, "joined");
const t0 = Date.now(); const ping = setInterval(() => a.w.readyState === 1 && a.w.send(JSON.stringify({ t: "ping" })), 500);
while (a.closed === null && Date.now() - t0 < 12000) await sleep(100);
clearInterval(ping);
ok(a.closed === 4001, `idle room closed the socket with code 4001 after ${((Date.now() - t0) / 1000).toFixed(1)}s even though pings kept arriving`);
const b = await connect(); await sleep(400);
ok(b.state && b.state.players.length === 1 && b.state.players[0].name === "Idle", "same player rejoins the same room and keeps their seat");
// activity keeps a room alive: a config-free action stream (join counts as activity; here we send guesses-free pings only above) -> verify an active room is NOT closed
const t1 = Date.now(); let kicked = false;
while (Date.now() - t1 < 2500) { b.w.send(JSON.stringify({ t: "config", lives: 3 })); await sleep(300); if (b.closed !== null) kicked = true; }
ok(!kicked, "a room with ongoing activity is not closed");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nIDLE CHECKS PASSED"); process.exit(failures ? 1 : 0);
