import { DurableObject } from "cloudflare:workers";
import type { TopTen } from "./ai";
import type { Env } from "./types";
import { num } from "./util";

const CACHE_MAX_ROWS = 1500;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPORTS_MAX_ROWS = 1000;
const REPORTS_PER_IP_PER_DAY = 20;

export interface ReportInput {
  listKey: string;
  topic: string;
  difficulty: string | null;
  kind: "wrong" | "rank" | "alias";
  rank: number;
  answer: string;
  ip: string;
}

/**
 * One global instance that keeps the site inside the free tiers:
 *  - a daily cap on AI requests, plus a per-connection cap
 *  - a cap on rooms created per connection per hour
 *  - a cache of generated lists (cache hits cost nothing)
 *  - the log of player reports
 * Only hashed connection ids are stored, never raw IP addresses.
 */
export class Quota extends DurableObject<Env> {
  private sweptDay = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, bucket TEXT NOT NULL, n INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL, plays INTEGER NOT NULL DEFAULT 0)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, list_key TEXT NOT NULL, topic TEXT, difficulty TEXT, kind TEXT NOT NULL, rank INTEGER, answer TEXT, ip TEXT)",
    );
  }

  // ---------------------------------------------------------------- counters

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private hour(): string {
    return new Date().toISOString().slice(0, 13);
  }

  private get(key: string): number {
    const rows = this.ctx.storage.sql.exec("SELECT n FROM counters WHERE key = ?", key).toArray();
    return rows.length ? Number(rows[0].n) : 0;
  }

  private add(key: string, bucket: string, by: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (key, bucket, n) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET n = MAX(0, n + ?)",
      key,
      bucket,
      Math.max(0, by),
      by,
    );
  }

  /** Drop counters from earlier days (at most once per day). */
  private sweep(day: string): void {
    if (this.sweptDay === day) return;
    this.sweptDay = day;
    this.ctx.storage.sql.exec("DELETE FROM counters WHERE substr(bucket, 1, 10) < ?", day);
  }

  private caps() {
    return {
      daily: Math.max(0, Math.floor(num(this.env.DAILY_GENERATION_CAP, 30))),
      perIp: Math.max(0, Math.floor(num(this.env.IP_DAILY_GENERATIONS, 4))),
      roomsPerHour: Math.max(1, Math.floor(num(this.env.IP_ROOMS_PER_HOUR, 10))),
    };
  }

  // ---------------------------------------------------------------- AI budget

  async reserveGeneration(ip: string): Promise<{ ok: true; remaining: number } | { ok: false; reason: "global" | "ip" }> {
    const { daily, perIp } = this.caps();
    const day = this.day();
    this.sweep(day);
    const used = this.get(`gen:${day}`);
    if (used >= daily) return { ok: false, reason: "global" };
    if (this.get(`ip:${ip}:${day}`) >= perIp) return { ok: false, reason: "ip" };
    this.add(`gen:${day}`, day, 1);
    this.add(`ip:${ip}:${day}`, day, 1);
    return { ok: true, remaining: daily - used - 1 };
  }

  async refundGeneration(ip: string): Promise<void> {
    const day = this.day();
    this.add(`gen:${day}`, day, -1);
    this.add(`ip:${ip}:${day}`, day, -1);
  }

  /**
   * The daily challenge list is scheduled work, so it isn't blocked when players have used up the
   * public allowance. It has its own small cap and still counts towards the daily total.
   */
  async reserveSystem(): Promise<{ ok: boolean }> {
    const day = this.day();
    this.sweep(day);
    if (this.get(`sys:${day}`) >= 6) return { ok: false };
    this.add(`sys:${day}`, day, 1);
    this.add(`gen:${day}`, day, 1);
    return { ok: true };
  }

  async refundSystem(): Promise<void> {
    const day = this.day();
    this.add(`sys:${day}`, day, -1);
    this.add(`gen:${day}`, day, -1);
  }

  async budget(): Promise<{ remaining: number; cap: number }> {
    const { daily } = this.caps();
    return { remaining: Math.max(0, daily - this.get(`gen:${this.day()}`)), cap: daily };
  }

  async allowRoomCreate(ip: string): Promise<boolean> {
    const { roomsPerHour } = this.caps();
    const hour = this.hour();
    const key = `room:${ip}:${hour}`;
    if (this.get(key) >= roomsPerHour) return false;
    this.add(key, hour, 1);
    return true;
  }

  // ---------------------------------------------------------------- list cache

  async cacheGet(key: string): Promise<TopTen | null> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec("SELECT payload, created FROM cache WHERE key = ?", key).toArray();
    if (!rows.length) return null;
    if (Number(rows[0].created) < Date.now() - CACHE_TTL_MS) {
      sql.exec("DELETE FROM cache WHERE key = ?", key);
      return null;
    }
    sql.exec("UPDATE cache SET plays = plays + 1 WHERE key = ?", key);
    try {
      return JSON.parse(String(rows[0].payload)) as TopTen;
    } catch {
      sql.exec("DELETE FROM cache WHERE key = ?", key);
      return null;
    }
  }

  async cachePut(key: string, list: TopTen): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO cache (key, payload, created, plays) VALUES (?, ?, ?, 0)", key, JSON.stringify(list), Date.now());
    const count = Number(sql.exec("SELECT COUNT(*) AS n FROM cache").one().n);
    if (count > CACHE_MAX_ROWS) {
      sql.exec("DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY plays ASC, created ASC LIMIT ?)", count - CACHE_MAX_ROWS);
    }
  }

  // ---------------------------------------------------------------- reports

  async report(r: ReportInput): Promise<{ ok: boolean; evicted: boolean }> {
    const sql = this.ctx.storage.sql;
    const day = this.day();
    if (this.get(`rep:${r.ip}:${day}`) >= REPORTS_PER_IP_PER_DAY) return { ok: false, evicted: false };
    this.add(`rep:${r.ip}:${day}`, day, 1);

    sql.exec(
      "INSERT INTO reports (ts, list_key, topic, difficulty, kind, rank, answer, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(),
      r.listKey,
      r.topic.slice(0, 160),
      r.difficulty,
      r.kind,
      r.rank,
      r.answer.slice(0, 120),
      r.ip,
    );
    sql.exec("DELETE FROM reports WHERE id <= (SELECT MAX(id) FROM reports) - ?", REPORTS_MAX_ROWS);

    // Enough independent reporters retire the cached copy so nobody is served it again.
    let evicted = false;
    if (r.kind !== "alias") {
      const need = Math.max(1, Math.floor(num(this.env.REPORT_EVICT_AFTER, 2)));
      const n = Number(
        sql.exec("SELECT COUNT(DISTINCT ip) AS n FROM reports WHERE list_key = ? AND kind != 'alias'", r.listKey).one().n,
      );
      if (n >= need && sql.exec("SELECT 1 FROM cache WHERE key = ?", r.listKey).toArray().length) {
        sql.exec("DELETE FROM cache WHERE key = ?", r.listKey);
        evicted = true;
      }
    }
    return { ok: true, evicted };
  }

  // ---------------------------------------------------------------- admin

  async stats() {
    const sql = this.ctx.storage.sql;
    const { daily, perIp, roomsPerHour } = this.caps();
    return {
      day: this.day(),
      aiRequestsToday: this.get(`gen:${this.day()}`),
      dailyCap: daily,
      perIpDailyCap: perIp,
      roomsPerIpPerHour: roomsPerHour,
      cachedLists: Number(sql.exec("SELECT COUNT(*) AS n FROM cache").one().n),
      storedReports: Number(sql.exec("SELECT COUNT(*) AS n FROM reports").one().n),
    };
  }

  async listReports(limit = 100) {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec("SELECT ts, list_key, topic, difficulty, kind, rank, answer FROM reports ORDER BY id DESC LIMIT ?", Math.min(500, limit))
      .toArray();
    return rows.map((r) => ({
      time: new Date(Number(r.ts)).toISOString(),
      list: r.list_key,
      topic: r.topic,
      difficulty: r.difficulty,
      kind: r.kind,
      rank: r.rank,
      answer: r.answer,
    }));
  }
}
