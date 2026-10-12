import type { Env } from "./types";

/**
 * "Sign in with ..." (OAuth 2.0 authorisation code + PKCE). We ask each provider for the least it
 * will give: no email, no profile. All we keep is a one-way hash of the provider's user ID, so
 * there are no passwords or email addresses in the database to leak or protect.
 */
export interface Provider {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  /** Minimal scope: enough to learn a stable ID and nothing else. */
  scope: string;
  clientId: string;
  clientSecret: string;
  pickId(json: any): string | null;
}

export function providers(env: Env): Provider[] {
  if (!env.AUTH_SECRET) return [];
  const out: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.push({
      id: "google", label: "Google",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid", // returns only an opaque "sub", never an email address
      clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      pickId: (j) => (j?.sub ? String(j.sub) : null),
    });
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    out.push({
      id: "github", label: "GitHub",
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userUrl: "https://api.github.com/user",
      scope: "", // no scope = public profile only; we only read the numeric id
      clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
      pickId: (j) => (j?.id !== undefined ? String(j.id) : null),
    });
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    out.push({
      id: "discord", label: "Discord",
      authUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      userUrl: "https://discord.com/api/users/@me",
      scope: "identify",
      clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET,
      pickId: (j) => (j?.id ? String(j.id) : null),
    });
  }
  if (env.OAUTH_MOCK_BASE) {
    const base = env.OAUTH_MOCK_BASE.replace(/\/+$/, "");
    out.push({
      id: "mock", label: "Test provider",
      authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, userUrl: `${base}/userinfo`,
      scope: "openid", clientId: "mock-client", clientSecret: "mock-secret",
      pickId: (j) => (j?.sub ? String(j.sub) : null),
    });
  }
  return out;
}

// ---------------------------------------------------------------- small crypto helpers

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** One-way, keyed hash of "provider:userId". This is the only identifier we store. */
export async function accountId(env: Env, provider: string, sub: string): Promise<string> {
  const mac = await hmac(env.ID_PEPPER || env.AUTH_SECRET || "", `id|${provider}:${sub}`);
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(env: Env, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(env.AUTH_SECRET || "", `cookie|${body}`))}`;
}

async function verify<T>(env: Env, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = await hmac(env.AUTH_SECRET || "", `cookie|${body}`);
  const given = fromB64url(mac);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i] ^ expected[i];
  if (diff !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cookies

export function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookie(url: URL, name: string, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export const SESSION_COOKIE = "tf_session";
const OAUTH_COOKIE = "tf_oauth";

// ---------------------------------------------------------------- the flow

const redirect = (to: string, cookies: string[] = []): Response => {
  const h = new Headers({ Location: to, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};

export async function startSignIn(request: Request, env: Env, p: Provider): Promise<Response> {
  const url = new URL(request.url);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const signed = await sign(env, { s: state, v: verifier, p: p.id, t: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: `${url.origin}/api/auth/${p.id}/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (p.scope) params.set("scope", p.scope);
  if (p.id === "google") params.set("prompt", "select_account");
  return redirect(`${p.authUrl}?${params}`, [cookie(url, OAUTH_COOKIE, signed, 600)]);
}

/** Finishes the sign-in. Returns the account id hash, or a redirect to show an error. */
export async function finishSignIn(
  request: Request,
  env: Env,
  p: Provider,
): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const url = new URL(request.url);
  const back = (code: string) => ({
    ok: false as const,
    response: redirect(`/?autherror=${code}#/daily`, [cookie(url, OAUTH_COOKIE, "", 0)]),
  });

  if (url.searchParams.get("error")) return back("denied");
  const saved = await verify<{ s: string; v: string; p: string; t: number }>(env, parseCookies(request)[OAUTH_COOKIE]);
  if (!saved || saved.p !== p.id || saved.s !== url.searchParams.get("state") || Date.now() - saved.t > 10 * 60_000) return back("state");
  const code = url.searchParams.get("code");
  if (!code) return back("state");

  try {
    const tokenRes = await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "tenfold" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${url.origin}/api/auth/${p.id}/callback`,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code_verifier: saved.v,
      }),
    });
    const tokens: any = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) return back("token");

    const userRes = await fetch(p.userUrl, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json", "user-agent": "tenfold" } });
    const sub = p.pickId(await userRes.json());
    if (!userRes.ok || !sub) return back("user");
    return { ok: true, id: await accountId(env, p.id, sub) };
  } catch (err) {
    console.error("sign-in failed:", err);
    return back("network");
  }
}

export const finishRedirect = (url: URL, sessionToken: string): Response =>
  redirect("/#/daily", [cookie(url, SESSION_COOKIE, sessionToken, 30 * 24 * 60 * 60), cookie(url, OAUTH_COOKIE, "", 0)]);
