import { DurableObject } from "cloudflare:workers";
import { AiError, generateTopTen } from "./ai";
import { matchGuess, normalize, type Answer } from "./match";
import type { Env } from "./types";

type Phase = "lobby" | "generating" | "playing" | "finished";

interface Config {
  lives: number;
  timerEnabled: boolean;
  turnSeconds: number;
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

interface Saved {
  initialized: boolean;
  phase: Phase;
  config: Config;
  topic: string;
  basis: string;
  answers: Answer[];
  players: Player[];
  hostId: string | null;
  turnIdx: number;
  turnStartedAt: number;
  wrong: string[];
  wrongKeys: string[];
  log: LogEntry[];
  logSeq: number;
  genCount: number;
  lastActive: number;
}

const MAX_PLAYERS = 8;
const MAX_GENERATIONS = 10; // topic generations per room (protects your AI bill)
const AWAY_GRACE_MS = 20_000; // how long we wait for a disconnected player before skipping them
const LOBBY_REMOVE_MS = 30_000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const FINISH_BONUS = 5;
const LIFE_BONUS = 2;

function defaultState(): Saved {
  return {
    initialized: false,
    phase: "lobby",
    config: { lives: 3, timerEnabled: true, turnSeconds: 20 },
    topic: "",
    basis: "",
    answers: [],
    players: [],
    hostId: null,
    turnIdx: 0,
    turnStartedAt: 0,
    wrong: [],
    wrongKeys: [],
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

export class Room extends DurableObject<Env> {
  private s: Saved = defaultState();
  private conns = new Map<WebSocket, string | null>();
  private timer?: ReturnType<typeof setTimeout>;
  private turnToken = 0;
  private deadline: number | null = null;
  private lobbyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rate = new WeakMap<WebSocket, { t: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Saved>("state");
      if (saved) {
        this.s = { ...defaultState(), ...saved };
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

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.conns.set(server, null);
    server.addEventListener("message", (ev) => void this.onMessage(server, ev.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    if (this.conns.size === 0 && Date.now() - this.s.lastActive > ROOM_TTL_MS) {
      this.clearTimer();
      await this.ctx.storage.deleteAll();
      this.s = defaultState();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS / 6);
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
      hostId: this.hostId(),
      turnPid: cur?.id ?? null,
      deadline: this.deadline,
      turnMs: this.deadline ? this.deadline - s.turnStartedAt : 0,
      awayGrace: !!this.deadline && !s.config.timerEnabled,
      serverNow: Date.now(),
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        score: p.score,
        streak: p.streak,
        eliminated: p.eliminated,
        connected: this.isConnected(p.id),
      })),
      // Unfound answers stay on the server until the game ends.
      answers: s.answers.map((a, i) =>
        a.found || finished
          ? { rank: i + 1, answer: a.answer, detail: a.detail ?? "", found: a.found ?? null }
          : { rank: i + 1 },
      ),
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
    if (msg.t === "ping") return this.send(ws, { t: "pong" });
    if (!this.rateOk(ws)) return;
    if (msg.t === "join") return this.onJoin(ws, msg);

    const pid = this.conns.get(ws);
    const me = pid ? this.s.players.find((p) => p.id === pid) : undefined;
    if (!me) return;

    switch (msg.t) {
      case "config":
        return this.onConfig(me, msg);
      case "start":
        return this.onStart(ws, me, msg);
      case "guess":
        return this.onGuess(ws, me, msg);
      case "rematch":
        return this.onRematch(me);
    }
  }

  private onJoin(ws: WebSocket, msg: any): void {
    const pid = typeof msg.pid === "string" && /^[A-Za-z0-9-]{8,48}$/.test(msg.pid) ? msg.pid : null;
    if (!pid) return;
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
    this.ensureTimer();
    this.persist();
    this.broadcast();
  }

  private onConfig(me: Player, msg: any): void {
    if (this.s.phase !== "lobby" || this.hostId() !== me.id) return;
    const c = this.s.config;
    this.s.config = {
      lives: clampInt(msg.lives, 1, 10, c.lives),
      timerEnabled: typeof msg.timerEnabled === "boolean" ? msg.timerEnabled : c.timerEnabled,
      turnSeconds: clampInt(msg.turnSeconds, 5, 120, c.turnSeconds),
    };
    for (const p of this.s.players) p.lives = this.s.config.lives;
    this.persist();
    this.broadcast();
  }

  private async onStart(ws: WebSocket, me: Player, msg: any): Promise<void> {
    if (this.s.phase !== "lobby" || this.hostId() !== me.id) return;
    const topic = cleanText(msg.topic, 120);
    if (topic.length < 3) return this.toast(ws, "Enter a topic first (at least 3 characters).", "error");
    if (this.s.genCount >= MAX_GENERATIONS) {
      return this.toast(ws, "This room has used all its topic generations. Create a new room to keep playing.", "error");
    }

    // Anyone who dropped out of the lobby doesn't get a seat.
    this.s.players = this.s.players.filter((p) => this.isConnected(p.id));
    this.s.genCount++;
    this.s.phase = "generating";
    this.s.topic = topic;
    this.persist();
    this.broadcast();

    try {
      const result = await generateTopTen(this.env, topic);
      if (this.s.phase !== "generating") return;
      this.s.topic = result.title;
      this.s.basis = result.basis;
      this.s.answers = result.answers;
      this.s.wrong = [];
      this.s.wrongKeys = [];
      this.s.log = [];
      for (const p of this.s.players) {
        p.lives = this.s.config.lives;
        p.score = 0;
        p.streak = 0;
        p.eliminated = false;
      }
      this.s.turnIdx = Math.floor(Math.random() * this.s.players.length);
      this.s.phase = "playing";
      this.addLog("info", `${this.s.players[this.s.turnIdx].name} goes first.`);
      this.startTurn();
    } catch (err) {
      console.error("generation failed", err);
      this.s.phase = "lobby";
      this.s.topic = "";
      this.toastAll(err instanceof AiError ? err.userMessage : "Couldn't build that list. Try again.", "error");
    }
    this.persist();
    this.broadcast();
  }

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
      const points = rank + speed + streak;
      a.found = { by: me.id, points, speed, streak };
      me.streak++;
      me.score += points;
      this.addLog("correct", `${me.name} found #${rank} ${a.answer} (+${points}).`);

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
      this.loseLife(me, `${me.name} guessed “${guess}”, which isn't on the list.`, "wrong");
      this.afterPenalty();
    }
    this.persist();
    this.broadcast();
  }

  private onRematch(me: Player): void {
    if (this.s.phase !== "finished" || this.hostId() !== me.id) return;
    this.clearTimer();
    this.deadline = null;
    this.s.phase = "lobby";
    this.s.topic = "";
    this.s.basis = "";
    this.s.answers = [];
    this.s.wrong = [];
    this.s.wrongKeys = [];
    this.s.log = [];
    this.s.players = this.s.players.filter((p) => this.isConnected(p.id));
    for (const p of this.s.players) {
      p.lives = this.s.config.lives;
      p.score = 0;
      p.streak = 0;
      p.eliminated = false;
    }
    this.persist();
    this.broadcast();
  }

  private onClose(ws: WebSocket): void {
    const pid = this.conns.get(ws);
    this.conns.delete(ws);
    if (!pid || this.isConnected(pid)) return;

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
    else this.advanceTurn();
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
    for (const p of this.s.players) {
      if (!p.eliminated && p.lives > 0) {
        const bonus = p.lives * LIFE_BONUS;
        p.score += bonus;
        this.addLog("bonus", `${p.name} kept ${p.lives} ${p.lives === 1 ? "life" : "lives"} (+${bonus}).`);
      }
    }
  }
}
