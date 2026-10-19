import { DurableObject } from "cloudflare:workers";
import { AiError, generateTopTen, type Difficulty, type TopTen } from "./ai";
import { REVIEW_THRESHOLD, assessAttempt, assessGuess, cleanSignals } from "./anticheat";
import { DAILY_TOPICS, dailyTopic } from "./daily-topics";
import { CLASSICS, getClassic } from "./classics";
import { START_RATING, PROVISIONAL_GAMES, ratingChange } from "./elo";
import { matchGuess, normalize, type Answer } from "./match";
import type { Env } from "./types";
import { makeCode, num } from "./util";

const LIVES = 3;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,14}[A-Za-z0-9]$/;
const RESERVED = ["admin", "administrator", "tenfold", "moderator", "staff", "support", "system", "official"];

export type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

interface FoundEntry {
  rank: number;
  points: number;
  ms: number;
}

interface AttemptRow {
  id: number;
  date: string;
  account_id: string;
  started: number;
  last_at: number;
  lives: number;
  score: number;
  total_ms: number;
  found: FoundEntry[];
  wrong: number;
  wrong_keys: string[];
  state: "playing" | "done";
  risk: number;
  flags: string[];
  review: "none" | "held" | "cleared" | "void";
  ip: string;
}

interface AccountRow {
  id: string;
  name: string | null;
  banned: number;
  avatar: string | null;
}

const AVATAR_RE = /^\d{1,2}:\d{1,2}$/;

const sha256hex = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
};

const randomToken = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Accounts, sessions, the daily challenge and its leaderboards. Accounts hold no email and no
 * password: only a one-way hash of the sign-in provider's ID, a display name and play results.
 */
interface QueueEntry {
  id: string;
  name: string;
  rating: number;
  since: number;
  lastPoll: number;
}

export class Arena extends DurableObject<Env> {
  private queue = new Map<string, QueueEntry>();
  private pairing = false;
  private generating = new Map<string, Promise<TopTen>>();
  private rate = new Map<string, { t: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE, banned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_seen INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS daily_lists (date TEXT PRIMARY KEY, topic TEXT NOT NULL, difficulty TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', created INTEGER NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, account_id TEXT NOT NULL, started INTEGER NOT NULL, last_at INTEGER NOT NULL, lives INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0, total_ms INTEGER NOT NULL DEFAULT 0, found TEXT NOT NULL DEFAULT '[]', wrong INTEGER NOT NULL DEFAULT 0, wrong_keys TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'playing', risk INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '[]', review TEXT NOT NULL DEFAULT 'none', ip TEXT NOT NULL DEFAULT '', UNIQUE (date, account_id))",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS guesses (attempt_id INTEGER NOT NULL, n INTEGER NOT NULL, ts INTEGER NOT NULL, ms INTEGER NOT NULL, kind TEXT NOT NULL, rank INTEGER, text TEXT, sig TEXT, flags TEXT)");
    // Lets us enforce "one attempt a day" even if someone deletes their account mid-day. Cleared at midnight UTC.
    sql.exec("CREATE TABLE IF NOT EXISTS tombstones (date TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY (date, account_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS ratings (account_id TEXT PRIMARY KEY, rating INTEGER NOT NULL, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL, recent TEXT NOT NULL DEFAULT '[]', updated INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, code TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, list_key TEXT NOT NULL, status TEXT NOT NULL, a_before INTEGER, b_before INTEGER, a_delta INTEGER, b_delta INTEGER, outcome TEXT, reason TEXT, a_risk INTEGER NOT NULL DEFAULT 0, b_risk INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '{}')");
    sql.exec("CREATE TABLE IF NOT EXISTS ranked_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS identities (id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, linked INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS identities_account ON identities (account_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS friendships (lo TEXT NOT NULL, hi TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (lo, hi))");
    sql.exec("CREATE INDEX IF NOT EXISTS friendships_hi ON friendships (hi)");
    // Added later; harmless if the column already exists.
    try { sql.exec("ALTER TABLE accounts ADD COLUMN name_changed INTEGER"); } catch { /* already there */ }
    try { sql.exec("ALTER TABLE accounts ADD COLUMN allow_requests INTEGER NOT NULL DEFAULT 1"); } catch { /* already there */ }
    try { sql.exec("ALTER TABLE accounts ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1"); } catch { /* already there */ }
    try { sql.exec("ALTER TABLE accounts ADD COLUMN avatar TEXT"); } catch { /* already there */ }
    try { sql.exec("ALTER TABLE matches ADD COLUMN title TEXT"); } catch { /* already there */ }
    sql.exec("CREATE INDEX IF NOT EXISTS matches_status ON matches (status, ts)");
    sql.exec("CREATE INDEX IF NOT EXISTS attempts_date ON attempts (date, state)");
    sql.exec("CREATE INDEX IF NOT EXISTS guesses_attempt ON guesses (attempt_id)");
  }

  // ---------------------------------------------------------------- helpers

  private q(query: string, ...b: (string | number | null)[]) {
    return this.ctx.storage.sql.exec(query, ...b).toArray();
  }

  private turnMs(): number {
    return Math.max(2, num(this.env.DAILY_TURN_SECONDS, 30)) * 1000;
  }

  private today(): string {
    return isoDay(Date.now());
  }

  private msUntilReset(): number {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime();
  }

  private attemptFrom(r: any): AttemptRow {
    return {
      id: Number(r.id),
      date: String(r.date),
      account_id: String(r.account_id),
      started: Number(r.started),
      last_at: Number(r.last_at),
      lives: Number(r.lives),
      score: Number(r.score),
      total_ms: Number(r.total_ms),
      found: JSON.parse(String(r.found)),
      wrong: Number(r.wrong),
      wrong_keys: JSON.parse(String(r.wrong_keys)),
      state: r.state === "done" ? "done" : "playing",
      risk: Number(r.risk),
      flags: JSON.parse(String(r.flags)),
      review: r.review as AttemptRow["review"],
      ip: String(r.ip ?? ""),
    };
  }

  private saveAttempt(a: AttemptRow): void {
    this.q(
      "UPDATE attempts SET last_at=?, lives=?, score=?, total_ms=?, found=?, wrong=?, wrong_keys=?, state=?, risk=?, flags=?, review=? WHERE id=?",
      a.last_at, a.lives, a.score, a.total_ms, JSON.stringify(a.found), a.wrong, JSON.stringify(a.wrong_keys.slice(-40)),
      a.state, a.risk, JSON.stringify(a.flags.slice(0, 12)), a.review, a.id,
    );
  }

  private async account(token: string | null): Promise<AccountRow | null> {
    if (!token) return null;
    const rows = this.q(
      "SELECT a.id, a.name, a.banned, a.avatar FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?",
      await sha256hex(token),
      Date.now(),
    );
    if (!rows.length) return null;
    const r = rows[0];
    return { id: String(r.id), name: r.name === null ? null : String(r.name), banned: Number(r.banned), avatar: r.avatar === null || r.avatar === undefined ? null : String(r.avatar) };
  }

  private limited(id: string): boolean {
    const now = Date.now();
    const r = this.rate.get(id);
    if (!r || now - r.t > 1000) {
      this.rate.set(id, { t: now, n: 1 });
      return false;
    }
    return ++r.n > 4;
  }

  // ---------------------------------------------------------------- accounts

  /**
   * Called after a provider has proved who someone is. `idHash` is already a one-way hash of "provider:id".
   * One account can have several sign-in methods (see `identities`); the account's own id is the hash of the
   * first method it was created with, and never changes.
   */
  async signIn(idHash: string, provider: string): Promise<{ ok: true; token: string; name: string | null } | Fail> {
    const now = Date.now();
    let accountId: string;
    const known = this.q("SELECT account_id FROM identities WHERE id_hash = ?", idHash);
    if (known.length) {
      accountId = String(known[0].account_id);
      // Accounts made before linking existed have a placeholder method; now we learn which provider it was.
      this.q("UPDATE identities SET provider = ? WHERE id_hash = ? AND provider = 'original'", provider, idHash);
    } else if (this.q("SELECT 1 FROM accounts WHERE id = ?", idHash).length) {
      accountId = idHash;
      this.q("INSERT OR IGNORE INTO identities (id_hash, account_id, provider, linked) VALUES (?, ?, ?, ?)", idHash, idHash, provider, now);
    } else {
      accountId = idHash;
      this.q("INSERT INTO accounts (id, name, banned, created, last_seen) VALUES (?, NULL, 0, ?, ?)", idHash, now, now);
      this.q("INSERT INTO identities (id_hash, account_id, provider, linked) VALUES (?, ?, ?, ?)", idHash, idHash, provider, now);
    }
    const found = this.q("SELECT name, banned FROM accounts WHERE id = ?", accountId);
    if (found.length && Number(found[0].banned)) return fail(403, "This account can't be used.");
    this.q("UPDATE accounts SET last_seen = ? WHERE id = ?", now, accountId);
    const token = randomToken();
    this.q("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)", await sha256hex(token), accountId, now + SESSION_MS);
    return { ok: true, token, name: found.length && found[0].name !== null ? String(found[0].name) : null };
  }

  /** Accounts that predate linking get a placeholder row so they show (and can unlink) correctly. */
  private ensureIdentity(accountId: string): void {
    if (!this.q("SELECT 1 FROM identities WHERE account_id = ?", accountId).length) {
      this.q("INSERT OR IGNORE INTO identities (id_hash, account_id, provider, linked) VALUES (?, ?, 'original', ?)", accountId, accountId, Date.now());
    }
  }

  async linkIdentity(token: string | null, idHash: string, provider: string): Promise<{ ok: true; already?: boolean } | Fail> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "auth");
    this.ensureIdentity(acc.id);
    const owner = this.q("SELECT account_id FROM identities WHERE id_hash = ?", idHash);
    if (owner.length) return String(owner[0].account_id) === acc.id ? { ok: true, already: true } : fail(409, "taken");
    // A pre-linking account that isn't in the identities table yet still owns its id.
    if (idHash !== acc.id && this.q("SELECT 1 FROM accounts WHERE id = ?", idHash).length) return fail(409, "taken");
    if (this.q("SELECT 1 FROM identities WHERE account_id = ? AND provider = ?", acc.id, provider).length) return fail(409, "provider");
    this.q("INSERT INTO identities (id_hash, account_id, provider, linked) VALUES (?, ?, ?, ?)", idHash, acc.id, provider, Date.now());
    return { ok: true };
  }

  async unlinkIdentity(token: string | null, provider: string): Promise<{ ok: true } | Fail> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    this.ensureIdentity(acc.id);
    const mine = this.q("SELECT id_hash, provider FROM identities WHERE account_id = ?", acc.id);
    const target = mine.find((r) => String(r.provider) === provider);
    if (!target) return fail(404, "That sign-in method isn't linked.");
    if (mine.length < 2) return fail(400, "You need at least one way to sign in, so you can't unlink your only one.");
    this.q("DELETE FROM identities WHERE id_hash = ?", String(target.id_hash));
    return { ok: true };
  }

  /** "colour:emblem" (each 0 to 11). Everyone gets a stable default until they pick one. No photos are ever stored. */
  private avatarOf(id: string, stored: unknown): string {
    if (typeof stored === "string" && AVATAR_RE.test(stored)) return stored;
    return `${parseInt(id.slice(0, 2), 16) % 12}:${parseInt(id.slice(2, 4), 16) % 12}`;
  }

  async me(token: string | null): Promise<{ signedIn: boolean; name: string | null; avatar: string | null }> {
    const a = await this.account(token);
    return a ? { signedIn: true, name: a.name, avatar: this.avatarOf(a.id, a.avatar) } : { signedIn: false, name: null, avatar: null };
  }

  async setAvatar(token: string | null, color: unknown, icon: unknown): Promise<{ ok: true; avatar: string } | Fail> {
    const a = await this.account(token);
    if (!a) return fail(401, "Sign in first.");
    const c = Number(color), i = Number(icon);
    if (!Number.isInteger(c) || !Number.isInteger(i) || c < 0 || c > 11 || i < 0 || i > 11) return fail(400, "Pick one of the colours and one of the pictures.");
    this.q("UPDATE accounts SET avatar = ? WHERE id = ?", `${c}:${i}`, a.id);
    return { ok: true, avatar: `${c}:${i}` };
  }

  async signOut(token: string | null): Promise<void> {
    if (token) this.q("DELETE FROM sessions WHERE token_hash = ?", await sha256hex(token));
  }

  async setName(token: string | null, raw: string): Promise<{ ok: true; name: string } | Fail> {
    const a = await this.account(token);
    if (!a) return fail(401, "Sign in first.");
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!NAME_RE.test(name)) return fail(400, "Usernames are 3 to 16 letters, numbers, spaces, hyphens or underscores.");
    if (RESERVED.includes(name.toLowerCase())) return fail(400, "That username is reserved.");
    if (a.name === name) return { ok: true, name };
    // The first username is free to set. After a change there's a cooldown so names can't be swapped to confuse people.
    const days = Math.max(0, num(this.env.NAME_CHANGE_DAYS, 7));
    const last = this.q("SELECT name_changed FROM accounts WHERE id = ?", a.id)[0].name_changed;
    if (a.name && last && days > 0 && Date.now() - Number(last) < days * 86_400_000) {
      return fail(429, `You can change your username again on ${isoDay(Number(last) + days * 86_400_000)}.`);
    }
    try {
      this.q("UPDATE accounts SET name = ? WHERE id = ?", name, a.id);
    } catch {
      return fail(409, "That username is taken. Try another.");
    }
    if (a.name) this.q("UPDATE accounts SET name_changed = ? WHERE id = ?", Date.now(), a.id);
    return { ok: true, name };
  }

  /** Erases the account and everything tied to it. */
  async deleteMe(token: string | null): Promise<{ ok: true } | Fail> {
    const a = await this.account(token);
    if (!a) return fail(401, "Sign in first.");
    this.q("INSERT OR IGNORE INTO tombstones (date, account_id) SELECT date, account_id FROM attempts WHERE account_id = ? AND date = ?", a.id, this.today());
    this.q("DELETE FROM guesses WHERE attempt_id IN (SELECT id FROM attempts WHERE account_id = ?)", a.id);
    this.q("DELETE FROM attempts WHERE account_id = ?", a.id);
    this.q("DELETE FROM sessions WHERE account_id = ?", a.id);
    this.queue.delete(a.id);
    this.q("DELETE FROM ratings WHERE account_id = ?", a.id);
    this.q("DELETE FROM identities WHERE account_id = ?", a.id);
    this.q("DELETE FROM friendships WHERE lo = ? OR hi = ?", a.id, a.id);
    this.q("DELETE FROM matches WHERE a = ? OR b = ?", a.id, a.id);
    this.q("DELETE FROM accounts WHERE id = ?", a.id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- the daily list

  private listRow(date: string): { topic: string; difficulty: string; list: TopTen; status: string } | null {
    const r = this.q("SELECT topic, difficulty, payload, status FROM daily_lists WHERE date = ?", date);
    if (!r.length) return null;
    return { topic: String(r[0].topic), difficulty: String(r[0].difficulty), list: JSON.parse(String(r[0].payload)), status: String(r[0].status) };
  }

  /** Scheduled work (daily lists, the ranked pool) draws on its own small reserve of AI requests. */
  private systemHooks() {
    const quota = this.env.QUOTA.get(this.env.QUOTA.idFromName("global"));
    return {
      reserve: async () => {
        const r = await quota.reserveSystem();
        if (!r.ok) throw new AiError("Scheduled lists couldn't be built today.", "system cap", { budget: true });
      },
      refund: () => quota.refundSystem(),
    };
  }

  private async generate(date: string): Promise<TopTen> {
    const topic = dailyTopic(date);
    const difficulty: Difficulty = this.env.DAILY_DIFFICULTY === "hard" ? "hard" : "easy";
    const list = await generateTopTen(this.env, topic, difficulty, this.systemHooks());
    this.q("INSERT OR IGNORE INTO daily_lists (date, topic, difficulty, payload, status, created) VALUES (?, ?, ?, ?, 'ok', ?)", date, topic, difficulty, JSON.stringify(list), Date.now());
    return list;
  }

  /** Makes sure a list exists for `date`, building it once even if many players ask at the same time. */
  private async ensureList(date: string): Promise<boolean> {
    if (this.listRow(date)) return true;
    let p = this.generating.get(date);
    if (!p) {
      p = this.generate(date).finally(() => this.generating.delete(date));
      this.generating.set(date, p);
    }
    try {
      await p;
      return true;
    } catch (err) {
      console.error("daily list failed:", err instanceof AiError ? err.message : err);
      return false;
    }
  }

  /** Scheduled job: keep the next few days ready so there's time to review them. */
  async maintenance(): Promise<void> {
    const start = Date.now();
    for (let i = 0; i < 3; i++) await this.ensureList(isoDay(start + i * 86_400_000));
    this.q("DELETE FROM sessions WHERE expires < ?", start);
    this.q("DELETE FROM tombstones WHERE date < ?", isoDay(start));
    this.expireActive();
    await this.topUpPool(2);
    this.q("DELETE FROM guesses WHERE ts < ?", start - 60 * 86_400_000);
  }

  // ---------------------------------------------------------------- attempts

  private finish(a: AttemptRow): void {
    if (a.state === "done") return;
    a.state = "done";
    const end = assessAttempt(a.found, a.wrong);
    a.risk += end.weight;
    for (const f of end.flags) if (!a.flags.includes(f)) a.flags.push(f);
    if (a.risk >= REVIEW_THRESHOLD && a.review === "none") a.review = "held";
    this.saveAttempt(a);
  }

  /** Applies any timeouts that have passed, so closing the tab never pauses the clock. */
  private settle(a: AttemptRow, now: number): void {
    if (a.state !== "playing") return;
    const turn = this.turnMs();
    while (a.state === "playing" && now - a.last_at >= turn) {
      a.lives -= 1;
      a.total_ms += turn;
      a.last_at += turn;
      if (a.lives <= 0) {
        a.lives = 0;
        this.finish(a);
      }
    }
    if (a.state === "playing") this.saveAttempt(a);
  }

  private closeStale(): void {
    const today = this.today();
    for (const r of this.q("SELECT * FROM attempts WHERE state = 'playing' AND date < ?", today)) {
      const a = this.attemptFrom(r);
      a.lives = 0;
      this.finish(a);
    }
  }

  private myAttempt(accountId: string, date: string): AttemptRow | null {
    const r = this.q("SELECT * FROM attempts WHERE account_id = ? AND date = ?", accountId, date);
    return r.length ? this.attemptFrom(r[0]) : null;
  }

  private rankOf(a: AttemptRow): number {
    const r = this.q(
      "SELECT COUNT(*) AS n FROM attempts WHERE date = ? AND state = 'done' AND review IN ('none','cleared') AND (score > ? OR (score = ? AND total_ms < ?) OR (score = ? AND total_ms = ? AND id < ?))",
      a.date, a.score, a.score, a.total_ms, a.score, a.total_ms, a.id,
    );
    return Number(r[0].n) + 1;
  }

  private publicState(a: AttemptRow | null, date: string, now: number) {
    const base = { ok: true as const, date, now, turnMs: this.turnMs(), lives: LIVES, msUntilReset: this.msUntilReset() };
    const row = this.listRow(date);
    if (!a) return { ...base, status: "none" as const, ready: !!row };
    const answers = row ? row.list.answers : [];
    const done = a.state === "done";
    return {
      ...base,
      status: a.state,
      ready: true,
      topic: row?.list.title ?? "",
      basis: row?.list.basis ?? "",
      source: done ? row?.list.source ?? "" : "",
      livesLeft: a.lives,
      score: a.score,
      wrong: a.wrong,
      remainingMs: done ? 0 : Math.max(0, this.turnMs() - (now - a.last_at)),
      found: a.found.map((f) => ({ rank: f.rank, answer: answers[f.rank - 1]?.answer ?? "", detail: answers[f.rank - 1]?.detail ?? "", points: f.points, ms: f.ms })),
      totalMs: a.total_ms,
      place: done ? this.rankOf(a) : null,
    };
  }

  async state(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    this.closeStale();
    const date = this.today();
    const a = this.myAttempt(acc.id, date);
    if (a) this.settle(a, Date.now());
    return this.publicState(a, date, Date.now());
  }

  async start(token: string | null, ip: string): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    if (!acc.name) return fail(400, "Choose a username first.");
    if (acc.banned) return fail(403, "This account can't play.");
    this.closeStale();
    const date = this.today();
    let a = this.myAttempt(acc.id, date);
    if (!a) {
      if (this.q("SELECT 1 FROM tombstones WHERE date = ? AND account_id = ?", date, acc.id).length) {
        return fail(409, "You've already played today's challenge. A new one starts at 00:00 UTC.");
      }
      if (!(await this.ensureList(date))) return fail(503, "Today's list isn't ready yet. Please try again in a few minutes.");
      if (this.listRow(date)?.status === "void") return fail(409, "Today's challenge has been cancelled. A new one starts at 00:00 UTC.");
      const now = Date.now();
      this.q("INSERT INTO attempts (date, account_id, started, last_at, lives, ip) VALUES (?, ?, ?, ?, ?, ?)", date, acc.id, now, now, LIVES, ip);
      a = this.myAttempt(acc.id, date)!;
    } else {
      this.settle(a, Date.now());
    }
    return this.publicState(a, date, Date.now());
  }

  async guess(token: string | null, textRaw: string, sigRaw: unknown): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    if (this.limited(acc.id)) return fail(429, "Slow down.");
    const text = String(textRaw ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) return fail(400, "Type an answer.");

    const date = this.today();
    const a = this.myAttempt(acc.id, date);
    const row = this.listRow(date);
    if (!a || !row) return fail(409, "Start today's challenge first.");

    const now = Date.now();
    this.settle(a, now);
    if (a.state === "done") return { ...this.publicState(a, date, now), result: { kind: "over" } };

    const turn = this.turnMs();
    const elapsed = Math.min(turn, Math.max(0, now - a.last_at));
    const answers: Answer[] = row.list.answers.map((x, i) => {
      const f = a.found.find((e) => e.rank === i + 1);
      return { answer: x.answer, aliases: x.aliases, ...(f ? { found: { by: acc.id, points: f.points, speed: 0, streak: 0 } } : {}) };
    });
    const m = matchGuess(text, answers);
    const key = normalize(text);
    const sig = cleanSignals(sigRaw, text.length);
    let result: Record<string, unknown>;
    let kind: string;
    let rank: number | null = null;

    if (m.kind === "dupe") {
      return { ...this.publicState(a, date, now), result: { kind: "dupe", answer: answers[m.index].answer } };
    }

    if (m.kind === "hit") {
      rank = m.index + 1;
      const frac = Math.max(0, 1 - elapsed / turn);
      const points = Math.round((11 - rank) * (1 + frac) * 10);
      a.found.push({ rank, points, ms: elapsed });
      a.score += points;
      a.total_ms += elapsed;
      a.last_at = now;
      kind = "hit";
      result = { kind, rank, points, answer: answers[m.index].answer };
      const asm = assessGuess(sig, { correct: true, rank, elapsedMs: elapsed });
      a.risk += asm.weight;
      for (const f of asm.flags) if (!a.flags.includes(f)) a.flags.push(f);
      this.logGuess(a, kind, rank, text, elapsed, sig, asm.flags, now);
      if (a.found.length === 10) this.finish(a);
    } else {
      if (a.wrong_keys.includes(key)) {
        return { ...this.publicState(a, date, now), result: { kind: "repeat" } };
      }
      a.wrong_keys.push(key);
      a.wrong += 1;
      a.lives -= 1;
      a.total_ms += elapsed;
      a.last_at = now;
      kind = "miss";
      result = { kind, livesLeft: Math.max(0, a.lives) };
      const asm = assessGuess(sig, { correct: false, rank: 0, elapsedMs: elapsed });
      a.risk += asm.weight;
      for (const f of asm.flags) if (!a.flags.includes(f)) a.flags.push(f);
      this.logGuess(a, kind, null, text, elapsed, sig, asm.flags, now);
      if (a.lives <= 0) {
        a.lives = 0;
        this.finish(a);
      }
    }
    if (a.state === "playing") this.saveAttempt(a);
    return { ...this.publicState(a, date, now), result };
  }

  private logGuess(a: AttemptRow, kind: string, rank: number | null, text: string, ms: number, sig: unknown, flags: string[], ts: number): void {
    const n = Number(this.q("SELECT COUNT(*) AS n FROM guesses WHERE attempt_id = ?", a.id)[0].n);
    if (n >= 60) return;
    this.q("INSERT INTO guesses (attempt_id, n, ts, ms, kind, rank, text, sig, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", a.id, n + 1, ts, ms, kind, rank, text, JSON.stringify(sig), JSON.stringify(flags));
  }

  // ---------------------------------------------------------------- leaderboards

  private board(date: string | null, month: string | null, viewer: string | null, limit: number) {
    const visible = "(a.review IN ('none','cleared') OR a.account_id = ?)";
    let rows: any[];
    if (month) {
      rows = this.q(
        `SELECT acc.id AS id, acc.name AS name, acc.avatar AS avatar, SUM(a.score) AS score, COUNT(*) AS days, SUM(a.total_ms) AS ms FROM attempts a JOIN accounts acc ON acc.id = a.account_id JOIN daily_lists d ON d.date = a.date AND d.status = 'ok' WHERE substr(a.date, 1, 7) = ? AND a.state = 'done' AND ${visible} AND acc.banned = 0 GROUP BY acc.id ORDER BY score DESC, ms ASC LIMIT 300`,
        month, viewer ?? "",
      );
    } else {
      rows = this.q(
        `SELECT acc.id AS id, acc.name AS name, acc.avatar AS avatar, a.score AS score, a.found AS found, a.total_ms AS ms FROM attempts a JOIN accounts acc ON acc.id = a.account_id WHERE a.date = ? AND a.state = 'done' AND ${visible} AND acc.banned = 0 AND a.review != 'void' ORDER BY a.score DESC, a.total_ms ASC, a.id ASC LIMIT 300`,
        date, viewer ?? "",
      );
    }
    const mapped = rows.map((r, i) => ({
      rank: i + 1,
      name: String(r.name),
      avatar: this.avatarOf(String(r.id), r.avatar),
      score: Number(r.score),
      ms: Number(r.ms),
      ...(month ? { days: Number(r.days) } : { found: JSON.parse(String(r.found)).length }),
      me: viewer !== null && String(r.id) === viewer,
    }));
    const me = mapped.find((r) => r.me) ?? null;
    return { rows: mapped.slice(0, limit), me: me && me.rank > limit ? me : null };
  }

  async leaderboard(token: string | null, scope: string): Promise<any> {
    const acc = await this.account(token);
    const viewer = acc ? acc.id : null;
    const date = this.today();
    if (scope === "month") return { ok: true, scope, label: date.slice(0, 7), ...this.board(null, date.slice(0, 7), viewer, 50) };
    return { ok: true, scope: "today", label: date, ...this.board(date, null, viewer, 50) };
  }

  /** Yesterday's full list and results. Answers stay secret until the day they belong to has ended. */
  async yesterday(token: string | null): Promise<any> {
    const acc = await this.account(token);
    const date = isoDay(Date.now() - 86_400_000);
    const row = this.listRow(date);
    if (!row) return { ok: true, date, available: false };
    return {
      ok: true,
      date,
      available: true,
      status: row.status,
      title: row.list.title,
      basis: row.list.basis,
      source: row.list.source,
      answers: row.list.answers.map((x, i) => ({ rank: i + 1, answer: x.answer, detail: x.detail ?? "" })),
      ...this.board(date, null, acc ? acc.id : null, 10),
    };
  }


  // ---------------------------------------------------------------- ranked 1v1: ratings, queue, matches

  async identify(token: string | null): Promise<{ id: string; name: string | null } | null> {
    const a = await this.account(token);
    return a ? { id: a.id, name: a.name } : null;
  }

  private ratingRow(id: string) {
    this.q("INSERT OR IGNORE INTO ratings (account_id, rating, games, wins, losses, draws, peak, recent, updated) VALUES (?, ?, 0, 0, 0, 0, ?, '[]', ?)", id, START_RATING, START_RATING, Date.now());
    const r = this.q("SELECT * FROM ratings WHERE account_id = ?", id)[0];
    return { rating: Number(r.rating), games: Number(r.games), wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws), peak: Number(r.peak), recent: JSON.parse(String(r.recent)) as string[] };
  }

  private expireActive(): void {
    this.q("UPDATE matches SET status = 'aborted', reason = 'expired' WHERE status = 'active' AND ts < ?", Date.now() - 3 * 60 * 60 * 1000);
  }

  private activeMatch(id: string) {
    this.expireActive();
    const r = this.q("SELECT m.id, m.code, m.a, m.b, a.name AS an, b.name AS bn FROM matches m JOIN accounts a ON a.id = m.a JOIN accounts b ON b.id = m.b WHERE m.status = 'active' AND (m.a = ? OR m.b = ?) ORDER BY m.ts DESC LIMIT 1", id, id);
    if (!r.length) return null;
    const m = r[0];
    const mineIsA = String(m.a) === id;
    const oppId = mineIsA ? String(m.b) : String(m.a);
    return { matchId: String(m.id), code: String(m.code), opponent: { name: String(mineIsA ? m.bn : m.an), rating: this.ratingRow(oppId).rating } };
  }

  private window(e: QueueEntry, now: number): number {
    return Math.min(1500, 100 + Math.max(0, num(this.env.RANKED_WIDEN_PER_SEC, 15)) * ((now - e.since) / 1000));
  }

  private statusFor(id: string) {
    const m = this.activeMatch(id);
    if (m) return { status: "matched" as const, ...m };
    const e = this.queue.get(id);
    if (e) return { status: "waiting" as const, waitedMs: Date.now() - e.since, window: Math.round(this.window(e, Date.now())) };
    return { status: "idle" as const };
  }

  async queueJoin(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    if (!acc.name) return fail(400, "Choose a username first.");
    if (acc.banned) return fail(403, "This account can't play.");
    if (!this.activeMatch(acc.id)) {
      const r = this.ratingRow(acc.id);
      const now = Date.now();
      this.queue.set(acc.id, { id: acc.id, name: acc.name, rating: r.rating, since: now, lastPoll: now });
      await this.tryPair();
    }
    return { ok: true, ...this.statusFor(acc.id), rating: this.ratingRow(acc.id).rating };
  }

  async queueStatus(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    const e = this.queue.get(acc.id);
    if (e) e.lastPoll = Date.now();
    await this.tryPair();
    return { ok: true, ...this.statusFor(acc.id) };
  }

  async queueLeave(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    this.queue.delete(acc.id);
    return { ok: true, ...this.statusFor(acc.id) };
  }

  private playedRecently(a: string, b: string): boolean {
    const n = Number(this.q("SELECT COUNT(*) AS n FROM matches WHERE status = 'done' AND ts > ? AND ((a = ? AND b = ?) OR (a = ? AND b = ?))", Date.now() - 24 * 3600_000, a, b, b, a)[0].n);
    return n >= 2; // stops two accounts trading wins to pump a rating
  }

  private async tryPair(): Promise<void> {
    if (this.pairing) return;
    this.pairing = true;
    try {
      const now = Date.now();
      for (const e of [...this.queue.values()]) if (now - e.lastPoll > 15_000 || now - e.since > 5 * 60_000) this.queue.delete(e.id);
      const waiting = [...this.queue.values()].sort((x, y) => x.since - y.since);
      const used = new Set<string>();
      for (const a of waiting) {
        if (used.has(a.id)) continue;
        let best: QueueEntry | null = null;
        for (const b of waiting) {
          if (b.id === a.id || used.has(b.id)) continue;
          const gap = Math.abs(a.rating - b.rating);
          if (gap > Math.max(this.window(a, now), this.window(b, now))) continue;
          if (this.playedRecently(a.id, b.id)) continue;
          if (!best || gap < Math.abs(a.rating - best.rating)) best = b;
        }
        if (!best) continue;
        used.add(a.id); used.add(best.id);
        this.queue.delete(a.id); this.queue.delete(best.id);
        await this.makeMatch(a, best);
      }
    } finally {
      this.pairing = false;
    }
  }

  private loadKey(key: string): TopTen | null {
    if (key.startsWith("classic:")) {
      const c = getClassic(key.slice(8));
      return c ? { title: c.title, basis: c.basis, source: c.source, answers: c.answers } : null;
    }
    if (key.startsWith("daily:")) return this.listRow(key.slice(6))?.list ?? null;
    if (key.startsWith("pool:")) {
      const r = this.q("SELECT payload FROM ranked_pool WHERE id = ?", Number(key.slice(5)));
      return r.length ? (JSON.parse(String(r[0].payload)) as TopTen) : null;
    }
    return null;
  }

  /** Lists for ranked come from the built-ins, past daily lists and a pool the scheduled job tops up. Never today's or later. */
  private pickList(ids: string[]): { key: string; list: TopTen } {
    const recent = new Set<string>();
    for (const id of ids) for (const k of this.ratingRow(id).recent) recent.add(k);
    const keys = [
      ...CLASSICS.map((c) => `classic:${c.id}`),
      ...this.q("SELECT date FROM daily_lists WHERE date < ? AND status = 'ok'", this.today()).map((r) => `daily:${r.date}`),
      ...this.q("SELECT id FROM ranked_pool").map((r) => `pool:${r.id}`),
    ];
    const fresh = keys.filter((k) => !recent.has(k));
    const choices = fresh.length ? fresh : keys;
    for (let i = 0; i < 5; i++) {
      const key = choices[Math.floor(Math.random() * choices.length)];
      const list = this.loadKey(key);
      if (list) return { key, list };
    }
    const c = CLASSICS[0];
    return { key: `classic:${c.id}`, list: { title: c.title, basis: c.basis, source: c.source, answers: c.answers } };
  }

  private async makeMatch(x: QueueEntry, y: QueueEntry): Promise<void> {
    const [a, b] = Math.random() < 0.5 ? [x, y] : [y, x];
    const { key, list } = this.pickList([a.id, b.id]);
    let room: DurableObjectStub | null = null;
    let code = "";
    for (let i = 0; i < 6 && !room; i++) {
      code = makeCode();
      const stub = this.env.ROOM.get(this.env.ROOM.idFromName(code));
      const res = await stub.fetch("https://room/init");
      if (res.status === 200) room = stub;
    }
    if (!room) return;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => n.toString(16).padStart(2, "0")).join("");
    this.q("INSERT INTO matches (id, ts, code, a, b, list_key, status, a_before, b_before, title) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)", id, Date.now(), code, a.id, b.id, key, a.rating, b.rating, String(list.title).slice(0, 100));
    const res = await room.fetch("https://room/ranked-setup", {
      method: "POST",
      body: JSON.stringify({ matchId: id, listKey: key, list, players: [{ id: a.id, name: a.name, rating: a.rating }, { id: b.id, name: b.name, rating: b.rating }] }),
    });
    if (!res.ok) this.q("UPDATE matches SET status = 'aborted', reason = 'setup failed' WHERE id = ?", id);
  }

  /** Called by the match room when a ranked game ends. Safe to call twice: the first result wins. */
  async recordMatch(matchId: string, o: { winner: "a" | "b" | "draw" | "abort"; reason: string; aRisk?: number; bRisk?: number; flags?: unknown }): Promise<any> {
    const rows = this.q("SELECT * FROM matches WHERE id = ?", matchId);
    if (!rows.length) return fail(404, "unknown match");
    const m = rows[0];
    const done = (extra: object) => ({ ok: true, ...extra });
    if (String(m.status) !== "active") {
      return done({ already: true, outcome: m.outcome, aDelta: Number(m.a_delta ?? 0), bDelta: Number(m.b_delta ?? 0), aRating: Number(m.a_before ?? 0) + Number(m.a_delta ?? 0), bRating: Number(m.b_before ?? 0) + Number(m.b_delta ?? 0) });
    }
    if (o.winner === "abort") {
      this.q("UPDATE matches SET status = 'aborted', outcome = 'abort', reason = ? WHERE id = ?", String(o.reason).slice(0, 80), matchId);
      return done({ outcome: "abort", aDelta: 0, bDelta: 0 });
    }
    const a = String(m.a), b = String(m.b);
    const ra = this.ratingRow(a), rb = this.ratingRow(b);
    const scoreA = o.winner === "a" ? 1 : o.winner === "b" ? 0 : 0.5;
    const { aDelta, bDelta } = ratingChange({ rating: ra.rating, games: ra.games }, { rating: rb.rating, games: rb.games }, scoreA);
    const apply = (id: string, r: ReturnType<Arena["ratingRow"]>, delta: number, result: "w" | "l" | "d") => {
      const rating = r.rating + delta;
      const recent = [...r.recent, String(m.list_key)].slice(-10);
      this.q(
        "UPDATE ratings SET rating = ?, games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, peak = MAX(peak, ?), recent = ?, updated = ? WHERE account_id = ?",
        rating, result === "w" ? 1 : 0, result === "l" ? 1 : 0, result === "d" ? 1 : 0, rating, JSON.stringify(recent), Date.now(), id,
      );
    };
    apply(a, ra, aDelta, scoreA === 1 ? "w" : scoreA === 0 ? "l" : "d");
    apply(b, rb, bDelta, scoreA === 0 ? "w" : scoreA === 1 ? "l" : "d");
    this.q(
      "UPDATE matches SET status = 'done', a_before = ?, b_before = ?, a_delta = ?, b_delta = ?, outcome = ?, reason = ?, a_risk = ?, b_risk = ?, flags = ? WHERE id = ?",
      ra.rating, rb.rating, aDelta, bDelta, o.winner, String(o.reason).slice(0, 80), Math.round(o.aRisk ?? 0), Math.round(o.bRisk ?? 0), JSON.stringify(o.flags ?? {}).slice(0, 600), matchId,
    );
    return done({ outcome: o.winner, aDelta, bDelta, aRating: ra.rating + aDelta, bRating: rb.rating + bDelta });
  }

  private ladderRows(min: number, viewer: string | null) {
    return this.q(
      "SELECT acc.id AS id, acc.name AS name, acc.avatar AS avatar, r.rating AS rating, r.games AS games, r.wins AS wins, r.losses AS losses, r.draws AS draws FROM ratings r JOIN accounts acc ON acc.id = r.account_id WHERE r.games >= ? AND acc.banned = 0 AND acc.name IS NOT NULL ORDER BY r.rating DESC, r.games DESC, acc.name ASC LIMIT 200",
      min,
    ).map((r, i) => ({
      id: String(r.id), rank: i + 1, name: String(r.name), avatar: this.avatarOf(String(r.id), r.avatar), rating: Number(r.rating), games: Number(r.games),
      wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws), provisional: Number(r.games) < PROVISIONAL_GAMES, me: viewer !== null && String(r.id) === viewer,
    }));
  }

  private ladderMin(): number {
    return Math.max(1, Math.floor(num(this.env.RANKED_LADDER_MIN_GAMES, 3)));
  }

  async rankedMe(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    const r = this.ratingRow(acc.id);
    const mine = this.ladderRows(this.ladderMin(), acc.id).find((x) => x.me);
    return {
      ok: true, name: acc.name, avatar: this.avatarOf(acc.id, acc.avatar), rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, peak: r.peak,
      provisional: r.games < PROVISIONAL_GAMES, rank: mine ? mine.rank : null, ...this.statusFor(acc.id),
    };
  }

  async rankedLadder(token: string | null, limit = 50): Promise<any> {
    const me = await this.account(token);
    const min = this.ladderMin();
    const rows = this.ladderRows(min, me ? me.id : null).map(({ id: _id, ...r }) => r);
    const mine = rows.find((r) => r.me) ?? null;
    return { ok: true, rows: rows.slice(0, limit), me: mine && mine.rank > limit ? mine : null, minGames: min };
  }

  /** Recent finished ranked games for an account, a rating trend and the current streak. Cancelled and voided matches are left out. */
  private historyFor(id: string, limit: number) {
    const rows = this.q(
      "SELECT m.ts, m.outcome, m.reason, m.title, m.a, m.a_before, m.b_before, m.a_delta, m.b_delta, a.name AS an, a.avatar AS aav, a.id AS aid, b.name AS bn, b.avatar AS bav, b.id AS bid FROM matches m JOIN accounts a ON a.id = m.a JOIN accounts b ON b.id = m.b WHERE m.status = 'done' AND (m.a = ? OR m.b = ?) ORDER BY m.ts DESC LIMIT 30",
      id, id,
    ).map((m) => {
      const mineIsA = String(m.a) === id;
      const outcome = String(m.outcome);
      const result = outcome === "draw" ? "draw" : (mineIsA ? outcome === "a" : outcome === "b") ? "win" : "loss";
      const before = Number(mineIsA ? m.a_before : m.b_before);
      const delta = Number(mineIsA ? m.a_delta : m.b_delta);
      return {
        time: Number(m.ts),
        result,
        delta,
        ratingBefore: before,
        ratingAfter: before + delta,
        reason: String(m.reason ?? ""),
        title: String(m.title ?? ""),
        opponent: {
          name: String(mineIsA ? m.bn : m.an),
          avatar: this.avatarOf(String(mineIsA ? m.bid : m.aid), mineIsA ? m.bav : m.aav),
          rating: Number(mineIsA ? m.b_before : m.a_before),
        },
      };
    });
    // oldest to newest, starting from the rating before the oldest game shown
    const recent = rows.slice(0, 20).reverse();
    const trend = recent.length ? [recent[0].ratingBefore, ...recent.map((r) => r.ratingAfter)] : [];
    let streak = 0;
    for (const r of rows) {
      if (r.result === "draw") break;
      const dir = r.result === "win" ? 1 : -1;
      if (streak === 0) streak = dir;
      else if (Math.sign(streak) === dir) streak += dir;
      else break;
    }
    return { rows: rows.slice(0, limit), trend, streak };
  }

  async rankedHistory(token: string | null, limit = 12): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    return { ok: true, ...this.historyFor(acc.id, limit) };
  }

  // ---------------------------------------------------------------- profile, settings, friends

  private peekRating(id: string) {
    const r = this.q("SELECT rating, games, wins, losses, draws, peak FROM ratings WHERE account_id = ?", id);
    if (!r.length) return { rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0, peak: START_RATING };
    return { rating: Number(r[0].rating), games: Number(r[0].games), wins: Number(r[0].wins), losses: Number(r[0].losses), draws: Number(r[0].draws), peak: Number(r[0].peak) };
  }

  /** How `me` relates to `other`: self, friends, incoming (they asked me), outgoing (I asked them), or none. */
  private relationship(me: string, other: string): "self" | "friends" | "incoming" | "outgoing" | "none" {
    if (me === other) return "self";
    const [lo, hi] = me < other ? [me, other] : [other, me];
    const r = this.q("SELECT status, requested_by FROM friendships WHERE lo = ? AND hi = ?", lo, hi);
    if (!r.length) return "none";
    if (String(r[0].status) === "accepted") return "friends";
    if (String(r[0].status) === "pending") return String(r[0].requested_by) === me ? "outgoing" : "incoming";
    return "none"; // a declined request
  }

  async myProfile(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    this.ensureIdentity(acc.id);
    const row = this.q("SELECT created, name_changed, allow_requests, profile_public FROM accounts WHERE id = ?", acc.id)[0];
    const days = Math.max(0, num(this.env.NAME_CHANGE_DAYS, 7));
    const last = row.name_changed ? Number(row.name_changed) : 0;
    const nextChange = last && days > 0 && Date.now() - last < days * 86_400_000 ? isoDay(last + days * 86_400_000) : null;
    return {
      ok: true,
      name: acc.name,
      avatar: this.avatarOf(acc.id, acc.avatar),
      memberSince: isoDay(Number(row.created)).slice(0, 7),
      nameChangeDays: days,
      nextNameChange: nextChange,
      allowRequests: Number(row.allow_requests) === 1,
      profilePublic: Number(row.profile_public) === 1,
      identities: this.q("SELECT provider, linked FROM identities WHERE account_id = ? ORDER BY linked ASC", acc.id).map((r) => ({ provider: String(r.provider), linkedOn: isoDay(Number(r.linked)) })),
    };
  }

  async updateSettings(token: string | null, s: { allowRequests?: unknown; profilePublic?: unknown }): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    if (typeof s.allowRequests === "boolean") this.q("UPDATE accounts SET allow_requests = ? WHERE id = ?", s.allowRequests ? 1 : 0, acc.id);
    if (typeof s.profilePublic === "boolean") this.q("UPDATE accounts SET profile_public = ? WHERE id = ?", s.profilePublic ? 1 : 0, acc.id);
    return this.myProfile(token);
  }

  /** Another player's public profile. Players who keep theirs private show only a rating to people who aren't friends. */
  async playerProfile(token: string | null, nameRaw: string): Promise<any> {
    const viewer = await this.account(token);
    if (!viewer) return fail(401, "Sign in first.");
    const rows = this.q("SELECT id, name, avatar, created, profile_public, allow_requests, banned FROM accounts WHERE name = ?", String(nameRaw ?? "").slice(0, 20));
    if (!rows.length || Number(rows[0].banned) || rows[0].name === null) return fail(404, "No player with that username.");
    const r = rows[0];
    const id = String(r.id);
    const relationship = this.relationship(viewer.id, id);
    const full = relationship === "self" || relationship === "friends" || Number(r.profile_public) === 1;
    const stats = this.peekRating(id);
    const ladder = this.ladderRows(this.ladderMin(), null).find((x) => x.id === id);
    const base = {
      ok: true,
      name: String(r.name),
      avatar: this.avatarOf(id, r.avatar),
      relationship,
      acceptsRequests: Number(r.allow_requests) === 1,
      rating: stats.rating,
      provisional: stats.games < PROVISIONAL_GAMES,
      rank: ladder ? ladder.rank : null,
      restricted: !full,
    };
    if (!full) return base;
    const h = this.historyFor(id, 5);
    return {
      ...base,
      games: stats.games, wins: stats.wins, losses: stats.losses, draws: stats.draws, peak: stats.peak,
      memberSince: isoDay(Number(r.created)).slice(0, 7),
      streak: h.streak,
      trend: h.trend,
      recent: h.rows.map((m) => ({ result: m.result, delta: m.delta, title: m.title, time: m.time, opponent: { name: m.opponent.name, avatar: m.opponent.avatar, rating: m.opponent.rating } })),
    };
  }

  private friendRow(id: string) {
    return this.q(
      "SELECT f.status, f.requested_by, a.id AS other, a.name AS name, a.avatar AS avatar FROM friendships f JOIN accounts a ON a.id = CASE WHEN f.lo = ? THEN f.hi ELSE f.lo END WHERE (f.lo = ? OR f.hi = ?) AND a.banned = 0 AND a.name IS NOT NULL ORDER BY a.name ASC",
      id, id, id,
    );
  }

  async friendsList(token: string | null): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    const friends: any[] = [], incoming: any[] = [], outgoing: any[] = [];
    for (const r of this.friendRow(acc.id)) {
      const other = String(r.other);
      const entry = { name: String(r.name), avatar: this.avatarOf(other, r.avatar), rating: this.peekRating(other).rating };
      const status = String(r.status);
      if (status === "accepted") {
        const act = this.statusFor(other);
        friends.push({ ...entry, activity: act.status === "matched" ? "In a ranked match" : act.status === "waiting" ? "Looking for a match" : null });
      } else if (status === "pending") (String(r.requested_by) === acc.id ? outgoing : incoming).push(entry);
    }
    return { ok: true, friends, incoming, outgoing };
  }

  private findByName(name: unknown) {
    const r = this.q("SELECT id, name, allow_requests, banned FROM accounts WHERE name = ?", String(name ?? "").slice(0, 20));
    return r.length && !Number(r[0].banned) && r[0].name !== null ? { id: String(r[0].id), name: String(r[0].name), allow: Number(r[0].allow_requests) === 1 } : null;
  }

  private friendCount(id: string, status: string, requestedBy?: boolean): number {
    const rows = this.q("SELECT requested_by FROM friendships WHERE (lo = ? OR hi = ?) AND status = ?", id, id, status);
    return requestedBy === undefined ? rows.length : rows.filter((r) => (String(r.requested_by) === id) === requestedBy).length;
  }

  async friendAction(token: string | null, action: string, nameRaw: string): Promise<any> {
    const acc = await this.account(token);
    if (!acc) return fail(401, "Sign in first.");
    if (!acc.name) return fail(400, "Choose a username first.");
    const target = this.findByName(nameRaw);
    if (!target) return fail(404, "No player with that username.");
    if (target.id === acc.id) return fail(400, "That's you.");
    const [lo, hi] = acc.id < target.id ? [acc.id, target.id] : [target.id, acc.id];
    const rel = this.relationship(acc.id, target.id);
    const MAX_FRIENDS = 100, MAX_PENDING = 25;

    switch (action) {
      case "request": {
        if (rel === "friends") return fail(409, `You're already friends with ${target.name}.`);
        if (rel === "outgoing") return fail(409, `You've already sent ${target.name} a request.`);
        if (rel === "incoming") return this.friendAction(token, "accept", target.name); // they asked first: just accept
        const declined = this.q("SELECT requested_by, created FROM friendships WHERE lo = ? AND hi = ? AND status = 'declined'", lo, hi);
        if (declined.length && String(declined[0].requested_by) === acc.id && Date.now() - Number(declined[0].created) < 7 * 86_400_000) {
          return fail(403, `You can't send ${target.name} a request right now.`);
        }
        if (!target.allow) return fail(403, `${target.name} isn't accepting friend requests.`);
        if (this.friendCount(acc.id, "pending", true) >= MAX_PENDING) return fail(429, "You have too many requests waiting. Cancel some first.");
        if (this.friendCount(acc.id, "accepted") >= MAX_FRIENDS) return fail(409, "Your friends list is full.");
        this.q("INSERT OR REPLACE INTO friendships (lo, hi, status, requested_by, created) VALUES (?, ?, 'pending', ?, ?)", lo, hi, acc.id, Date.now());
        return { ok: true, status: "requested" };
      }
      case "accept": {
        if (rel !== "incoming") return fail(404, `${target.name} hasn't sent you a request.`);
        if (this.friendCount(acc.id, "accepted") >= MAX_FRIENDS || this.friendCount(target.id, "accepted") >= MAX_FRIENDS) return fail(409, "A friends list is full.");
        this.q("UPDATE friendships SET status = 'accepted', created = ? WHERE lo = ? AND hi = ?", Date.now(), lo, hi);
        return { ok: true, status: "friends" };
      }
      case "decline": {
        if (rel !== "incoming") return fail(404, `${target.name} hasn't sent you a request.`);
        // Kept for a week so the same person can't keep re-sending it. They aren't told.
        this.q("UPDATE friendships SET status = 'declined', created = ? WHERE lo = ? AND hi = ?", Date.now(), lo, hi);
        return { ok: true, status: "none" };
      }
      case "cancel": {
        if (rel !== "outgoing") return fail(404, "There's no request to cancel.");
        this.q("DELETE FROM friendships WHERE lo = ? AND hi = ?", lo, hi);
        return { ok: true, status: "none" };
      }
      case "remove": {
        if (rel !== "friends") return fail(404, `${target.name} isn't on your friends list.`);
        this.q("DELETE FROM friendships WHERE lo = ? AND hi = ?", lo, hi);
        return { ok: true, status: "none" };
      }
      default:
        return fail(400, "Unknown action.");
    }
  }

  // ---- the pool of lists used for ranked matches

  private poolSize(): number {
    return Number(this.q("SELECT COUNT(*) AS n FROM ranked_pool")[0].n);
  }

  private async addPoolList(): Promise<boolean> {
    const topic = DAILY_TOPICS[(this.poolSize() * 7 + 3) % DAILY_TOPICS.length];
    try {
      const list = await generateTopTen(this.env, topic, "easy", this.systemHooks());
      this.q("INSERT INTO ranked_pool (topic, payload, created) VALUES (?, ?, ?)", topic, JSON.stringify(list), Date.now());
      return true;
    } catch (err) {
      console.error("pool list failed:", err instanceof AiError ? err.message : err);
      return false;
    }
  }

  private async topUpPool(perRun: number): Promise<void> {
    for (let i = 0; i < perRun && this.poolSize() < 60; i++) if (!(await this.addPoolList())) break;
  }

  async adminSeedPool(count: number): Promise<any> {
    let added = 0;
    for (let i = 0; i < Math.min(10, Math.max(1, count)); i++) {
      if (!(await this.addPoolList())) break;
      added++;
    }
    return { ok: true, added, poolSize: this.poolSize() };
  }

  async adminAddPool(list: any): Promise<any> {
    const answers = Array.isArray(list?.answers) ? list.answers : [];
    if (answers.length !== 10 || answers.some((a: any) => typeof a?.answer !== "string" || !a.answer.trim())) return fail(400, "list needs exactly 10 answers");
    const clean: TopTen = {
      title: String(list.title ?? "").slice(0, 100) || "Top ten",
      basis: String(list.basis ?? "").slice(0, 120),
      source: String(list.source ?? "").slice(0, 140),
      answers: answers.map((a: any) => ({ answer: String(a.answer).slice(0, 60), aliases: (Array.isArray(a.aliases) ? a.aliases : []).map((x: unknown) => String(x).slice(0, 60)).slice(0, 6), ...(a.detail ? { detail: String(a.detail).slice(0, 80) } : {}) })),
    };
    this.q("INSERT INTO ranked_pool (topic, payload, created) VALUES (?, ?, ?)", clean.title, JSON.stringify(clean), Date.now());
    return { ok: true, poolSize: this.poolSize() };
  }

  // ---- ranked admin

  async adminMatches(limit = 50): Promise<any> {
    return this.q(
      "SELECT m.id, m.ts, m.status, m.outcome, m.reason, m.list_key, m.a_before, m.b_before, m.a_delta, m.b_delta, m.a_risk, m.b_risk, m.flags, a.name AS an, b.name AS bn FROM matches m LEFT JOIN accounts a ON a.id = m.a LEFT JOIN accounts b ON b.id = m.b ORDER BY m.ts DESC LIMIT ?",
      Math.min(200, limit),
    ).map((r) => ({
      id: String(r.id), time: new Date(Number(r.ts)).toISOString(), status: String(r.status), outcome: r.outcome, reason: r.reason, list: String(r.list_key),
      a: r.an, b: r.bn, aBefore: r.a_before, bBefore: r.b_before, aDelta: r.a_delta, bDelta: r.b_delta, aRisk: Number(r.a_risk), bRisk: Number(r.b_risk), flags: JSON.parse(String(r.flags)),
    }));
  }

  /** Undo a match's rating changes (for example after confirming cheating). */
  async adminVoidMatch(id: string): Promise<any> {
    const rows = this.q("SELECT * FROM matches WHERE id = ?", id);
    if (!rows.length) return fail(404, "no such match");
    const m = rows[0];
    if (String(m.status) !== "done") return fail(409, "only finished matches can be voided");
    const undo = (acc: string, delta: number, result: string) => {
      const r = this.ratingRow(acc);
      this.q(
        "UPDATE ratings SET rating = MAX(100, ?), games = MAX(0, games - 1), wins = MAX(0, wins - ?), losses = MAX(0, losses - ?), draws = MAX(0, draws - ?) WHERE account_id = ?",
        r.rating - delta, result === "w" ? 1 : 0, result === "l" ? 1 : 0, result === "d" ? 1 : 0, acc,
      );
    };
    const o = String(m.outcome);
    undo(String(m.a), Number(m.a_delta), o === "a" ? "w" : o === "b" ? "l" : "d");
    undo(String(m.b), Number(m.b_delta), o === "b" ? "w" : o === "a" ? "l" : "d");
    this.q("UPDATE matches SET status = 'void' WHERE id = ?", id);
    return { ok: true };
  }

  async adminSetRating(name: string, rating: number): Promise<any> {
    const r = this.q("SELECT id FROM accounts WHERE name = ?", name);
    if (!r.length) return fail(404, "no such player");
    this.ratingRow(String(r[0].id));
    this.q("UPDATE ratings SET rating = ?, peak = MAX(peak, ?) WHERE account_id = ?", Math.max(100, Math.round(rating)), Math.round(rating), String(r[0].id));
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin

  async adminDaily(date: string) {
    const row = this.listRow(date);
    if (!row) return { ok: true, exists: false, date };
    const n = Number(this.q("SELECT COUNT(*) AS n FROM attempts WHERE date = ?", date)[0].n);
    return { ok: true, exists: true, date, topic: row.topic, difficulty: row.difficulty, status: row.status, attempts: n, list: row.list };
  }

  async adminSetDaily(date: string, list: any, force: boolean): Promise<{ ok: true } | Fail> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, "date must be YYYY-MM-DD");
    const answers = Array.isArray(list?.answers) ? list.answers : [];
    if (answers.length !== 10 || answers.some((a: any) => typeof a?.answer !== "string" || !a.answer.trim())) return fail(400, "list needs exactly 10 answers");
    const n = Number(this.q("SELECT COUNT(*) AS n FROM attempts WHERE date = ?", date)[0].n);
    if (n > 0 && !force) return fail(409, `${n} attempts already exist for ${date}; pass force to replace`);
    const clean: TopTen = {
      title: String(list.title ?? "").slice(0, 100) || "Top ten",
      basis: String(list.basis ?? "").slice(0, 120),
      source: String(list.source ?? "").slice(0, 140),
      answers: answers.map((a: any) => ({
        answer: String(a.answer).slice(0, 60),
        aliases: (Array.isArray(a.aliases) ? a.aliases : []).map((x: unknown) => String(x).slice(0, 60)).slice(0, 6),
        ...(a.detail ? { detail: String(a.detail).slice(0, 80) } : {}),
      })),
    };
    this.q("INSERT OR REPLACE INTO daily_lists (date, topic, difficulty, payload, status, created) VALUES (?, ?, ?, ?, 'ok', ?)", date, String(list.topic ?? clean.title).slice(0, 120), "easy", JSON.stringify(clean), Date.now());
    return { ok: true };
  }

  async adminVoidDay(date: string, voided: boolean): Promise<{ ok: true } | Fail> {
    if (!this.listRow(date)) return fail(404, "no list for that date");
    this.q("UPDATE daily_lists SET status = ? WHERE date = ?", voided ? "void" : "ok", date);
    return { ok: true };
  }

  async adminAttempts(date: string) {
    const rows = this.q("SELECT a.*, acc.name AS name FROM attempts a JOIN accounts acc ON acc.id = a.account_id WHERE a.date = ? ORDER BY a.score DESC, a.total_ms ASC", date);
    const ipCounts = new Map<string, number>();
    for (const r of rows) ipCounts.set(String(r.ip), (ipCounts.get(String(r.ip)) ?? 0) + 1);
    return rows.map((r) => {
      const a = this.attemptFrom(r);
      return {
        id: a.id, name: String(r.name), state: a.state, score: a.score, found: a.found.length, wrong: a.wrong, totalMs: a.total_ms,
        risk: a.risk, flags: a.flags, review: a.review, accountsOnSameConnection: ipCounts.get(a.ip) ?? 1,
      };
    });
  }

  async adminGuesses(attemptId: number) {
    return this.q("SELECT n, ms, kind, rank, text, sig, flags FROM guesses WHERE attempt_id = ? ORDER BY n", attemptId).map((r) => ({
      n: Number(r.n), ms: Number(r.ms), kind: String(r.kind), rank: r.rank === null ? null : Number(r.rank), text: String(r.text),
      sig: JSON.parse(String(r.sig)), flags: JSON.parse(String(r.flags)),
    }));
  }

  async adminReview(attemptId: number, action: string): Promise<{ ok: true } | Fail> {
    const map: Record<string, string> = { clear: "cleared", hold: "held", void: "void" };
    if (!map[action]) return fail(400, "action must be clear, hold or void");
    if (!this.q("SELECT 1 FROM attempts WHERE id = ?", attemptId).length) return fail(404, "no such attempt");
    this.q("UPDATE attempts SET review = ? WHERE id = ?", map[action], attemptId);
    return { ok: true };
  }

  async adminBan(name: string, banned: boolean): Promise<{ ok: true } | Fail> {
    const r = this.q("SELECT id FROM accounts WHERE name = ?", name);
    if (!r.length) return fail(404, "no such player");
    this.q("UPDATE accounts SET banned = ? WHERE name = ?", banned ? 1 : 0, name);
    if (banned) {
      this.q("DELETE FROM sessions WHERE account_id = ?", String(r[0].id));
      this.queue.delete(String(r[0].id));
    }
    return { ok: true };
  }
}
