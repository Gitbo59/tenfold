// A tiny fake "Sign in with ..." provider for tests. Implements authorize, token (with PKCE) and userinfo.
import http from "node:http";
import crypto from "node:crypto";
const codes = new Map(); const log = { authorize: [], token: [], userinfo: 0 };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:9998");
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (url.pathname === "/log") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(log)); }
    if (url.pathname === "/authorize" && !url.searchParams.get("as")) {
      // Opened by a person in a browser (tests always pass ?as=). Let them pick who to sign in as.
      const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      const hidden = [...url.searchParams].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
      const quick = ["Alice", "Bob", "Cara", "Dev"].map((n) => { const u = new URL(url); u.searchParams.set("as", n); return `<a href="${esc(u.pathname + u.search)}">${n}</a>`; }).join(" ");
      res.setHeader("content-type", "text/html");
      return res.end(`<!doctype html><meta charset="utf-8"><title>Fake sign-in</title><body style="font:16px system-ui;max-width:30rem;margin:4rem auto;padding:0 1rem"><h1>Fake sign-in (local preview only)</h1><p>This stands in for Google, GitHub or Discord. Whatever you type becomes your sign-in ID, so the same text always gives you the same account.</p><form method="get" action="/authorize">${hidden}<input name="as" placeholder="e.g. alice" required autofocus style="font:inherit;padding:.5rem"> <button style="font:inherit;padding:.5rem 1rem">Sign in</button></form><p>Quick picks: ${quick}</p></body>`);
    }
    if (url.pathname === "/authorize") {
      const code = crypto.randomBytes(8).toString("hex");
      log.authorize.push(Object.fromEntries(url.searchParams));
      codes.set(code, { sub: url.searchParams.get("as") || "anon", challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
      const back = new URL(url.searchParams.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", url.searchParams.get("state"));
      res.statusCode = 302; res.setHeader("location", back.toString()); return res.end();
    }
    if (url.pathname === "/token") {
      const f = new URLSearchParams(body); const c = codes.get(f.get("code")); log.token.push(Object.fromEntries(f));
      res.setHeader("content-type", "application/json");
      const okPkce = c && b64url(crypto.createHash("sha256").update(f.get("code_verifier") || "").digest()) === c.challenge;
      if (!c || !okPkce || f.get("client_secret") !== "mock-secret") { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
      codes.delete(f.get("code")); return res.end(JSON.stringify({ access_token: "at-" + c.sub, token_type: "bearer" }));
    }
    if (url.pathname === "/userinfo") {
      log.userinfo++; res.setHeader("content-type", "application/json");
      const m = /^Bearer at-(.+)$/.exec(req.headers.authorization || "");
      if (!m) { res.statusCode = 401; return res.end("{}"); }
      return res.end(JSON.stringify({ sub: m[1] })); // note: no email, no name
    }
    res.statusCode = 404; res.end();
  });
}).listen(9998, () => console.log("mock oauth up"));
