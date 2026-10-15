import { DurableObject } from "cloudflare:workers";
import { AiError, cacheKey, generateTopTen, type Difficulty, type TopTen } from "./ai";
import { CLASSICS, getClassic } from "./classics";
import { assessGuess, cleanSignals } from "./anticheat";
import { matchGuess, normalize, type Answer } from "./match";
import type { Env } from "./types";
import { num } from "./util";

type Phase = "lobby" | "generating" | "playing" | "finished";

interface Config {
  lives: number;
  timerEnabled: boolean;
  turnSeconds: number;
  difficulty: Difficulty;
  hints: number;
}

interface Player {
  id: string;
  name: string;
  lives: number;
  score: number;
  streak: number;
  eliminated: boolean;
}

interface LogEntry {
  id: number;
  kind: "info" | "correct" | "wrong" | "timeout" | "bonus";
  text: string;
}

interface RankedInfo {
  matchId: string;
  listKey: string;
  /** [a, b]. The order the rating service knows them in. */
  players: { id: string; name: string; rating: number }[];
  joinBy: number;
  result?: { outcome: "a" | "b" | "draw" | "abort"; reason: string; aDelta: number; bDelta: number; aRating: number; bRating: number; pending?: boolean };
  reported: boolean;
}

interface Saved {
  initialized: boolean;
  phase: Phase;
  config: Config;
  topic: string;
  basis: string;
  source: string;
  listKey: string;
  listDifficulty: Difficulty | null;
  answers: Answer[];
  players: Player[];
  hostId: string | null;
  turnIdx: number;
  turnStartedAt: number;
  wrong: string[];
  wrongKeys: string[];
  hints: { rank: number; text: string }[];
  hintVotes: string[];
  hintsLeft: number;
  reportsBy: Record<string, number>;
  reported: string[];
  sourceViewed: string[];
  playedKeys: string[];
  ranked: RankedInfo | null;
  risk: Record<string, { w: number; flags: string[] }>;
  log: LogEntry[];
  logSeq: number;
  genCount: number;
  lastActive: number;
}

const MAX_PLAYERS = 8;
const MAX_REPORTS_PER_PLAYER = 5;
const AWAY_GRACE_MS = 20_000; // how long we wait for a disconnected player before skipping them
const LOBBY_REMOVE_MS = 30_000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const FINISH_BONUS = 5;
const LIFE_BONUS = 2;

function defaultState(): Saved {
  return {
    initialized: false,
    phase: "lobby",
    config: { lives: 3, timerEnabled: true, turnSeconds: 20, difficulty: "easy", hints: 3 },
    topic: "",
    basis: "",
    source: "",
    listKey: "",
    listDifficulty: null,
    answers: [],
    players: [],
    hostId: null,
    turnIdx: 0,
    turnStartedAt: 0,
    wrong: [],
    wrongKeys: [],
    hints: [],
    hintVotes: [],
    hintsLeft: 0,
    reportsBy: {},
    reported: [],
    sourceViewed: [],
    playedKeys: [],
    ranked: null,
    risk: {},
    log: [],
    logSeq: 0,
    genCount: 0,
    lastActive: Date.now(),
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A clue that narrows things down without giving the answer away. */
export function makeHint(answer: string): string {
  const chars = [...answer.trim()];
  const words = answer.trim().split(/\s+/).length;
  const letters = chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  const first = (chars[0] ?? "?").toUpperCase();
  return words > 1 ? `${words} words, ${letters} letters, starts with ${first}` : `${letters} letters, starts with ${first}`;
}

export class Room extends DurableObject<Env> {
  private s: Saved = defaultState();
  private conns = new Map<WebSocket, string | null>();
  private ips = new WeakMap<WebSocket, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private turnToken = 0;
  private deadline: number | null = null;
  private lobbyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rate = new WeakMap<WebSocket, { t: number; n: number }>();
  private lastAction = Date.now();
  private idleArmed = false;
  private accts = new WeakMap<WebSocket, { id: string; name: string }>();
  private forfeitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private joinTimer?: ReturnType<typeof setTimeout>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Saved>("state");
      if (saved) {
        const def = defaultState();
        this.s = { ...def, ...saved, config: { ...def.config, ...saved.config } };
        // A generation can't survive an eviction, so drop back to the lobby.
        if (this.s.phase === "generating") this.s.phase = "lobby";
      }
    });
  }

  // ---------------------------------------------------------------- HTTP / WebSocket entry

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      if (this.s.initialized) return new Response("exists", { status: 409 });
      this.s.initialized = true;
      this.persist();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return new Response("ok");
    }
    if (!this.s.initialized) return new Response("Room not found", { status: 404 });
    if (url.pathname === "/status") return new Response("ok");

    // Called by the matchmaker: turns this room into a ranked 1v1 for two specific accounts.
    if (url.pathname === "/ranked-setup" && request.method === "POST") {
      if (this.s.ranked) return new Response("exists", { status: 409 });
      const body: any = await request.json().catch(() => null);
      const pl = body?.players;
      if (!body?.matchId || !Array.isArray(pl) || pl.length !== 2 || !Array.isArray(body?.list?.answers) || body.list.answers.length !== 10) return new Response("bad setup", { status: 400 });
      this.s.config = { lives: 3, timerEnabled: true, turnSeconds: 20, difficulty: "easy", hints: 0 };
      this.s.players = pl.map((p: any) => ({ id: String(p.id), name: String(p.name).slice(0, 16), lives: 3, score: 0, streak: 0, eliminated: false }));
      this.s.hostId = this.s.players[0].id;
      this.s.topic = String(body.list.title ?? "");
      this.s.basis = String(body.list.basis ?? "");
      this.s.source = String(body.list.source ?? "");
      this.s.listKey = String(body.listKey ?? "");
      this.s.listDifficulty = null;
      this.s.answers = body.list.answers.map((x: any) => ({ answer: String(x.answer), aliases: (x.aliases ?? []).map(String), ...(x.detail ? { detail: String(x.detail) } : {}) }));
      this.s.ranked = {
        matchId: String(body.matchId),
        listKey: this.s.listKey,
        players: pl.map((p: any) => ({ id: String(p.id), name: String(p.name).slice(0, 16), rating: Number(p.rating) || 0 })),
        joinBy: Date.now() + Math.max(1, num(this.env.RANKED_JOIN_SECONDS, 45)) * 1000,
        reported: false,
      };
      this.s.phase = "lobby";
      this.persist();
      this.joinTimer = setTimeout(() => this.checkJoinDeadline(), Math.max(1, num(this.env.RANKED_JOIN_SECONDS, 45)) * 1000 + 250);
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.conns.set(server, null);
    this.ips.set(server, request.headers.get("x-ip-hash") ?? "unknown");
    const accountId = request.headers.get("x-account-id");
    if (accountId) this.accts.set(server, { id: accountId, name: request.headers.get("x-account-name") ?? "" });
    server.addEventListener("message", (ev) => void this.onMessage(server, ev.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    this.idleArmed = false;
    const now = Date.now();
    if (this.s.ranked?.result && !this.s.ranked.reported) await this.reportRanked();
    this.checkJoinDeadline();

    // Free-plan guard: a room nobody has touched for a while stops holding its sockets open,
    // because connected sockets keep the object awake and use up the daily duration allowance.
    const idleMs = Math.max(0.05, num(this.env.IDLE_MINUTES, 15)) * 60_000;
    if (this.conns.size > 0 && now - this.lastAction > idleMs) {
      for (const ws of [...this.conns.keys()]) {
        try {
          ws.close(4001, "idle");
        } catch {
          /* already closed */
        }
        this.onClose(ws);
      }
    }
    if (this.conns.size > 0) {
      this.idleArmed = true;
      await this.ctx.storage.setAlarm(now + this.idleCheckMs());
      return;
    }

    if (now - this.s.lastActive > ROOM_TTL_MS) {
      this.clearTimer();
      await this.ctx.storage.deleteAll();
      this.s = defaultState();
      return;
    }
    await this.ctx.storage.setAlarm(now + ROOM_TTL_MS / 6);
  }

  private idleCheckMs(): number {
    return Math.max(1, num(this.env.IDLE_CHECK_SECONDS, 120)) * 1000;
  }

  private armIdleAlarm(): void {
    if (this.idleArmed) return;
    this.idleArmed = true;
    void this.ctx.storage.setAlarm(Date.now() + this.idleCheckMs());
  }

  private touch(): void {
    this.lastAction = Date.now();
  }

  private quota() {
    return this.env.QUOTA.get(this.env.QUOTA.idFromName("global"));
  }

  // ---------------------------------------------------------------- messaging

  private persist(): void {
    this.s.lastActive = Date.now();
    void this.ctx.storage.put("state", this.s);
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket already closed */
    }
  }

  private toast(ws: WebSocket, msg: string, kind: "info" | "error" = "info"): void {
    this.send(ws, { t: "toast", kind, msg });
  }

  private toastAll(msg: string, kind: "info" | "error" = "info"): void {
    for (const ws of this.conns.keys()) this.toast(ws, msg, kind);
  }

  private broadcast(): void {
    const payload = JSON.stringify(this.snapshot());
    for (const ws of this.conns.keys()) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private addLog(kind: LogEntry["kind"], text: string): void {
    this.s.log.push({ id: ++this.s.logSeq, kind, text });
    if (this.s.log.length > 40) this.s.log.shift();
  }

  private isConnected(pid: string): boolean {
    for (const id of this.conns.values()) if (id === pid) return true;
    return false;
  }

  /** The host is the stored host if they're here, otherwise the earliest-joined connected player. */
  private hostId(): string | null {
    const stored = this.s.players.find((p) => p.id === this.s.hostId);
    if (stored && this.isConnected(stored.id)) return stored.id;
    const first = this.s.players.find((p) => this.isConnected(p.id));
    return first?.id ?? stored?.id ?? null;
  }

  /** Players who count towards a hint vote: still in the game and connected. */
  private hintVoters(): string[] {
    return this.s.players.filter((p) => !p.eliminated && this.isConnected(p.id)).map((p) => p.id);
  }

  private snapshot() {
    const { s } = this;
    const finished = s.phase === "finished";
    const cur = s.phase === "playing" ? this.currentPlayer() : undefined;
    const maxScore = Math.max(0, ...s.players.map((p) => p.score));
    return {
      t: "state",
      phase: s.phase,
      config: s.config,
      topic: s.topic,
      basis: s.basis,
      // In a ranked match the source stays hidden until it's over (it would be a lookup).
      source: s.ranked && !finished ? "" : s.source,
      classic: s.listKey.startsWith("classic:"),
      listDifficulty: s.listDifficulty,
      classics: s.phase === "lobby" ? CLASSICS.map((c) => ({ id: c.id, title: c.title })) : undefined,
      hostId: s.ranked ? null : this.hostId(),
      ranked: s.ranked
        ? { waiting: s.phase === "lobby" && !s.ranked.result, players: s.ranked.players, result: s.ranked.result ?? null }
        : null,
      turnPid: cur?.id ?? null,
      deadline: this.deadline,
      turnMs: this.deadline ? this.deadline - s.turnStartedAt : 0,
      awayGrace: !!this.deadline && !s.config.timerEnabled,
      serverNow: Date.now(),
      hintsLeft: s.hintsLeft,
      hintVotes: s.hintVotes,
      hintVoters: s.phase === "playing" ? this.hintVoters().length : 0,
      players: s.players.map((p, i) => ({
        rating: s.ranked ? s.ranked.players[i]?.rating : undefined,
        id: p.id,
        name: p.name,
        lives: p.lives,
        score: p.score,
        streak: p.streak,
        eliminated: p.eliminated,
        connected: this.isConnected(p.id),
      })),
      // Unfound answers stay on the server until the game ends. Only a hint's clue goes out.
      answers: s.answers.map((a, i) => {
        const rank = i + 1;
        if (a.found || finished) {
          return { rank, answer: a.answer, detail: a.detail ?? "", found: a.found ?? null, reports: a.reports ?? 0 };
        }
        const hint = s.hints.find((h) => h.rank === rank);
        return hint ? { rank, hint: hint.text } : { rank };
      }),
      wrong: s.wrong,
      log: s.log,
      winners: finished && maxScore > 0 ? s.players.filter((p) => p.score === maxScore).map((p) => p.id) : [],
    };
  }

  // ---------------------------------------------------------------- incoming messages

  private rateOk(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rate.get(ws);
    if (!r || now - r.t > 1000) {
      this.rate.set(ws, { t: now, n: 1 });
      return true;
    }
    return ++r.n <= 15;
  }

  private async onMessage(ws: WebSocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "ping") return this.send(ws, { t: "pong" }); // keep-alives don't count as activity
    if (!this.rateOk(ws)) return;
    if (msg.t === "join") return this.onJoin(ws, msg);

    const pid = this.conns.get(ws);
    const me = pid ? this.s.players.find((p) => p.id === pid) : undefined;
    if (!me) return;
    this.touch();
    if (this.s.ranked && !["guess", "report", "resign"].includes(msg.t)) return;

    switch (msg.t) {
      case "resign":
        return this.forfeit(me.id, "resigned");
      case "config":
        return this.onConfig(me, msg);
      case "start":
        return this.onStart(ws, me, msg);
      case "guess":
        return this.onGuess(ws, me, msg);
      case "hint":
        return this.onHintVote(ws, me);
      case "report":
        return this.onReport(ws, me, msg);
      case "source":
        return this.onSourceViewed(me);
      case "rematch":
        return this.onRematch(me);
    }
  }

  private onJoin(ws: WebSocket, msg: any): void {
    if (this.s.ranked) return this.onRankedJoin(ws);
    const pid = typeof msg.pid === "string" && /^[A-Za-z0-9-]{8,48}$/.test(msg.pid) ? msg.pid : null;
    if (!pid) return;
    this.touch();
    let player = this.s.players.find((p) => p.id === pid);

    if (!player) {
      if (this.s.phase !== "lobby") {
        // Late arrivals watch the game and can join the next round.
        this.conns.set(ws, null);
        this.toast(ws, "A game is in progress. You're watching; you can join the next round.");
        this.send(ws, this.snapshot());
        return;
      }
      if (this.s.players.length >= MAX_PLAYERS) {
        this.conns.set(ws, null);
        this.toast(ws, `This room is full (${MAX_PLAYERS} players).`, "error");
        this.send(ws, this.snapshot());
        return;
      }
      const base = cleanText(msg.name, 16) || "Player";
      let name = base;
      for (let n = 2; this.s.players.some((p) => p.name.toLowerCase() === name.toLowerCase()); n++) {
        name = `${base.slice(0, 13)} ${n}`;
      }
      player = { id: pid, name, lives: this.s.config.lives, score: 0, streak: 0, eliminated: false };
      this.s.players.push(player);
      if (!this.s.hostId) this.s.hostId = pid;
      this.addLog("info", `${name} joined the room.`);
    } else {
      // Same player reconnecting: retire any older socket quietly.
      for (const [other, id] of this.conns) {
        if (id === pid && other !== ws) {
          this.conns.delete(other);
          try {
            other.close(1000, "replaced");
          } catch {
            /* ignore */
          }
        }
      }
    }

    this.conns.set(ws, pid);
    const pending = this.lobbyTimers.get(pid);
    if (pending) {
      clearTimeout(pending);
      this.lobbyTimers.delete(pid);
    }
    this.armIdleAlarm();
    this.ensureTimer();
    this.checkHints();
    this.persist();
    this.broadcast();
  }

  private onConfig(me: Player, msg: any): void {
    if (this.s.ranked) return;
    if (this.s.phase !== "lobby" || this.hostId() !== me.id) return;
    const c = this.s.config;
    this.s.config = {
      lives: clampInt(msg.lives, 1, 10, c.lives),
      timerEnabled: typeof msg.timerEnabled === "boolean" ? msg.timerEnabled : c.timerEnabled,
      turnSeconds: clampInt(msg.turnSeconds, 5, 120, c.turnSeconds),
      difficulty: msg.difficulty === "easy" || msg.difficulty === "hard" ? msg.difficulty : c.difficulty,
      hints: clampInt(msg.hints, 0, 5, c.hints),
    };
    for (const p of this.s.players) p.lives = this.s.config.lives;
    this.persist();
    this.broadcast();
  }

  // ---------------------------------------------------------------- starting a game

  /** Gets a list from the cache or the AI, always through the free-allowance guards. */
  private async getList(ws: WebSocket, topic: string, difficulty: Difficulty, key: string): Promise<TopTen> {
    const q = this.quota();
    // A room that already played this exact list gets a fresh one if the budget allows.
    if (!this.s.playedKeys.includes(key)) {
      const hit = await q.cacheGet(key);
      if (hit) return hit;
    }

    const ip = this.ips.get(ws) ?? "unknown";
    const roomCap = Math.max(0, Math.floor(num(this.env.ROOM_GENERATIONS, 5)));
    try {
      const list = await generateTopTen(this.env, topic, difficulty, {
        reserve: async () => {
          if (this.s.genCount >= roomCap) {
            throw new AiError(
              "This room has used all of its AI lists. Create a new room, or play a built-in list.",
              "room cap",
              { budget: true },
            );
          }
          const r = await q.reserveGeneration(ip);
          if (!r.ok) {
            throw new AiError(
              r.reason === "global"
                ? "Today's free AI allowance is used up. Play a built-in list, or try again after midnight UTC."
                : "You've reached today's limit of new AI lists from this connection. Play a built-in list, or try again tomorrow.",
              `cap: ${r.reason}`,
              { budget: true },
            );
          }
          this.s.genCount++;
        },
        refund: async () => {
          this.s.genCount = Math.max(0, this.s.genCount - 1);
          await q.refundGeneration(ip);
        },
      });
      await q.cachePut(key, list);
      return list;
    } catch (err) {
      if (err instanceof AiError && err.opts.budget) {
        const hit = await q.cacheGet(key);
        if (hit) {
          this.toastAll("The free AI allowance is used up, so you're replaying a saved list for this topic.");
          return hit;
        }
      }
      throw err;
    }
  }

  private async onStart(ws: WebSocket, me: Player, msg: any): Promise<void> {
    if (this.s.ranked) return;
    if (this.s.phase !== "lobby" || this.hostId() !== me.id) return;

    const wantsClassic = typeof msg.classic === "string" && msg.classic.length > 0;
    const classic = wantsClassic ? getClassic(msg.classic) : undefined;
    if (wantsClassic && !classic) return this.toast(ws, "That built-in list doesn't exist.", "error");
    const topic = cleanText(msg.topic, 120);
    if (!classic && topic.length < 3) return this.toast(ws, "Enter a topic first (at least 3 characters).", "error");

    // Anyone who dropped out of the lobby doesn't get a seat.
    this.s.players = this.s.players.filter((p) => this.isConnected(p.id));
    this.s.phase = "generating";
    this.s.topic = classic ? classic.title : topic;
    this.persist();
    this.broadcast();

    const difficulty = this.s.config.difficulty;
    try {
      let list: TopTen;
      let key: string;
      let listDifficulty: Difficulty | null;
      if (classic) {
        list = { title: classic.title, basis: classic.basis, source: classic.source, answers: classic.answers };
        key = `classic:${classic.id}`;
        listDifficulty = null;
      } else {
        key = cacheKey(topic, difficulty);
        listDifficulty = difficulty;
        list = await this.getList(ws, topic, difficulty, key);
      }
      if (this.s.phase !== "generating") return;

      this.s.topic = list.title;
      this.s.basis = list.basis;
      this.s.source = list.source ?? "";
      this.s.listKey = key;
      this.s.listDifficulty = listDifficulty;
      this.s.answers = list.answers.map((x) => ({ answer: x.answer, aliases: [...x.aliases], ...(x.detail ? { detail: x.detail } : {}) }));
      this.s.playedKeys = [...this.s.playedKeys.filter((k) => k !== key), key].slice(-30);
      this.resetRound();
      this.s.turnIdx = Math.floor(Math.random() * this.s.players.length);
      this.s.phase = "playing";
      this.addLog("info", `${this.s.players[this.s.turnIdx].name} goes first.`);
      this.startTurn();
    } catch (err) {
      console.error("generation failed:", err instanceof AiError ? `${err.message}` : err);
      this.s.phase = "lobby";
      this.s.topic = "";
      this.toastAll(err instanceof AiError ? err.userMessage : "Couldn't build that list. Try again.", "error");
    }
    this.persist();
    this.broadcast();
  }

  /** Reset everything that belongs to a single round. */
  private resetRound(): void {
    this.s.wrong = [];
    this.s.wrongKeys = [];
    this.s.log = [];
    this.s.hints = [];
    this.s.hintVotes = [];
    this.s.hintsLeft = this.s.config.hints;
    this.s.reportsBy = {};
    this.s.reported = [];
    this.s.sourceViewed = [];
    for (const p of this.s.players) {
      p.lives = this.s.config.lives;
      p.score = 0;
      p.streak = 0;
      p.eliminated = false;
    }
  }

  // ---------------------------------------------------------------- guessing

  private onGuess(ws: WebSocket, me: Player, msg: any): void {
    if (this.s.phase !== "playing") return;
    if (this.currentPlayer()?.id !== me.id) return this.toast(ws, "It's not your turn yet.");
    const guess = cleanText(msg.text, 80);
    if (!guess) return;

    const key = normalize(guess);
    const m = matchGuess(guess, this.s.answers);

    if (m.kind === "dupe") {
      return this.toast(ws, `${this.s.answers[m.index].answer} is already on the board. Try another.`);
    }

    if (m.kind === "hit") {
      const a = this.s.answers[m.index];
      const rank = m.index + 1;
      let speed = 0;
      if (this.s.config.timerEnabled && this.deadline) {
        const total = this.s.config.turnSeconds * 1000;
        speed = Math.round((3 * Math.max(0, this.deadline - Date.now())) / total);
      }
      const streak = Math.min(me.streak, 3);
      const points = 11 - rank + speed + streak; // 1st place is worth 10, 10th place is worth 1
      a.found = { by: me.id, points, speed, streak };
      me.streak++;
      me.score += points;
      const note = m.exact ? "" : `, accepting “${guess}”`;
      this.addLog("correct", `${me.name} found #${rank} ${a.answer} (+${points})${note}.`);
      this.noteSignals(me, msg, true, rank);

      if (this.s.answers.every((x) => x.found)) {
        me.score += FINISH_BONUS;
        this.addLog("bonus", `${me.name} completed the board (+${FINISH_BONUS}).`);
        this.finish();
      } else {
        this.advanceTurn();
      }
    } else {
      if (this.s.wrongKeys.includes(key)) {
        return this.toast(ws, `“${guess}” has already been tried and isn't on the list. Try something else.`);
      }
      this.s.wrongKeys.push(key);
      this.s.wrong.push(guess);
      if (this.s.wrong.length > 40) {
        this.s.wrong.shift();
        this.s.wrongKeys.shift();
      }
      this.noteSignals(me, msg, false, 0);
      this.loseLife(me, `${me.name} guessed “${guess}”, which isn't on the list.`, "wrong");
      this.afterPenalty();
    }
    this.checkHints();
    this.persist();
    this.broadcast();
  }

  // ---------------------------------------------------------------- hints

  private onHintVote(ws: WebSocket, me: Player): void {
    if (this.s.ranked) return;
    if (this.s.phase !== "playing") return;
    if (me.eliminated) return this.toast(ws, "Players who are out can't vote.");
    if (this.s.hintsLeft <= 0) return this.toast(ws, "There are no hints left this round.");
    const i = this.s.hintVotes.indexOf(me.id);
    if (i >= 0) this.s.hintVotes.splice(i, 1);
    else this.s.hintVotes.push(me.id);
    this.checkHints();
    this.persist();
    this.broadcast();
  }

  /** Unlock a hint when every active, connected player has voted for one. */
  private checkHints(): void {
    if (this.s.phase !== "playing") return;
    const voters = this.hintVoters();
    this.s.hintVotes = this.s.hintVotes.filter((id) => voters.includes(id));
    if (!voters.length || this.s.hintsLeft <= 0) return;
    if (!voters.every((id) => this.s.hintVotes.includes(id))) return;

    const idx = this.s.answers.findIndex((a, i) => !a.found && !this.s.hints.some((h) => h.rank === i + 1));
    this.s.hintVotes = [];
    if (idx < 0) return;
    this.s.hints.push({ rank: idx + 1, text: makeHint(this.s.answers[idx].answer) });
    this.s.hintsLeft--;
    this.addLog("info", `Everyone voted for a hint. There's a clue for #${idx + 1} on the board.`);
  }

  // ---------------------------------------------------------------- source

  /** Opening the source mid-round is announced once per player, so nobody quietly looks things up. */
  private onSourceViewed(me: Player): void {
    if (this.s.ranked) return;
    if (this.s.phase !== "playing" || !this.s.source || this.s.sourceViewed.includes(me.id)) return;
    this.s.sourceViewed.push(me.id);
    this.addLog("info", `${me.name} opened the source for this list.`);
    this.persist();
    this.broadcast();
  }

  // ---------------------------------------------------------------- reports

  private async onReport(ws: WebSocket, me: Player, msg: any): Promise<void> {
    if (this.s.phase !== "playing" && this.s.phase !== "finished") return;
    const kind = msg.kind;
    if (kind !== "wrong" && kind !== "rank" && kind !== "alias") return;
    if ((this.s.reportsBy[me.id] ?? 0) >= MAX_REPORTS_PER_PLAYER) {
      return this.toast(ws, "You've used all your reports for this round. Thanks for the feedback.");
    }

    let rank = 0;
    let answer = "";
    let dedupe: string;
    if (kind === "alias") {
      answer = cleanText(msg.guess, 80);
      if (!answer || !this.s.wrong.includes(answer)) return;
      dedupe = `${me.id}|alias|${normalize(answer)}`;
    } else {
      rank = clampInt(msg.rank, 1, 10, 0);
      const a = this.s.answers[rank - 1];
      if (!a || (!a.found && this.s.phase !== "finished")) return;
      answer = a.answer;
      dedupe = `${me.id}|${kind}|${rank}`;
    }
    if (this.s.reported.includes(dedupe)) return this.toast(ws, "You've already reported that one.");
    this.s.reported.push(dedupe);
    this.s.reportsBy[me.id] = (this.s.reportsBy[me.id] ?? 0) + 1;

    if (kind !== "alias") {
      const a = this.s.answers[rank - 1];
      a.reports = (a.reports ?? 0) + 1;
      this.addLog("info", `${me.name} flagged #${rank} ${answer} as ${kind === "wrong" ? "incorrect" : "ranked wrongly"}.`);
    }

    let evicted = false;
    let saved = true;
    try {
      const res = await this.quota().report({
        listKey: this.s.listKey,
        topic: this.s.topic,
        difficulty: this.s.listDifficulty,
        kind,
        rank,
        answer,
        ip: this.ips.get(ws) ?? "unknown",
      });
      saved = res.ok;
      evicted = res.evicted;
    } catch (err) {
      console.error("report failed", err);
      saved = false;
    }
    this.toast(
      ws,
      !saved
        ? "Thanks. Your flag is shown to the room, but you've sent a lot of reports today so it wasn't saved."
        : evicted
          ? "Thanks. That list has been retired so nobody gets it again."
          : "Thanks, your report has been saved.",
    );
    this.persist();
    this.broadcast();
  }

  // ---------------------------------------------------------------- rematch, disconnects

  private onRematch(me: Player): void {
    if (this.s.ranked) return;
    if (this.s.phase !== "finished" || this.hostId() !== me.id) return;
    this.clearTimer();
    this.deadline = null;
    this.s.phase = "lobby";
    this.s.topic = "";
    this.s.basis = "";
    this.s.source = "";
    this.s.listKey = "";
    this.s.listDifficulty = null;
    this.s.answers = [];
    this.s.players = this.s.players.filter((p) => this.isConnected(p.id));
    this.resetRound();
    this.persist();
    this.broadcast();
  }

  private onClose(ws: WebSocket): void {
    const pid = this.conns.get(ws);
    this.conns.delete(ws);
    if (!pid || this.isConnected(pid)) return;

    if (this.s.ranked) {
      // A dropped connection gets a minute to come back before it counts as a forfeit.
      if (this.s.phase === "playing" && !this.s.ranked.result) {
        const t = setTimeout(() => {
          this.forfeitTimers.delete(pid);
          if (!this.isConnected(pid)) this.forfeit(pid, "disconnected");
        }, Math.max(1, num(this.env.RANKED_FORFEIT_SECONDS, 60)) * 1000);
        this.forfeitTimers.set(pid, t);
      }
      this.ensureTimer();
      this.broadcast();
      return;
    }

    if (this.s.phase === "lobby") {
      const t = setTimeout(() => {
        this.lobbyTimers.delete(pid);
        if (this.s.phase !== "lobby" || this.isConnected(pid)) return;
        this.s.players = this.s.players.filter((p) => p.id !== pid);
        if (this.s.hostId === pid) this.s.hostId = this.s.players[0]?.id ?? null;
        this.persist();
        this.broadcast();
      }, LOBBY_REMOVE_MS);
      this.lobbyTimers.set(pid, t);
    } else {
      this.ensureTimer();
      this.checkHints();
    }
    this.broadcast();
  }

  // ---------------------------------------------------------------- turns, timers, scoring

  private currentPlayer(): Player | undefined {
    const p = this.s.players[this.s.turnIdx];
    return p && !p.eliminated ? p : undefined;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Begin a fresh turn clock for the current player (or pause if nobody is around). */
  private startTurn(): void {
    this.clearTimer();
    this.deadline = null;
    if (this.s.phase !== "playing") return;
    const cur = this.currentPlayer();
    if (!cur) return;
    const alive = this.s.players.filter((p) => !p.eliminated);
    if (!alive.some((p) => this.isConnected(p.id))) return; // paused until someone returns

    this.s.turnStartedAt = Date.now();
    let ms: number | null = null;
    if (this.s.config.timerEnabled) ms = this.s.config.turnSeconds * 1000;
    else if (!this.isConnected(cur.id)) ms = AWAY_GRACE_MS;
    if (ms === null) return;

    this.deadline = Date.now() + ms;
    const token = ++this.turnToken;
    this.timer = setTimeout(() => this.onTimeout(token), ms);
  }

  /** Called when connections change, so a turn never stalls on an absent player. */
  private ensureTimer(): void {
    if (this.s.phase !== "playing") return;
    const cur = this.currentPlayer();
    if (!cur) return;
    const alive = this.s.players.filter((p) => !p.eliminated);
    if (!alive.some((p) => this.isConnected(p.id))) {
      this.clearTimer();
      this.deadline = null;
      return;
    }
    if (this.s.config.timerEnabled) {
      if (!this.timer) this.startTurn();
    } else if (!this.isConnected(cur.id)) {
      if (!this.timer) this.startTurn();
    } else if (this.timer) {
      this.clearTimer();
      this.deadline = null;
    }
  }

  private onTimeout(token: number): void {
    if (token !== this.turnToken || this.s.phase !== "playing") return;
    this.timer = undefined;
    this.deadline = null;
    const cur = this.currentPlayer();
    if (!cur) return;
    if (!this.isConnected(cur.id)) {
      this.addLog("info", `${cur.name} is away, so their turn was skipped.`);
      this.advanceTurn();
    } else {
      this.loseLife(cur, `${cur.name} ran out of time.`, "timeout");
      this.afterPenalty();
    }
    this.checkHints();
    this.persist();
    this.broadcast();
  }

  private loseLife(p: Player, text: string, kind: "wrong" | "timeout"): void {
    p.lives = Math.max(0, p.lives - 1);
    p.streak = 0;
    if (p.lives === 0) p.eliminated = true;
    const tail = p.eliminated ? ` ${p.name} is out!` : ` ${p.lives} ${p.lives === 1 ? "life" : "lives"} left.`;
    this.addLog(kind, text + tail);
  }

  private afterPenalty(): void {
    if (this.s.players.every((p) => p.eliminated)) this.finish();
    else if (this.rankedDecided()) this.finish();
    else this.advanceTurn();
  }

  /** In a ranked match, once one player is out and the other is already ahead, nothing can change the result. */
  private rankedDecided(): boolean {
    if (!this.s.ranked || this.s.players.length !== 2) return false;
    const [a, b] = this.s.players;
    if (a.eliminated === b.eliminated) return false;
    const survivor = a.eliminated ? b : a;
    const gone = a.eliminated ? a : b;
    return survivor.score > gone.score;
  }

  private advanceTurn(): void {
    const n = this.s.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.s.turnIdx + i) % n;
      if (!this.s.players[idx].eliminated) {
        this.s.turnIdx = idx;
        break;
      }
    }
    this.startTurn();
  }

  private finish(): void {
    this.clearTimer();
    this.deadline = null;
    this.s.phase = "finished";
    this.s.hintVotes = [];
    for (const p of this.s.players) {
      if (!p.eliminated && p.lives > 0) {
        const bonus = p.lives * LIFE_BONUS;
        p.score += bonus;
        this.addLog("bonus", `${p.name} kept ${p.lives} ${p.lives === 1 ? "life" : "lives"} (+${bonus}).`);
      }
    }
    if (this.s.ranked && this.s.players.length === 2) {
      const [a, b] = this.s.players;
      this.endRanked(a.score > b.score ? "a" : b.score > a.score ? "b" : "draw", "completed");
    }
  }

  // ---------------------------------------------------------------- ranked matches

  private onRankedJoin(ws: WebSocket): void {
    this.touch();
    const r = this.s.ranked!;
    const acc = this.accts.get(ws);
    const p = acc ? this.s.players.find((pl) => pl.id === acc.id) : undefined;
    if (!acc || !p) {
      this.toast(ws, "This ranked match isn't yours.", "error");
      this.conns.delete(ws);
      try {
        ws.close(4403, "not in this match");
      } catch {
        /* ignore */
      }
      return;
    }
    for (const [other, id] of this.conns) {
      if (id === p.id && other !== ws) {
        this.conns.delete(other);
        try {
          other.close(1000, "replaced");
        } catch {
          /* ignore */
        }
      }
    }
    this.conns.set(ws, p.id);
    this.send(ws, { t: "you", id: p.id });
    const t = this.forfeitTimers.get(p.id);
    if (t) {
      clearTimeout(t);
      this.forfeitTimers.delete(p.id);
    }
    this.armIdleAlarm();
    if (!r.result) {
      this.checkJoinDeadline();
      if (this.s.phase === "lobby" && this.s.players.every((pl) => this.isConnected(pl.id))) this.startRanked();
      else this.ensureTimer();
    }
    this.persist();
    this.broadcast();
  }

  private startRanked(): void {
    if (this.s.phase !== "lobby" || !this.s.ranked || this.s.ranked.result) return;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.resetRound();
    this.s.turnIdx = Math.floor(Math.random() * 2);
    this.s.phase = "playing";
    this.addLog("info", `Ranked match. ${this.s.players[this.s.turnIdx].name} goes first.`);
    this.startTurn();
  }

  /** If the opponent never turned up, cancel the match without touching anyone's rating. */
  private checkJoinDeadline(): void {
    const r = this.s.ranked;
    if (!r || r.result || this.s.phase !== "lobby") return;
    if (Date.now() < r.joinBy) return;
    if (this.s.players.every((p) => this.isConnected(p.id))) return;
    this.endRanked("abort", "an opponent never connected");
  }

  private endRanked(outcome: "a" | "b" | "draw" | "abort", reason: string): void {
    const r = this.s.ranked;
    if (!r || r.result) return;
    this.clearTimer();
    this.deadline = null;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    for (const t of this.forfeitTimers.values()) clearTimeout(t);
    this.forfeitTimers.clear();
    this.s.phase = "finished";
    r.result = { outcome, reason, aDelta: 0, bDelta: 0, aRating: r.players[0].rating, bRating: r.players[1].rating, pending: true };
    this.addLog("info", outcome === "abort" ? "Match cancelled: no rating change." : `Match over: ${reason}.`);
    this.persist();
    this.broadcast();
    void this.reportRanked();
  }

  /** Tells the rating service how it ended. Retried later if that fails. */
  private async reportRanked(): Promise<void> {
    const r = this.s.ranked;
    if (!r?.result || r.reported) return;
    const [a, b] = r.players;
    try {
      const arena = this.env.ARENA.get(this.env.ARENA.idFromName("arena")) as unknown as { recordMatch(id: string, o: object): Promise<any> };
      const res = await arena.recordMatch(r.matchId, {
        winner: r.result.outcome,
        reason: r.result.reason,
        aRisk: this.s.risk[a.id]?.w ?? 0,
        bRisk: this.s.risk[b.id]?.w ?? 0,
        flags: { a: this.s.risk[a.id]?.flags ?? [], b: this.s.risk[b.id]?.flags ?? [] },
      });
      if (res?.ok) {
        r.result = { ...r.result, aDelta: res.aDelta ?? 0, bDelta: res.bDelta ?? 0, aRating: res.aRating ?? a.rating, bRating: res.bRating ?? b.rating, pending: false };
        r.reported = true;
      }
    } catch (err) {
      console.error("ranked report failed:", err);
    }
    this.persist();
    this.broadcast();
    if (!r.reported) void this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private forfeit(pid: string, reason: string): void {
    const r = this.s.ranked;
    if (!r || r.result || (this.s.phase !== "playing" && this.s.phase !== "lobby")) return;
    const who = this.s.players.find((p) => p.id === pid);
    if (!who) return;
    this.addLog("info", `${who.name} ${reason === "resigned" ? "resigned" : "left the match"}.`);
    this.endRanked(pid === r.players[0].id ? "b" : "a", reason);
  }

  /** Quiet fair-play signals for ranked answers. Stored for review, never shown to players. */
  private noteSignals(me: Player, msg: any, correct: boolean, rank: number): void {
    if (!this.s.ranked) return;
    const guessLen = typeof msg.text === "string" ? msg.text.length : 0;
    const elapsed = Math.max(0, Date.now() - this.s.turnStartedAt);
    const a = assessGuess(cleanSignals(msg.sig, guessLen), { correct, rank, elapsedMs: elapsed });
    const cur = this.s.risk[me.id] ?? { w: 0, flags: [] };
    cur.w += a.weight;
    for (const f of a.flags) if (!cur.flags.includes(f)) cur.flags.push(f);
    this.s.risk[me.id] = cur;
  }
}
