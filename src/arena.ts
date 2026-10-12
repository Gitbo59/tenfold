import { DurableObject } from "cloudflare:workers";
import { AiError, generateTopTen, type Difficulty, type TopTen } from "./ai";
import { REVIEW_THRESHOLD, assessAttempt, assessGuess, cleanSignals } from "./anticheat";
import { dailyTopic } from "./daily-topics";
import { matchGuess, normalize, type Answer } from "./match";
import type { Env } from "./types";
import { num } from "./util";

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
}

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
export class Arena extends DurableObject<Env> {
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
      "SELECT a.id, a.name, a.banned FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?",
      await sha256hex(token),
      Date.now(),
    );
    if (!rows.length) return null;
    const r = rows[0];
    return { id: String(r.id), name: r.name === null ? null : String(r.name), banned: Number(r.banned) };
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

  /** Called after the provider has proved who someone is. `idHash` is already a one-way hash. */
  async signIn(idHash: string): Promise<{ ok: true; token: string; name: string | null } | Fail> {
    const now = Date.now();
    const found = this.q("SELECT id, name, banned FROM accounts WHERE id = ?", idHash);
    if (found.length && Number(found[0].banned)) return fail(403, "This account can't be used.");
    if (!found.length) this.q("INSERT INTO accounts (id, name, banned, created, last_seen) VALUES (?, NULL, 0, ?, ?)", idHash, now, now);
    else this.q("UPDATE accounts SET last_seen = ? WHERE id = ?", now, idHash);
    const token = randomToken();
    this.q("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)", await sha256hex(token), idHash, now + SESSION_MS);
    return { ok: true, token, name: found.length && found[0].name !== null ? String(found[0].name) : null };
  }

  async me(token: string | null): Promise<{ signedIn: boolean; name: string | null }> {
    const a = await this.account(token);
    return a ? { signedIn: true, name: a.name } : { signedIn: false, name: null };
  }

  async signOut(token: string | null): Promise<void> {
    if (token) this.q("DELETE FROM sessions WHERE token_hash = ?", await sha256hex(token));
  }

  async setName(token: string | null, raw: string): Promise<{ ok: true; name: string } | Fail> {
    const a = await this.account(token);
    if (!a) return fail(401, "Sign in first.");
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!NAME_RE.test(name)) return fail(400, "Use 3 to 16 letters, numbers, spaces, hyphens or underscores.");
    if (RESERVED.includes(name.toLowerCase())) return fail(400, "That name is reserved.");
    try {
      this.q("UPDATE accounts SET name = ? WHERE id = ?", name, a.id);
    } catch {
      return fail(409, "That name is taken. Try another.");
    }
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
    this.q("DELETE FROM accounts WHERE id = ?", a.id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- the daily list

  private listRow(date: string): { topic: string; difficulty: string; list: TopTen; status: string } | null {
    const r = this.q("SELECT topic, difficulty, payload, status FROM daily_lists WHERE date = ?", date);
    if (!r.length) return null;
    return { topic: String(r[0].topic), difficulty: String(r[0].difficulty), list: JSON.parse(String(r[0].payload)), status: String(r[0].status) };
  }

  private async generate(date: string): Promise<TopTen> {
    const topic = dailyTopic(date);
    const difficulty: Difficulty = this.env.DAILY_DIFFICULTY === "hard" ? "hard" : "easy";
    const quota = this.env.QUOTA.get(this.env.QUOTA.idFromName("global"));
    const list = await generateTopTen(this.env, topic, difficulty, {
      reserve: async () => {
        const r = await quota.reserveSystem();
        if (!r.ok) throw new AiError("The daily list couldn't be built today.", "system cap", { budget: true });
      },
      refund: () => quota.refundSystem(),
    });
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
    if (!acc.name) return fail(400, "Choose a display name first.");
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
        `SELECT acc.id AS id, acc.name AS name, SUM(a.score) AS score, COUNT(*) AS days, SUM(a.total_ms) AS ms FROM attempts a JOIN accounts acc ON acc.id = a.account_id JOIN daily_lists d ON d.date = a.date AND d.status = 'ok' WHERE substr(a.date, 1, 7) = ? AND a.state = 'done' AND ${visible} AND acc.banned = 0 GROUP BY acc.id ORDER BY score DESC, ms ASC LIMIT 300`,
        month, viewer ?? "",
      );
    } else {
      rows = this.q(
        `SELECT acc.id AS id, acc.name AS name, a.score AS score, a.found AS found, a.total_ms AS ms FROM attempts a JOIN accounts acc ON acc.id = a.account_id WHERE a.date = ? AND a.state = 'done' AND ${visible} AND acc.banned = 0 AND a.review != 'void' ORDER BY a.score DESC, a.total_ms ASC, a.id ASC LIMIT 300`,
        date, viewer ?? "",
      );
    }
    const mapped = rows.map((r, i) => ({
      rank: i + 1,
      name: String(r.name),
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
    if (banned) this.q("DELETE FROM sessions WHERE account_id = ?", String(r[0].id));
    return { ok: true };
  }
}
