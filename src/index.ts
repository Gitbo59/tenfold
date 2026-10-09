import { Room } from "./room";
import type { Env } from "./types";

export { Room };

// No 0/O/1/I so codes are easy to read out loud.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{5}$/;

function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

const roomStub = (env: Env, code: string) => env.ROOM.get(env.ROOM.idFromName(code));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Create a room.
    if (url.pathname === "/api/rooms" && request.method === "POST") {
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

    // Live game connection.
    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9]{5})$/);
    if (ws) {
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const code = ws[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      return roomStub(env, code).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
