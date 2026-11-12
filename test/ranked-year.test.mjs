const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, message) => { console.log(condition ? "  PASS" : "  FAIL", message); if (!condition) failures++; };
const admin = (path, body) => fetch(BASE + path, {
  method: "POST",
  headers: { Authorization: "Bearer admintok", "content-type": "application/json", Origin: BASE },
  body: JSON.stringify(body),
}).then((response) => response.json());

class Browser {
  jar = new Map();
  cookie() { return [...this.jar].map(([key, value]) => `${key}=${value}`).join("; "); }
  async req(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.jar.size) headers.cookie = this.cookie();
    const response = await fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...options, headers });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      this.jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async json(path, options) {
    const response = await this.req(path, options);
    return { statusCode: response.status, ...(await response.json()) };
  }
  post(path, body) {
    return this.json(path, { method: "POST", headers: { "content-type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) });
  }
  async player(providerId, name) {
    const start = await this.req("/api/auth/mock/start");
    const auth = await this.req(`${start.headers.get("location")}&as=${providerId}`);
    await this.req(auth.headers.get("location"));
    await this.post("/api/me/name", { name });
    return this;
  }
  room(code) {
    const headers = { Origin: BASE, Cookie: this.cookie() };
    const ws = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers });
    let state = null;
    const ready = new Promise((resolve) => ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "join", pid: `rank-year-${Math.random().toString(36).slice(2, 10)}`, name: "Player" }));
      resolve();
    }));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.t === "state") state = message;
    });
    return {
      ws,
      ready,
      async until(predicate, timeoutMs = 9000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (state && predicate(state)) return state;
          await sleep(30);
        }
        throw new Error(`Room timed out: ${JSON.stringify(state && { phase: state.phase, topic: state.topic })}`);
      },
    };
  }
}

const list = (year) => ({
  title: `Top products in ${year}`,
  basis: `Annual sales during ${year}`,
  source: `Test dataset ${year}`,
  answers: Array.from({ length: 10 }, (_, index) => ({ answer: `Product ${year} ${index + 1}`, aliases: [] })),
});

console.log("Ranked games choose the newest available data year");
const older = await admin("/api/admin/pool", { list: list(2023) });
const newer = await admin("/api/admin/pool", { list: list(2025) });
ok(older.ok && newer.ok, "test lists are added to the ranked pool");
const a = await new Browser().player("year-a", "YearA");
const b = await new Browser().player("year-b", "YearB");
await a.post("/api/ranked/queue");
await b.post("/api/ranked/queue");
let matched;
for (let i = 0; i < 50; i++) {
  matched = await a.json("/api/ranked/status");
  if (matched.status === "matched") break;
  await sleep(100);
}
ok(matched?.status === "matched", "two players receive a Ranked match");
if (matched?.status === "matched") {
  const first = a.room(matched.code), second = b.room(matched.code);
  await Promise.all([first.ready, second.ready]);
  const state = await first.until((value) => value.phase === "playing" && !!value.ranked);
  await second.until((value) => value.phase === "playing" && !!value.ranked);
  ok(state.topic === "Top products in 2025", `selects the most recent available year (got "${state.topic}")`);
  first.ws.close(); second.ws.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nRANKED YEAR CHECKS PASSED");
process.exit(failures ? 1 : 0);
