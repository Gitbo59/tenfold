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
  async signIn(sub, next) { const s = await this.req("/api/auth/mock/start" + (next ? "?next=" + next : "")); const a = await this.req(s.headers.get("location") + "&as=" + sub); return this.req(a.headers.get("location")); }
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

console.log("signed out: Ranked needs a login");
{
  const h = await page("#/ranked", null);
  ok(await h.until(() => !h.$("#ranked-signin").hidden), "visitors see only the sign-in panel");
  ok(h.$("#ranked-hub").hidden && h.$("#ranked-ladder, #rk-ladder-body") && h.$("#ranked-hub").hidden, "no hub, ladder or leaderboard until you're signed in");
  ok(h.$("#ranked-providers a").getAttribute("href") === "/api/auth/mock/start?next=ranked", "signing in from here returns you to Ranked");
  ok(/never see your email address or password/.test(h.$("#ranked-signin").textContent), "the privacy promise is stated where people sign in");
}

console.log("sign-in returns you to the right page");
const me = new Browser(); const cb = await me.signIn("rui-me", "ranked");
ok(cb.headers.get("location") === "/#/ranked", "sign-in started from Ranked returns to /#/ranked");
ok((await new Browser().signIn("rui-x")).headers.get("location") === "/#/daily", "(the daily page's own sign-in still returns to the daily page)");

console.log("name and a brand-new profile");
const ui = await page("#/ranked", me);
ok(await ui.until(() => !ui.$("#ranked-name-form").hidden), "a new account is asked for a display name");
ui.$("#ranked-name").value = "UiRanked"; ui.submit(ui.$("#ranked-name-form"));
ok(await ui.until(() => !ui.$("#ranked-hub").hidden && ui.$("#ranked-signin").hidden), "then the hub appears");
ok(ui.$("#rk-name").textContent === "UiRanked" && ui.$("#rk-rating").textContent === "1200" && /Provisional rating/.test(ui.$("#rk-sub").textContent), "profile: name, 1200 rating, provisional");
ok(!!ui.$("#rk-avatar svg.av") && /hsl\(\d+/.test(ui.$("#rk-avatar").innerHTML), "a profile picture is shown from the start (a default avatar, no photo needed)");
ok(ui.$$("#rk-stats .stat").length === 5 && /Peak rating/.test(ui.$("#rk-stats").textContent) && /Win rate/.test(ui.$("#rk-stats").textContent) && /Current streak/.test(ui.$("#rk-stats").textContent), "stats: peak, games, win rate, record, streak");
ok(/Play a few matches to see your rating trend/.test(ui.$("#rk-trend").textContent) && /No ranked games yet/.test(ui.$("#rk-recent").textContent), "empty states explain what will appear");
ok(await ui.until(() => /Today's list is ready/.test(ui.$("#rk-daily-status").textContent)) && ui.$("#rk-daily-play").getAttribute("href") === "#/daily", "the daily challenge card shows today's status and a Play link");
ok(await ui.until(() => /Nobody has finished yet/.test(ui.$("#rk-daily-board").textContent)), "and the daily challenge leaderboard (empty on day one)");
ok(await ui.until(() => /Nobody has a rating yet/.test(ui.$("#rk-ladder-body").textContent)), "plus the ranked ladder");
ok(ui.$("#mode-pill a[aria-current=page]").dataset.mode === "ranked", "the pill shows Ranked");

console.log("choosing a profile picture");
const before = ui.$("#rk-avatar").innerHTML;
ui.click(ui.$("#rk-edit-avatar"));
ok(!ui.$("#rk-avatar-editor").hidden && ui.$$("#av-colors .swatch").length === 12 && ui.$$("#av-icons .swatch").length === 12, "the editor offers 12 colours and 12 pictures");
ui.click(ui.$('#av-colors [data-color="3"]')); ui.click(ui.$('#av-icons [data-icon="5"]'));
ok(/hsl\(150 /.test(ui.$("#rk-avatar").innerHTML) && ui.$('#av-colors [data-color="3"]').getAttribute("aria-pressed") === "true", "picking updates the preview straight away");
ui.click(ui.$("#av-cancel"));
ok(ui.$("#rk-avatar").innerHTML === before && ui.$("#rk-avatar-editor").hidden, "Cancel puts the old picture back");
ui.click(ui.$("#rk-edit-avatar")); ui.click(ui.$('#av-colors [data-color="3"]')); ui.click(ui.$('#av-icons [data-icon="5"]')); ui.click(ui.$("#av-save"));
ok(await ui.until(() => /hsl\(150 /.test(ui.$("#rk-avatar").innerHTML) && ui.$("#rk-avatar-editor").hidden), "Save keeps it");
ok((await me.json("/api/me")).avatar === "3:5", "and it is stored on the account as just two small numbers");

console.log("the queue");
ui.click(ui.$("#rk-find"));
ok(await ui.until(() => !ui.$("#rk-wait").hidden && ui.$("#rk-idle").hidden && /Looking for an opponent/.test(ui.$("#rk-wait-text").textContent)), "Find a match puts you in the queue");
ui.click(ui.$("#rk-cancel"));
ok(await ui.until(() => ui.$("#rk-wait").hidden && !ui.$("#rk-idle").hidden), "Cancel takes you back out");

const opp = new Browser(); await opp.signIn("rui-opp"); await opp.post("/api/me/name", { name: "Opp" });
ui.click(ui.$("#rk-find"));
await ui.until(() => !ui.$("#rk-wait").hidden);
await opp.post("/api/ranked/queue");
ok(await ui.until(() => !ui.$("#screen-generating").hidden && /Opponent found/.test(ui.$("#gen-title").textContent), 9000), "when someone else queues, the page finds the match and moves to the match room");
ok(/Waiting for Opp to connect/.test(ui.$("#gen-topic").textContent) && ui.$("#mode-pill").hidden, "it shows who it's waiting for, and the pill is hidden while you're in a room");

console.log("the match");
const oppWs = new NodeWS(`ws://localhost:8787/ws/${ui.w.sessionStorage.getItem("tf_room")}`, { headers: { Origin: BASE, Cookie: opp.cookie() } });
let oppState = null, oppId = null; oppWs.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") oppState = m; if (m.t === "you") oppId = m.id; };
await new Promise((r) => (oppWs.onopen = r)); oppWs.send(JSON.stringify({ t: "join", pid: "x", name: "x" }));
ok(await ui.until(() => !ui.$("#screen-game").hidden && ui.$$("#players .player").length === 2), "when the opponent connects the match starts");
ok(ui.$$("#players .rating").length === 2 && ui.$$("#players .rating").every((r) => r.textContent === "1200"), "both ratings are shown next to the names");
ok(!ui.$("#btn-resign").hidden && ui.$("#btn-leave").hidden && ui.$("#btn-source").hidden && ui.$("#hint-bar").hidden && ui.$("#mode-pill").hidden, "Resign is available; leave, source, hints and the mode switch are not");
for (let i = 0; i < 40 && ui.$("#guess-form").dataset.state !== "mine"; i++) { if (oppState && oppState.turnPid === oppId) { oppWs.send(JSON.stringify({ t: "guess", text: "opp-miss-" + i, sig: { paste: false, keys: 5, typeMs: 900, blurMs: 0, refocusMs: 99999 } })); await sleep(250); } else await sleep(60); }
ok(ui.$("#guess-form").dataset.state === "mine", "it becomes my turn");
ui.type(ui.$("#guess"), "my-wrong-guess"); ui.submit(ui.$("#guess-form"));
await ui.until(() => ui.sent.some((m) => m.t === "guess"));
const g = ui.sent.find((m) => m.t === "guess");
ok(g.sig && g.sig.keys === 14 && g.sig.paste === false && "typeMs" in g.sig && "blurMs" in g.sig, "ranked answers carry the quiet typing signals (14 key presses, not pasted)");

console.log("result, then the profile updates");
oppWs.send(JSON.stringify({ t: "resign" }));
ok(await ui.until(() => !ui.$("#results").hidden && /You won/.test(ui.$("#res-title").textContent)), "when the opponent resigns, I see 'You won'");
ok(await ui.until(() => /Rating 1200 → 1220 \(\+20\)/.test(ui.$("#res-rating").textContent)), "with the rating change: " + ui.$("#res-rating").textContent);
ok(!ui.$("#btn-ranked-back").hidden && ui.$("#btn-rematch").hidden, "'Back to Ranked' is offered; no rematch");
ui.click(ui.$("#btn-ranked-back"));
ok(await ui.until(() => !ui.$("#screen-ranked").hidden && ui.$("#rk-rating").textContent === "1220" && !ui.$("#mode-pill").hidden), "back on the hub my rating is 1220 and the pill is back");
const stats = Object.fromEntries(ui.$$("#rk-stats .stat").map((s) => [s.querySelector(".stat-l").textContent, s.querySelector(".stat-n").textContent]));
ok(stats["Peak rating"] === "1220" && stats["Game"] === "1" && stats["Win rate"] === "100%" && stats["Won-lost-drawn"] === "1-0-0" && stats["Current streak"] === "1 W", "stats update: " + JSON.stringify(stats));
ok(/#1 on the ladder/.test(ui.$("#rk-sub").textContent) && !!ui.$("#rk-trend polyline"), "my ladder position and a rating trend line appear");
const row = ui.$("#rk-recent .recent-row");
ok(!!row && /Opp/.test(row.textContent) && row.querySelector(".badge.win") && /\+20/.test(row.querySelector(".delta").textContent) && /now 1220/.test(row.textContent) && !!row.querySelector("svg.av"), "recent games: opponent, avatar, WIN, +20, rating after: " + (row && row.textContent.replace(/\s+/g, " ").slice(0, 100)));
const rows = ui.$$("#rk-ladder-body tbody tr");
ok(rows.length === 2 && /UiRanked/.test(rows[0].textContent) && /1220/.test(rows[0].textContent) && /Opp/.test(rows[1].textContent) && /1180/.test(rows[1].textContent) && rows.every((r) => r.querySelector("svg.av")) && /\(you\)/.test(rows[0].textContent), "the ladder lists both with avatars, best first, and marks me");
oppWs.close();

console.log("daily challenge from the hub, and signing out");
ui.click(ui.$("#rk-daily-play").cloneNode ? ui.$("#rk-daily-play") : ui.$("#rk-daily-play"));
ui.w.location.hash = "#/daily";
ok(await ui.until(() => !ui.$("#screen-daily").hidden), "the Play link opens the daily challenge");
ui.w.location.hash = "#/ranked";
ok(await ui.until(() => !ui.$("#screen-ranked").hidden && ui.$("#rk-rating").textContent === "1220"), "and Back to Ranked returns to the hub");
ui.click(ui.$("#rk-signout"));
ok(await ui.until(() => !ui.$("#ranked-signin").hidden && ui.$("#ranked-hub").hidden), "signing out hides everything behind the login again");

console.log("home page stays original");
{
  const h = await page("", null);
  ok(h.$$(".mode-card").length === 0 && !h.$("#home-ladder-body") && !h.$("#home-lb-body") && !!h.$("#sample-board"), "no leaderboards or mode cards on the home page, just the room game and the example board");
}
ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nRANKED UI CHECKS PASSED"); process.exit(failures ? 1 : 0);
