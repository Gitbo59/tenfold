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
