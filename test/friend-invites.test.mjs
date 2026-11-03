const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, message) => { console.log(condition ? "  PASS" : "  FAIL", message); if (!condition) failures++; };

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
      const key = pair.slice(0, index), value = pair.slice(index + 1);
      if (!value || /Max-Age=0/i.test(cookie)) this.jar.delete(key);
      else this.jar.set(key, value);
    }
    return response;
  }
  async json(path, options) {
    const response = await this.req(path, options);
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { statusCode: response.status, text, ...data };
  }
  post(path, body) {
    return this.json(path, { method: "POST", headers: { "content-type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) });
  }
  async player(providerId, name) {
    const start = await this.req("/api/auth/mock/start");
    const auth = await this.req(`${start.headers.get("location")}&as=${providerId}`);
    await this.req(auth.headers.get("location"));
    const result = await this.post("/api/me/name", { name });
    if (result.error) throw new Error(result.error);
    this.name = name;
    return this;
  }
  room(code) { return new RoomClient(code, this); }
}

class RoomClient {
  constructor(code, browser) {
    this.state = null;
    const headers = { Origin: BASE };
    if (browser.jar.size) headers.Cookie = browser.cookie();
    this.ws = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers });
    this.ready = new Promise((resolve) => {
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ t: "join", pid: `player-${Math.random().toString(36).slice(2, 12)}`, name: browser.name }));
        resolve();
      };
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === "state") this.state = message;
    };
  }
  async until(predicate, timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.state && predicate(this.state)) return this.state;
      await sleep(30);
    }
    throw new Error(`Room timed out: ${JSON.stringify(this.state && { phase: this.state.phase, ranked: !!this.state.ranked })}`);
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  close() { this.ws.close(); }
}

async function friends(first, second) {
  await first.post("/api/friends/request", { name: second.name });
  const result = await second.post("/api/friends/accept", { name: first.name });
  if (result.error) throw new Error(result.error);
}

console.log("game invitations are private to friends and preserve the sender's selected mode");
const ratedA = await new Browser().player("invite-rated-a", "RatedA");
const ratedB = await new Browser().player("invite-rated-b", "RatedB");
const casualA = await new Browser().player("invite-casual-a", "CasualA");
const casualB = await new Browser().player("invite-casual-b", "CasualB");
await Promise.all([friends(ratedA, ratedB), friends(casualA, casualB)]);

const outsider = await new Browser().player("invite-outside", "Outside");
ok((await outsider.post("/api/ranked/invites", { name: "RatedB", mode: "rated" })).statusCode === 403, "only an accepted friend can receive a game invitation");
ok((await ratedA.post("/api/ranked/invites", { name: "RatedB", mode: "other" })).statusCode === 400, "the sender must choose a supported game mode");

const declined = await casualA.post("/api/ranked/invites", { name: "CasualB", mode: "casual" });
const incomingCasual = await casualB.json("/api/friends");
ok(declined.status === "pending" && incomingCasual.incomingInvites[0]?.mode === "casual", "incoming invites identify the sender-selected casual mode");
await casualB.post("/api/ranked/invites/decline", { id: declined.id });
ok((await casualA.json("/api/friends")).outgoingInvites.length === 0, "a recipient can decline an invitation");

const ratedInvite = await ratedA.post("/api/ranked/invites", { name: "RatedB", mode: "rated" });
const duplicate = await ratedA.post("/api/ranked/invites", { name: "RatedB", mode: "casual" });
ok(ratedInvite.status === "pending" && duplicate.statusCode === 409, "only one active invitation is allowed between a friend pair");
const ratedStart = await ratedB.post("/api/ranked/invites/accept", { id: ratedInvite.id });
const ratedOutgoing = await ratedA.json("/api/friends");
ok(ratedStart.status === "accepted" && ratedStart.mode === "rated" && ratedOutgoing.outgoingInvites[0]?.code === ratedStart.code, "accepting creates a rated match code visible to both friends");
const ratedRoomA = ratedA.room(ratedStart.code), ratedRoomB = ratedB.room(ratedStart.code);
await Promise.all([ratedRoomA.ready, ratedRoomB.ready]);
const ratedState = await ratedRoomA.until((state) => state.phase === "playing" && !!state.ranked);
await ratedRoomB.until((state) => state.phase === "playing" && !!state.ranked);
ok(ratedState.ranked.players.length === 2, "rated invitations enter the normal account-verified Ranked match");
ratedRoomA.close(); ratedRoomB.close();

const casualInvite = await casualA.post("/api/ranked/invites", { name: "CasualB", mode: "casual" });
const casualStart = await casualB.post("/api/ranked/invites/accept", { id: casualInvite.id });
const casualOutgoing = await casualA.json("/api/friends");
ok(casualStart.status === "accepted" && casualStart.mode === "casual" && casualOutgoing.outgoingInvites[0]?.code === casualStart.code, "accepting creates a casual room code available to the sender");
const casualRoomA = casualA.room(casualStart.code), casualRoomB = casualB.room(casualStart.code);
await Promise.all([casualRoomA.ready, casualRoomB.ready]);
await casualRoomA.until((state) => state.phase === "lobby" && state.players.length === 2);
casualRoomA.send({ t: "start", topic: "casual invitation test" });
const casualState = await casualRoomA.until((state) => state.phase === "playing");
ok(!casualState.ranked, "casual invitations start a normal unranked game room");
casualRoomA.close(); casualRoomB.close();

console.log(failures ? `\n${failures} FAILURE(S)` : "\nFRIEND INVITATION CHECKS PASSED");
process.exit(failures ? 1 : 0);
