import { Quota } from "./quota";
import { Room } from "./room";
import type { Env } from "./types";

export { Room, Quota };

// No 0/O/1/I so codes are easy to read out loud.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{5}$/;

function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

const roomStub = (env: Env, code: string) => env.ROOM.get(env.ROOM.idFromName(code));
const quotaStub = (env: Env) => env.QUOTA.get(env.QUOTA.idFromName("global"));

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
      return roomStub(env, code).fetch(new Request(request, { headers }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
