import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const errors = []; const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<link[^>]*fonts[^>]*>/g, "").replace(/<script src="[^"]*" defer><\/script>/g, "");
const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const dailyJs = fs.readFileSync(new URL("../public/daily.js", import.meta.url), "utf8");
const ADMIN = { Authorization: "Bearer admintok", "content-type": "application/json", Origin: BASE };

/** Sign in the way a browser does (following the provider redirects), returning a cookie header. */
async function signIn(sub) {
  const jar = new Map();
  const grab = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookieHdr = () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
  const s = await fetch(BASE + "/api/auth/mock/start", { redirect: "manual" }); grab(s);
  const a = await fetch(s.headers.get("location") + "&as=" + sub, { redirect: "manual" });
  const cb = await fetch(a.headers.get("location"), { redirect: "manual", headers: cookieHdr() }); grab(cb);
  return () => cookieHdr().cookie;
}

async function page(hash, cookie) {
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push(e.message)); vc.on("error", (e) => errors.push(String(e)));
  const dom = new JSDOM(html, { url: BASE + "/" + hash, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; const reqs = [];
  w.fetch = (u, o = {}) => {
    const headers = { ...(o.headers || {}) }; if (cookie) headers.cookie = cookie(); if (o.method === "POST") headers.Origin = BASE;
    if (o.method === "POST") reqs.push({ url: String(u), body: o.body ? JSON.parse(o.body) : null });
    return fetch(new URL(u, BASE), { ...o, headers, redirect: "manual" });
  };
  w.confirm = () => true;
  w.eval(appJs); w.eval(dailyJs);
  const $ = (s) => w.document.querySelector(s); const $$ = (s) => [...w.document.querySelectorAll(s)];
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(40); } return false; };
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const submit = (form) => form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  const type = (el, text) => { for (const ch of text) el.dispatchEvent(new w.KeyboardEvent("keydown", { key: ch, bubbles: true })); el.value = text; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  return { w, $, $$, until, click, submit, type, reqs };
}

console.log("home page and the For fun / Ranked switch");
{
  const p = await page("", null);
  ok(!p.$("#screen-home").hidden && p.$$(".mode-card").length === 0 && !p.$("#btn-daily"), "the home page is the original room-based game: no ranked or daily cards on it");
  ok(p.$("#home-form") && p.$("#btn-create") && p.$("#sample-board") && p.$$("#sample-board .plate").length === 10, "with Create/Join room and the example board next to it");
  ok(!p.$("#mode-pill").hidden && p.$("#mode-pill a[aria-current=page]").dataset.mode === "fun" && p.$$("#mode-pill a").map((a) => a.textContent).join("|") === "For fun|Ranked", "a pill at the top reads For fun | Ranked, with For fun selected");
  ok(p.$("#mode-pill a[data-mode=ranked]").getAttribute("href") === "#/ranked", "Ranked links to the ranked page");
  p.w.location.hash = "#/ranked";
  ok(await p.until(() => !p.$("#screen-ranked").hidden && p.$("#screen-home").hidden && p.$("#mode-pill a[aria-current=page]").dataset.mode === "ranked"), "switching to Ranked opens the ranked page and highlights Ranked");
  p.w.location.hash = "#/";
  ok(await p.until(() => !p.$("#screen-home").hidden && p.$("#mode-pill a[aria-current=page]").dataset.mode === "fun"), "switching back to For fun returns to the home page");
  p.w.location.hash = "#/daily";
  ok(await p.until(() => !p.$("#screen-daily").hidden && p.$("#mode-pill a[aria-current=page]").dataset.mode === "ranked"), "the daily challenge belongs to the Ranked side");
  ok(p.$("#daily-back").getAttribute("href") === "#/ranked", "and its back link goes to Ranked");
}

console.log("signed out");
{
  const p = await page("#/daily", null);
  ok(await p.until(() => !p.$("#daily-signin").hidden), "visitors see the sign-in panel");
  const b = p.$$("#provider-buttons a");
  ok(b.length === 2 && b[0].getAttribute("href") === "/api/auth/mock/start" && /Continue with Test provider/.test(b[0].textContent), "one button per configured provider (the test setup has two)");
  ok(/never see your email address or password/.test(p.$("#daily-signin").textContent), "the privacy promise is stated where people sign in");
  ok(p.$("#daily-guess-form").hidden && p.$("#daily-play").hidden && p.$("a[href='/rules']"), "no play controls, and the rules link is present");
  ok(!p.$("#daily-board").hidden, "the leaderboard is public");
}

console.log("name, start and play");
const cookie = await signIn("ui-sub");
const p = await page("#/daily", cookie);
ok(await p.until(() => !p.$("#daily-name-form").hidden), "a new account is asked for a display name first");
p.$("#daily-name").value = "<b>"; p.submit(p.$("#daily-name-form"));
ok(await p.until(() => p.reqs.some((r) => r.url.includes("/me/name"))) && !p.$("#daily-name-form").hidden, "a bad name is refused and the form stays");
p.$("#daily-name").value = "UI Tester"; p.submit(p.$("#daily-name-form"));
ok(await p.until(() => !p.$("#daily-ready").hidden), "a good name moves on to the start screen");
ok(p.$("#acct-name").textContent === "UI Tester" && !p.$("#daily-account").hidden, "account bar shows who you are");
ok(/one attempt/.test(p.$(".rules-list").textContent) && /fair-play checks/.test(p.$(".rules-list").textContent), "the rules, including the fair-play notice, are shown before you start");
p.click(p.$("#daily-start"));
ok(await p.until(() => !p.$("#daily-play").hidden && !p.$("#daily-guess-form").hidden), "starting shows the board and answer box", 9000);
ok(p.$("#daily-topic").textContent === "NATO alphabet, first ten" && p.$$("#daily-list .plate.hidden").length === 10, "topic revealed, ten hidden plates");
ok(p.$$("#daily-stats .heart").length === 3 && p.$$("#daily-stats .heart.lost").length === 0, "three lives");
ok(Number(p.$("#daily-secs").textContent) >= 1 && Number(p.$("#daily-secs").textContent) <= 4, "a countdown is running: " + p.$("#daily-secs").textContent + "s");

p.type(p.$("#daily-guess"), "alpha"); p.submit(p.$("#daily-guess-form"));
ok(await p.until(() => p.$$("#daily-list .plate.found").length === 1), "a correct answer reveals its plate");
ok(/Alpha/.test(p.$("#daily-list .found").textContent) && /\+\d+/.test(p.$("#daily-list .found .pts").textContent) && Number(p.$("#daily-stats .big").textContent) > 0, "plate shows the answer and points; score updates");
const g1 = p.reqs.filter((r) => r.url.includes("/daily/guess")).at(-1).body;
ok(g1.text === "alpha" && g1.sig.keys === 5 && g1.sig.paste === false && g1.sig.typeMs >= 0, "typing is reported as 5 key presses, not pasted");
await sleep(350);
const box = p.$("#daily-guess"); box.value = "Bravo"; box.dispatchEvent(new p.w.Event("paste", { bubbles: true })); p.submit(p.$("#daily-guess-form"));
ok(await p.until(() => p.reqs.filter((r) => r.url.includes("/daily/guess")).length === 2), "second answer sent");
const g2 = p.reqs.filter((r) => r.url.includes("/daily/guess")).at(-1).body;
ok(g2.sig.paste === true && g2.sig.keys === 0, "a pasted answer is reported as pasted (quietly: nothing changes on screen)");
ok(await p.until(() => p.$$("#daily-list .plate.found").length === 2) && !/paste|flag|review|check/i.test(p.$("#daily-play").textContent), "the player sees nothing about the check");
await sleep(350);
p.type(p.$("#daily-guess"), "zzz"); p.submit(p.$("#daily-guess-form"));
ok(await p.until(() => p.$$("#daily-stats .heart.lost").length === 1), "a wrong answer costs a heart");
ok(await p.until(() => p.$$("#daily-stats .heart.lost").length === 2, 9000), "when the clock runs out the page asks the server and a life drains, even without typing");
ok(await p.until(() => !p.$("#daily-result").hidden && p.$("#daily-play").hidden && p.$("#daily-guess-form").hidden, 9000), "with no lives left the result screen replaces the board");
ok(/You scored \d+/.test(p.$("#daily-result-title").textContent) && /2 of 10 found, 1 wrong/.test(p.$("#daily-result-detail").textContent), "result: " + p.$("#daily-result-title").textContent + " / " + p.$("#daily-result-detail").textContent);
ok(/revealed after 00:00 UTC/.test(p.$("#daily-result-note").textContent) && !/Charlie|Delta|Juliet/.test(p.$("#daily-result").textContent), "missed answers are NOT shown (they're revealed tomorrow)");
ok(/AI-suggested, not verified/.test(p.$("#daily-source").textContent), "the source appears once you've finished, labelled unverified");

console.log("leaderboards");
ok(await p.until(() => p.$$("#lb-body table tr.me").length === 1 && /UI Tester/.test(p.$("#lb-body tr.me").textContent)), "you appear on today's board, highlighted");
p.click(p.$$(".tab")[1]);
ok(await p.until(() => /1 day/.test(p.$("#lb-body").textContent)), "the monthly tab shows days played");
await fetch(BASE + "/api/admin/daily", { method: "POST", headers: ADMIN, body: JSON.stringify({ date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), list: { title: "Yesterday", basis: "b", source: "s", answers: Array.from({ length: 10 }, (_, i) => ({ answer: "Old " + (i + 1) })) } }) });
p.click(p.$$(".tab")[2]);
ok(await p.until(() => p.$$("#lb-body .reveal-list li").length === 10 && /Old 1/.test(p.$("#lb-body").textContent)), "the yesterday tab reveals the whole list");

console.log("account links");
ok(!p.$("#btn-signout") && !p.$("#btn-delete"), "sign out and delete are no longer on the daily page");
ok(p.$("#acct-name").getAttribute("href") === "#/me" && p.$("#acct-name").textContent === "UI Tester", "the signed-in name links to your profile");
p.click(p.$$(".tab")[0]);
ok(await p.until(() => p.$$("#lb-body a.plink").length > 0) && p.$$("#lb-body a.plink")[0].getAttribute("href").startsWith("#/u/"), "leaderboard names link to player profiles");
ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nDAILY UI CHECKS PASSED"); process.exit(failures ? 1 : 0);
