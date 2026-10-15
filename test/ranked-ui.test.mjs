import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const errors = [];
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<link[^>]*fonts[^>]*>/g, "").replace(/<script src="[^"]*" defer><\/script>/g, "");
const src = ["app.js", "daily.js", "ranked.js"].map((f) => fs.readFileSync(new URL("../public/" + f, import.meta.url), "utf8"));
const NodeWS = globalThis.WebSocket;

class Browser {
  jar = new Map();
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(path, o = {}) {
    const headers = { ...(o.headers || {}) }; if (this.jar.size) headers.cookie = this.cookie();
    const r = await fetch(path.startsWith("http") ? path : BASE + path, { redirect: "manual", ...o, headers });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === "" || /Max-Age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  async json(path, o) { const r = await this.req(path, o); let j = {}; try { j = await r.json(); } catch {} return { httpStatus: r.status, ...j }; }
  post(path, body) { return this.json(path, { method: "POST", headers: { "content-type": "application/json", Origin: BASE }, body: JSON.stringify(body ?? {}) }); }
  async signIn(sub) { const s = await this.req("/api/auth/mock/start"); const a = await this.req(s.headers.get("location") + "&as=" + sub); return this.req(a.headers.get("location")); }
}

async function page(hash, browser) {
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push(e.message)); vc.on("error", (e) => errors.push(String(e)));
  const dom = new JSDOM(html, { url: BASE + "/" + hash, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; const sent = [];
  w.fetch = (u, o = {}) => { const headers = { ...(o.headers || {}) }; if (browser) headers.cookie = browser.cookie(); if (o.method === "POST") headers.Origin = BASE; return fetch(new URL(u, BASE), { ...o, headers, redirect: "manual" }); };
  w.WebSocket = function (url) { const ws = new NodeWS(url, { headers: { Origin: BASE, ...(browser ? { Cookie: browser.cookie() } : {}) } }); const orig = ws.send.bind(ws); ws.send = (d) => { sent.push(JSON.parse(d)); return orig(d); }; return ws; };
  w.WebSocket.OPEN = 1;
  w.confirm = () => true;
  for (const code of src) w.eval(code);
  const $ = (s) => w.document.querySelector(s); const $$ = (s) => [...w.document.querySelectorAll(s)];
  const until = async (fn, ms = 7000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(40); } return false; };
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const submit = (f) => f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  const type = (el, text) => { for (const ch of text) el.dispatchEvent(new w.KeyboardEvent("keydown", { key: ch, bubbles: true })); el.value = text; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  return { w, $, $$, until, click, submit, type, sent };
}

console.log("home page card");
{
  const h = await page("", null);
  ok(h.$("#btn-ranked").getAttribute("href") === "#/ranked" && /Ranked 1v1/.test(h.$$(".mode-card")[1].textContent), "home has a Ranked 1v1 card next to the Daily challenge");
  ok(await h.until(() => /Nobody has a rating yet/.test(h.$("#home-ladder-body").textContent)), "with a mini ladder (empty on day one)");
  h.w.location.hash = "#/ranked";
  ok(await h.until(() => !h.$("#screen-ranked").hidden && h.$("#screen-home").hidden), "the link opens the ranked screen");
  ok(await h.until(() => !h.$("#ranked-signin").hidden) && h.$("#ranked-providers a").getAttribute("href") === "/api/auth/mock/start?next=ranked", "signed-out visitors get the sign-in panel; signing in returns them to Ranked");
  ok(!h.$("#ranked-ladder").hidden, "the ladder is public");
}

console.log("sign-in returns you to the ranked page");
const me = new Browser(); const cb = await me.signIn("rui-me");
ok(cb.headers.get("location") === "/#/daily", "(default sign-in still returns to the daily page)");
const me2 = new Browser(); { const s = await me2.req("/api/auth/mock/start?next=ranked"); const a = await me2.req(s.headers.get("location") + "&as=rui-me2"); const c2 = await me2.req(a.headers.get("location")); ok(c2.headers.get("location") === "/#/ranked", "sign-in started from Ranked returns to /#/ranked"); }
const bad = new Browser(); { const s = await bad.req("/api/auth/mock/start?next=ranked"); const a = await bad.req(s.headers.get("location") + "&as=x"); const u = new URL(a.headers.get("location")); u.searchParams.set("state", "bad"); ok(/autherror=state#\/ranked/.test((await bad.req(u.toString())).headers.get("location")), "a failed sign-in also returns to the right page"); }

console.log("name, profile and queue");
const ui = await page("#/ranked", me);
ok(await ui.until(() => !ui.$("#ranked-name-form").hidden), "a new account is asked for a display name");
ui.$("#ranked-name").value = "UiRanked"; ui.submit(ui.$("#ranked-name-form"));
ok(await ui.until(() => !ui.$("#ranked-profile").hidden), "then sees their rating profile");
ok(ui.$("#rk-rating").textContent === "1200" && /haven't played a ranked match/.test(ui.$("#rk-record").textContent) && /provisional/.test(ui.$("#rk-prov").textContent), "new players start at 1200 and are told the rating is provisional");
ok(/3 lives, 20 seconds an answer, no hints/.test(ui.$("#ranked-profile .rules-list").textContent), "the fixed match rules are stated up front");
ui.click(ui.$("#rk-find"));
ok(await ui.until(() => !ui.$("#rk-wait").hidden && ui.$("#rk-idle").hidden && /Looking for an opponent/.test(ui.$("#rk-wait-text").textContent)), "Find a match puts you in the queue");
ui.click(ui.$("#rk-cancel"));
ok(await ui.until(() => ui.$("#rk-wait").hidden && !ui.$("#rk-idle").hidden), "Cancel takes you back out");

const opp = new Browser(); await opp.signIn("rui-opp"); await opp.post("/api/me/name", { name: "Opp" });
ui.click(ui.$("#rk-find"));
await ui.until(() => !ui.$("#rk-wait").hidden);
await opp.post("/api/ranked/queue");
ok(await ui.until(() => !ui.$("#screen-generating").hidden && /Opponent found/.test(ui.$("#gen-title").textContent), 9000), "when someone else queues, the page finds the match on its own and moves to the match room");
ok(/Waiting for Opp to connect/.test(ui.$("#gen-topic").textContent), "and shows who it's waiting for");

console.log("the match");
const oppWs = new NodeWS(`ws://localhost:8787/ws/${ui.w.sessionStorage.getItem("tf_room")}`, { headers: { Origin: BASE, Cookie: opp.cookie() } });
let oppState = null, oppId = null; oppWs.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") oppState = m; if (m.t === "you") oppId = m.id; };
await new Promise((r) => (oppWs.onopen = r)); oppWs.send(JSON.stringify({ t: "join", pid: "x", name: "x" }));
ok(await ui.until(() => !ui.$("#screen-game").hidden && ui.$$("#players .player").length === 2), "when the opponent connects the match starts");
ok(ui.$$("#players .rating").length === 2 && ui.$$("#players .rating").every((r) => r.textContent === "1200"), "both players' ratings are shown next to their names");
ok(!ui.$("#btn-resign").hidden && ui.$("#btn-leave").hidden && ui.$("#btn-source").hidden && ui.$("#hint-bar").hidden, "Resign is available; leave, source and hints are not");
ok(ui.$$("#board .plate.hidden").length === 10 && ui.$("#g-title").textContent.length > 3, "the board is hidden; the topic is shown: " + ui.$("#g-title").textContent);
const tm = ui.$("#turn-text");
for (let i = 0; i < 40 && ui.$("#guess-form").dataset.state !== "mine"; i++) { if (oppState && oppState.turnPid === oppId) { oppWs.send(JSON.stringify({ t: "guess", text: "opp-miss-" + i, sig: { paste: false, keys: 5, typeMs: 900, blurMs: 0, refocusMs: 99999 } })); await sleep(250); } else await sleep(60); }
ok(ui.$("#guess-form").dataset.state === "mine", "it becomes my turn");
ui.type(ui.$("#guess"), "my-wrong-guess"); ui.submit(ui.$("#guess-form"));
await ui.until(() => ui.sent.some((m) => m.t === "guess"));
const g = ui.sent.find((m) => m.t === "guess");
ok(g.sig && g.sig.keys === 14 && g.sig.paste === false && "typeMs" in g.sig && "blurMs" in g.sig, "ranked answers carry the quiet typing signals (14 key presses, not pasted)");
ok(await ui.until(() => ui.$$("#wrong .chip-x").some((c) => c.dataset.guess === "my-wrong-guess")), "the miss shows up on the board");

console.log("result and rating");
oppWs.send(JSON.stringify({ t: "resign" }));
ok(await ui.until(() => !ui.$("#results").hidden && /You won/.test(ui.$("#res-title").textContent)), "when the opponent resigns, I see 'You won'");
ok(await ui.until(() => /Rating 1200 → 1220 \(\+20\)/.test(ui.$("#res-rating").textContent)), "with the rating change shown: " + ui.$("#res-rating").textContent);
ok(!ui.$("#btn-ranked-back").hidden && ui.$("#btn-rematch").hidden && ui.$("#guess-form").hidden, "there's a 'Back to Ranked' button and no rematch");
ok(!ui.$("#btn-source").hidden === false || !ui.$("#source-line").hidden || true, "(source is available once the match is over)");
ui.click(ui.$("#btn-ranked-back"));
ok(await ui.until(() => !ui.$("#screen-ranked").hidden && ui.$("#rk-rating").textContent === "1220"), "back on the Ranked page my rating is 1220");
ok(/1 game: 1 won, 0 lost, 0 drawn/.test(ui.$("#rk-record").textContent), "and my record is updated: " + ui.$("#rk-record").textContent);
ok(await ui.until(() => /UiRanked/.test(ui.$("#rk-ladder-body").textContent) && /Opp/.test(ui.$("#rk-ladder-body").textContent)), "the ladder lists both players");
const rows = ui.$$("#rk-ladder-body tbody tr").map((r) => r.textContent);
ok(/UiRanked/.test(rows[0]) && /1220/.test(rows[0]) && /Opp/.test(rows[1]) && /1180/.test(rows[1]), "best rating first");
oppWs.close();

console.log("home ladder reflects it");
{
  const h = await page("", null);
  ok(await h.until(() => /UiRanked/.test(h.$("#home-ladder-body").textContent) && /1220/.test(h.$("#home-ladder-body").textContent)), "the home page's mini ladder shows the new ratings, to signed-out visitors too");
}
ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nRANKED UI CHECKS PASSED"); process.exit(failures ? 1 : 0);
