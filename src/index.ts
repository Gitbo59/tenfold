import { Arena } from "./arena";
import { SESSION_COOKIE, cookie, finishRedirect, finishSignIn, parseCookies, providers, startSignIn } from "./auth";
import { Quota } from "./quota";
import { Room } from "./room";
import type { Env } from "./types";
import { makeCode } from "./util";

export { Room, Quota, Arena };

const CODE_RE = /^[A-Z0-9]{5}$/;

const roomStub = (env: Env, code: string) => env.ROOM.get(env.ROOM.idFromName(code));
const quotaStub = (env: Env) => env.QUOTA.get(env.QUOTA.idFromName("global"));
/** A plain description of the Arena's methods. (The generated RPC types are too deep for the compiler here.) */
interface ArenaApi {
  signIn(idHash: string): Promise<{ ok: true; token: string; name: string | null } | { ok: false; status: number; error: string }>;
  me(token: string | null): Promise<{ signedIn: boolean; name: string | null; avatar: string | null }>;
  setAvatar(token: string | null, color: unknown, icon: unknown): Promise<any>;
  rankedHistory(token: string | null, limit?: number): Promise<any>;
  signOut(token: string | null): Promise<void>;
  setName(token: string | null, name: string): Promise<any>;
  deleteMe(token: string | null): Promise<{ ok: boolean; status?: number }>;
  state(token: string | null): Promise<any>;
  start(token: string | null, ip: string): Promise<any>;
  guess(token: string | null, text: string, sig: unknown): Promise<any>;
  leaderboard(token: string | null, scope: string): Promise<any>;
  yesterday(token: string | null): Promise<any>;
  adminDaily(date: string): Promise<any>;
  adminSetDaily(date: string, list: unknown, force: boolean): Promise<any>;
  adminVoidDay(date: string, voided: boolean): Promise<any>;
  adminAttempts(date: string): Promise<any>;
  adminGuesses(id: number): Promise<any>;
  adminReview(id: number, action: string): Promise<any>;
  adminBan(name: string, banned: boolean): Promise<any>;
  maintenance(): Promise<void>;
  identify(token: string | null): Promise<{ id: string; name: string | null } | null>;
  queueJoin(token: string | null): Promise<any>;
  queueStatus(token: string | null): Promise<any>;
  queueLeave(token: string | null): Promise<any>;
  rankedMe(token: string | null): Promise<any>;
  rankedLadder(token: string | null, limit?: number): Promise<any>;
  adminMatches(limit?: number): Promise<any>;
  adminVoidMatch(id: string): Promise<any>;
  adminSetRating(name: string, rating: number): Promise<any>;
  adminAddPool(list: unknown): Promise<any>;
  adminSeedPool(count: number): Promise<any>;
}
const arenaStub = (env: Env): ArenaApi => env.ARENA.get(env.ARENA.idFromName("arena")) as unknown as ArenaApi;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** A short one-way hash of the caller's IP, used only for rate limits. Raw IPs are never stored. */
async function ipHash(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tenfold|${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Anything that changes data must come from our own pages (blocks cross-site form posts). */
const sameOrigin = (request: Request, url: URL): boolean => request.headers.get("Origin") === url.origin;

async function readJson(request: Request): Promise<any> {
  const text = await request.text();
  if (text.length > 8000) return null;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

/** Arena methods return {ok:false,status,error} on failure; turn that into an HTTP response. */
const reply = (r: any): Response => (r && r.ok === false ? json({ error: r.error }, r.status) : json(r));

async function competitive(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const token = parseCookies(request)[SESSION_COOKIE] ?? null;
  const arena = arenaStub(env);

  // ---- sign in
  if (path === "/api/auth/providers") {
    return json({ providers: providers(env).map((p) => ({ id: p.id, label: p.label })) });
  }
  const auth = path.match(/^\/api\/auth\/([a-z]+)\/(start|callback)$/);
  if (auth && request.method === "GET") {
    const provider = providers(env).find((p) => p.id === auth[1]);
    if (!provider) return json({ error: "That sign-in option isn't available." }, 404);
    if (auth[2] === "start") return startSignIn(request, env, provider);
    const done = await finishSignIn(request, env, provider);
    if (!done.ok) return done.response;
    const res = await arena.signIn(done.id);
    if (!res.ok) return Response.redirect(`${url.origin}/?autherror=blocked#/daily`, 302);
    return finishRedirect(url, res.token, done.next);
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    await arena.signOut(token);
    const h = new Headers({ "content-type": "application/json" });
    h.append("Set-Cookie", cookie(url, SESSION_COOKIE, "", 0));
    return new Response('{"ok":true}', { headers: h });
  }

  // ---- account
  if (path === "/api/me" && request.method === "GET") return json(await arena.me(token));
  if (path === "/api/me/name" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    const body = await readJson(request);
    return body ? reply(await arena.setName(token, body.name)) : json({ error: "Bad request" }, 400);
  }
  if (path === "/api/me/avatar" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    const body = await readJson(request);
    return body ? reply(await arena.setAvatar(token, body.color, body.icon)) : json({ error: "Bad request" }, 400);
  }
  if (path === "/api/me/delete" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    const res = await arena.deleteMe(token);
    const h = new Headers({ "content-type": "application/json" });
    h.append("Set-Cookie", cookie(url, SESSION_COOKIE, "", 0));
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : (res.status ?? 400), headers: h });
  }

  // ---- daily challenge
  if (path === "/api/daily/state" && request.method === "GET") return reply(await arena.state(token));
  if (path === "/api/daily/leaderboard" && request.method === "GET") {
    return reply(await arena.leaderboard(token, url.searchParams.get("scope") ?? "today"));
  }
  if (path === "/api/daily/yesterday" && request.method === "GET") return reply(await arena.yesterday(token));
  if (path === "/api/daily/start" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    return reply(await arena.start(token, await ipHash(request)));
  }
  if (path === "/api/daily/guess" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    const body = await readJson(request);
    return body ? reply(await arena.guess(token, body.text, body.sig)) : json({ error: "Bad request" }, 400);
  }
  if (path === "/api/daily/report" && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    const me = await arena.me(token);
    if (!me.signedIn) return json({ error: "Sign in first." }, 401);
    const date = new Date().toISOString().slice(0, 10);
    const res = await quotaStub(env).report({ listKey: `daily:${date}`, topic: "daily challenge", difficulty: null, kind: "wrong", rank: 0, answer: `reported by ${me.name ?? "player"}`, ip: await ipHash(request) });
    return json({ ok: res.ok });
  }

  // ---- ranked 1v1
  if (path === "/api/ranked/ladder" && request.method === "GET") return reply(await arena.rankedLadder(token, 50));
  if (path === "/api/ranked/history" && request.method === "GET") return reply(await arena.rankedHistory(token, 12));
  if (path === "/api/ranked/me" && request.method === "GET") return reply(await arena.rankedMe(token));
  if (path === "/api/ranked/status" && request.method === "GET") return reply(await arena.queueStatus(token));
  if ((path === "/api/ranked/queue" || path === "/api/ranked/leave") && request.method === "POST") {
    if (!sameOrigin(request, url)) return json({ error: "Bad origin" }, 403);
    return reply(path.endsWith("queue") ? await arena.queueJoin(token) : await arena.queueLeave(token));
  }

  // ---- owner only
  if (path.startsWith("/api/admin/")) {
    const auth = request.headers.get("Authorization");
    if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && !sameOrigin(request, url) && request.headers.get("Origin")) return json({ error: "Bad origin" }, 403);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    if (path === "/api/admin/daily" && request.method === "GET") return reply(await arena.adminDaily(date));
    if (path === "/api/admin/attempts" && request.method === "GET") return json(await arena.adminAttempts(date));
    if (path === "/api/admin/matches" && request.method === "GET") return json(await arena.adminMatches(Number(url.searchParams.get("limit")) || 50));
    if (path === "/api/admin/guesses" && request.method === "GET") return json(await arena.adminGuesses(Number(url.searchParams.get("attempt"))));
    if (request.method === "POST") {
      const body = await readJson(request);
      if (!body) return json({ error: "Bad request" }, 400);
      if (path === "/api/admin/daily") return reply(await arena.adminSetDaily(String(body.date), body.list, body.force === true));
      if (path === "/api/admin/daily/void") return reply(await arena.adminVoidDay(String(body.date), body.void !== false));
      if (path === "/api/admin/attempt") return reply(await arena.adminReview(Number(body.id), String(body.action)));
      if (path === "/api/admin/match/void") return reply(await arena.adminVoidMatch(String(body.id)));
      if (path === "/api/admin/rating") return reply(await arena.adminSetRating(String(body.name), Number(body.rating)));
      if (path === "/api/admin/pool") return reply(await arena.adminAddPool(body.list));
      if (path === "/api/admin/pool/seed") return reply(await arena.adminSeedPool(Number(body.count) || 1));
      if (path === "/api/admin/ban") return reply(await arena.adminBan(String(body.name), body.banned !== false));
    }
  }
  return null;
}

export default {
  /** Runs once a day (see "triggers" in wrangler.jsonc): builds the next few daily lists ahead of time. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(arenaStub(env).maintenance());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const handled = await competitive(request, env, url);
    if (handled) return handled;

    // Create a room (limited per connection so nobody can mass-produce Durable Objects).
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (!(await quotaStub(env).allowRoomCreate(await ipHash(request)))) {
        return json({ error: "You've created a lot of rooms recently. Try again in a little while." }, 429);
      }
      for (let i = 0; i < 5; i++) {
        const code = makeCode();
        const res = await roomStub(env, code).fetch("https://room/init");
        if (res.status === 200) return json({ code });
      }
      return json({ error: "Couldn't create a room. Try again." }, 503);
    }

    // Does a room exist? (used before joining so we can show a proper error)
    const status = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{5})$/);
    if (status && request.method === "GET") {
      const res = await roomStub(env, status[1].toUpperCase()).fetch("https://room/status");
      return json({ exists: res.status === 200 }, res.status === 200 ? 200 : 404);
    }

    // How many free AI lists are left today?
    if (url.pathname === "/api/budget" && request.method === "GET") {
      return json(await quotaStub(env).budget());
    }

    // Owner-only: usage and the report log. Disabled unless ADMIN_TOKEN is set.
    if (url.pathname.startsWith("/api/admin/")) {
      const auth = request.headers.get("Authorization");
      if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return new Response("Not found", { status: 404 });
      if (url.pathname === "/api/admin/stats") return json(await quotaStub(env).stats());
      if (url.pathname === "/api/admin/reports") return json(await quotaStub(env).listReports(100));
    }

    // Live game connection.
    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9]{5})$/);
    if (ws) {
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const code = ws[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      const headers = new Headers(request.headers);
      headers.set("x-ip-hash", await ipHash(request));
      // The signed-in account (from the login cookie, never from anything the browser claims) so ranked rooms know who is who.
      headers.delete("x-account-id");
      headers.delete("x-account-name");
      const who = await arenaStub(env).identify(parseCookies(request)[SESSION_COOKIE] ?? null);
      if (who?.name) {
        headers.set("x-account-id", who.id);
        headers.set("x-account-name", who.name);
      }
      return roomStub(env, code).fetch(new Request(request, { headers }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
