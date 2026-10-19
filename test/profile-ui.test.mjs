import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const errors = [];
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<link[^>]*fonts[^>]*>/g, "").replace(/<script src="[^"]*" defer><\/script>/g, "");
const src = ["app.js", "daily.js", "ranked.js", "profile.js"].map((f) => fs.readFileSync(new URL("../public/" + f, import.meta.url), "utf8"));

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
  async signIn(provider, sub) { const s = await this.req(`/api/auth/${provider}/start`); const a = await this.req(s.headers.get("location") + "&as=" + sub); return this.req(a.headers.get("location")); }
  async link(provider, sub) { const s = await this.req(`/api/auth/${provider}/start?link=1`); const a = await this.req(s.headers.get("location") + "&as=" + sub); return this.req(a.headers.get("location")); }
  async player(sub, name) { await this.signIn("mock", sub); const n = await this.post("/api/me/name", { name }); if (n.error) throw new Error(n.error); return this; }
}

async function page(hash, browser) {
  const vc = new VirtualConsole(); vc.on("jsdomError", (e) => errors.push(e.message)); vc.on("error", (e) => errors.push(String(e)));
  const dom = new JSDOM(html, { url: BASE + "/" + hash, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = (u, o = {}) => { const headers = { ...(o.headers || {}) }; if (browser) headers.cookie = browser.cookie(); if (o.method === "POST") headers.Origin = BASE; return fetch(new URL(u, BASE), { ...o, headers, redirect: "manual" }); };
  w.confirm = () => true;
  for (const code of src) w.eval(code);
  const $ = (s) => w.document.querySelector(s); const $$ = (s) => [...w.document.querySelectorAll(s)];
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(40); } return false; };
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const submit = (f) => f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  const go = async (h) => { w.location.hash = h; await sleep(120); };
  return { w, $, $$, until, click, submit, go };
}

const pat = await new Browser().player("pui-pat", "Pat");
const quin = await new Browser().player("pui-quin", "Quin2");
const rae = await new Browser().player("pui-rae", "Rae");
const sam = await new Browser().player("pui-sam", "Sam"); await sam.post("/api/me/settings", { profilePublic: false });
const tom = await new Browser().player("pui-tom", "Tom1"); await tom.post("/api/me/settings", { allowRequests: false });

console.log("friends card on the Ranked hub");
const hub = await page("#/ranked", pat);
ok(await hub.until(() => !hub.$("#ranked-hub").hidden && /No friends yet/.test(hub.$("#fr-list").textContent)), "starts empty");
hub.$("#fr-add-name").value = "Nobody"; hub.submit(hub.$("#fr-add-form"));
ok(await hub.until(() => /No player with that username/.test(hub.$("#toasts").textContent)), "adding an unknown username explains why it failed");
hub.$("#fr-add-name").value = "quin2"; hub.submit(hub.$("#fr-add-form"));
ok(await hub.until(() => !hub.$("#fr-sent").hidden && /Quin2/.test(hub.$("#fr-outgoing").textContent) && /Request sent to quin2/.test(hub.$("#toasts").textContent)), "sending a request (any capitalisation) shows it under Sent");
hub.click(hub.$("#fr-outgoing [data-fr=cancel]"));
ok(await hub.until(() => hub.$("#fr-sent").hidden), "a sent request can be cancelled");
hub.$("#fr-add-name").value = "Quin2"; hub.submit(hub.$("#fr-add-form"));
await hub.until(() => !hub.$("#fr-sent").hidden);
await quin.post("/api/friends/accept", { name: "Pat" });
await rae.post("/api/friends/request", { name: "Pat" });
await hub.go("#/"); await hub.go("#/ranked");
ok(await hub.until(() => /Quin2/.test(hub.$("#fr-list").textContent) && hub.$("#fr-sent").hidden), "once they accept, they appear in your friends list");
ok(!hub.$("#fr-requests").hidden && /Rae/.test(hub.$("#fr-incoming").textContent) && hub.$$("#fr-incoming [data-fr]").map((b) => b.dataset.fr).join() === "accept,decline", "an incoming request appears with Accept and Decline");
hub.click(hub.$("#fr-incoming [data-fr=accept]"));
ok(await hub.until(() => hub.$("#fr-requests").hidden && /Rae/.test(hub.$("#fr-list").textContent) && /\(2\)/.test(hub.$("#fr-count").textContent)), "accepting moves them into your friends (and the count updates)");
ok(hub.$("#fr-list a.plink").getAttribute("href") === "#/u/Quin2", "friends' names link to their profiles");

console.log("another player's profile");
const pp = await page("#/u/Quin2", pat);
ok(await pp.until(() => /Quin2/.test(pp.$("#pl-body").textContent) && !!pp.$("#pl-body svg.av")), "opens from the link and shows their name and picture");
ok(/1200/.test(pp.$("#pl-body .rating-big").textContent) && /Provisional rating/.test(pp.$("#pl-body").textContent) && /member since/.test(pp.$("#pl-body").textContent), "with their rating and member-since");
ok(!!pp.$(".friend-badge") && !!pp.$("[data-act=remove]") && pp.$$("#pl-body .stat").length === 5 && /No ranked games yet/.test(pp.$("#pl-body").textContent), "a friend: badge, Remove button, full stats and recent games");
pp.click(pp.$("[data-act=remove]"));
ok(await pp.until(() => !!pp.$("[data-act=request]") && !pp.$(".friend-badge")), "removing a friend turns the button back into Add friend");
pp.click(pp.$("[data-act=request]"));
ok(await pp.until(() => !!pp.$("[data-act=cancel]") && /Request sent/.test(pp.$("#pl-body").textContent)), "Add friend sends a request and offers to cancel it");
await quin.post("/api/friends/accept", { name: "Pat" });
await pp.go("#/ranked"); await pp.go("#/u/Quin2");
ok(await pp.until(() => !!pp.$(".friend-badge")), "(and accepting on their side makes you friends again)");
await pp.go("#/u/Rae");
ok(await pp.until(() => /Rae/.test(pp.$("#pl-body .profile-name").textContent)), "opening another profile from the address works");
await pp.go("#/u/Pat");
ok(await pp.until(() => /Pat/.test(pp.$("#pl-body .profile-name").textContent) && pp.$("#pl-body .pl-actions a").getAttribute("href") === "#/me"), "your own profile page offers 'Edit your profile'");
await pp.go("#/u/Sam");
ok(await pp.until(() => /Private profile/.test(pp.$("#pl-body").textContent) && pp.$$("#pl-body .stat").length === 0 && /1200/.test(pp.$("#pl-body .rating-big").textContent)), "a private profile shows only name, picture and rating to non-friends");
await pp.go("#/u/Tom1");
ok(await pp.until(() => /isn't accepting friend requests/.test(pp.$("#pl-body").textContent) && !pp.$("[data-act=request]")), "a player who turned requests off can't be asked");
await pp.go("#/u/Nobody%20Here");
ok(await pp.until(() => /Player not found/.test(pp.$("#pl-body").textContent)), "an unknown username shows a friendly message");
ok((await page("#/u/Quin2", null)).w.location.hash === "#/u/Quin2" && await (async () => { const g = await page("#/u/Quin2", null); await sleep(600); return g.w.location.hash === "#/ranked"; })(), "signed-out visitors are sent to the Ranked sign-in instead");

console.log("your profile screen");
const me = await page("#/me", pat);
ok(await me.until(() => /Signed in as Pat/.test(me.$("#me-sub").textContent)), "opens from the hub link and says who you are");
ok(me.$$("#av-colors .swatch").length === 12 && me.$$("#av-icons .swatch").length === 12 && !!me.$("#me-avatar svg"), "picture: 12 colours and 12 pictures, with a preview");
me.click(me.$('#av-colors [data-color="3"]')); me.click(me.$('#av-icons [data-icon="5"]')); me.click(me.$("#av-save"));
ok(await me.until(async () => true) && await (async () => { await sleep(500); return (await pat.json("/api/me")).avatar === "3:5"; })(), "choosing and saving a picture works");
ok(me.$("#me-name").value === "Pat" && !me.$("#me-name").disabled, "username field starts with your name");
me.$("#me-name").value = "PatNew"; me.submit(me.$("#me-name-form"));
ok(await me.until(() => me.$("#me-name").disabled && /again on \d{4}-\d{2}-\d{2}/.test(me.$("#me-name-note").textContent)), "changing it works, then the form locks with the date you can change it again");
ok((await pat.json("/api/me")).name === "PatNew", "(the new username is saved)");
ok(me.$$("#me-identities li").length === 2 && /Test provider/.test(me.$$("#me-identities li")[0].textContent) && /Your only sign-in/.test(me.$$("#me-identities li")[0].textContent) && !me.$("[data-unlink]"), "linked accounts: your one method, with no way to unlink your only sign-in");
const link = me.$("#me-identities a.btn");
ok(/Second test provider/.test(me.$$("#me-identities li")[1].textContent) && link.getAttribute("href") === "/api/auth/mock2/start?link=1", "other providers show a Link button that starts the linking flow");
const done = await pat.link("mock2", "pui-pat-2");
ok(done.headers.get("location") === "/?linked=mock2#/me", "(linking completes and returns to the profile page)");
const me2 = await page("?linked=mock2#/me", pat);
ok(await me2.until(() => /Second test provider linked/.test(me2.$("#toasts").textContent)) && me2.w.location.search === "", "coming back from linking shows a confirmation and tidies the address");
ok(await me2.until(() => me2.$$("[data-unlink]").length === 2), "both methods can now be unlinked");
me2.click(me2.$$("[data-unlink]")[1]);
ok(await me2.until(() => me2.$$("#me-identities li").length === 2 && me2.$$("[data-unlink]").length === 0), "unlinking one returns you to a single method");
const me3 = await page("?linkerror=taken#/me", pat);
ok(await me3.until(() => /already used by another Tenfold account/.test(me3.$("#toasts").textContent)), "a link that can't be made explains why");
me.$("#me-allow").checked = false; me.$("#me-allow").dispatchEvent(new me.w.Event("change", { bubbles: true }));
me.$("#me-public").checked = false; me.$("#me-public").dispatchEvent(new me.w.Event("change", { bubbles: true }));
await sleep(500);
const prv = await pat.json("/api/me/profile");
ok(prv.allowRequests === false && prv.profilePublic === false, "privacy switches are saved");
ok(/Member since [A-Z][a-z]+ \d{4}/.test(me.$("#me-since").parentElement.textContent), "member-since is shown");

console.log("sign out and delete live here");
ok(!!me.$("#me-signout") && !!me.$("#me-delete") && me.$("#me-delete").classList.contains("btn-danger"), "the profile screen has Sign out and a Delete my account button");
me.click(me.$("#me-signout"));
ok(await me.until(() => me.w.location.hash === "#/ranked" && !me.$("#ranked-signin").hidden), "signing out returns you to the Ranked sign-in");
ok((await pat.json("/api/me")).signedIn === false, "and the session is gone");
const gone = await new Browser().player("pui-gone", "Gone1");
const dp = await page("#/me", gone);
await dp.until(() => /Signed in as Gone1/.test(dp.$("#me-sub").textContent));
dp.click(dp.$("#me-delete"));
ok(await dp.until(() => dp.w.location.hash === "#/ranked") && (await gone.json("/api/me")).signedIn === false, "deleting your account signs you out and returns to Ranked");
ok((await quin.json("/api/players/Gone1")).httpStatus === 404, "and the profile no longer exists");
ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nPROFILE SCREEN CHECKS PASSED"); process.exit(failures ? 1 : 0);
