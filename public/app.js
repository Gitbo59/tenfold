(() => {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hue = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  };
  const uuid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : "p" + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

  const EASY_TOPICS = [
    "Most populous countries", "Best-selling video game consoles of all time", "Highest-grossing films ever",
    "Most-streamed artists on Spotify", "Largest countries by area", "Most-visited tourist attractions",
    "Premier League all-time top scorers", "Most spoken languages", "Largest cities in Europe",
    "Bestselling book series", "Tallest buildings in the world", "Most-subscribed YouTube channels",
    "Most-visited countries", "Best-selling cars of all time", "Biggest tech companies by market value",
    "Most Grand Slam titles in men's tennis", "Most popular boys' names in the UK", "Biggest dog breeds",
    "Longest rivers in the world", "Largest planets and moons in the Solar System",
  ];
  const HARD_TOPICS = [
    "Most Formula 1 race wins by driver", "Largest lakes in Canada", "Highest peaks in the Alps",
    "Countries with the most time zones", "Most Olympic gold medals by a single athlete", "Longest bridges by main span",
    "Largest cities in Brazil", "Most Oscar wins by film", "Most-capped players in men's international football",
    "Largest national parks in the USA", "Deepest lakes in the world", "Most-translated authors in history",
    "Highest-grossing anime films", "Largest islands in the Mediterranean", "Longest-reigning monarchs in history",
    "Most prolific chess grandmasters by rating", "Largest airports by passenger traffic", "Tallest waterfalls in Europe",
  ];
  const pool = () => (state && state.config.difficulty === "hard" ? HARD_TOPICS : EASY_TOPICS);
  const pick = (n) => [...pool()].sort(() => Math.random() - 0.5).slice(0, n);

  // ------------------------------------------------------------------ state
  // In friends rooms this is a random per-tab id. In a ranked match the server tells us our account id.
  let pid = (() => {
    let v = sessionStorage.getItem("tf_pid");
    if (!v) sessionStorage.setItem("tf_pid", (v = uuid()));
    return v;
  })();

  let ws = null;
  let code = null;
  let state = null;
  let skew = 0;
  let retries = 0;
  let leaving = false;
  let pingTimer = null;
  let reconnectTimer = null;
  let joinSent = false;
  let lastTurnPid = null;
  let lastLogId = null;
  let configTimer = null;
  let selectedClassic = null;
  let chipsFor = null;
  let classicsKey = "";
  let budgetAt = 0;
  let showSource = false; // per game: opening it is announced to the room, so it is never remembered
  let reportCtx = null;
  const animated = new Set();
  const myReports = new Set();

  // Local edits shown immediately; the server's echo confirms them (or they expire).
  const pending = {};
  const pendingTimers = {};
  function setPending(key, val) {
    pending[key] = val;
    clearTimeout(pendingTimers[key]);
    pendingTimers[key] = setTimeout(() => { delete pending[key]; if (state) render(); }, 1500);
  }
  function effective(key, serverVal) {
    if (key in pending && pending[key] === serverVal) { delete pending[key]; clearTimeout(pendingTimers[key]); }
    return key in pending ? pending[key] : serverVal;
  }

  const screens = ["home", "connecting", "lobby", "generating", "game", "daily", "ranked"];
  function show(name) {
    for (const s of screens) $(`#screen-${s}`).hidden = s !== name;
    $("#btn-leave").hidden = name === "home" || name === "daily" || name === "ranked";
    // The For fun / Ranked switch shows on the main pages and hides while you're in a room.
    $("#mode-pill").hidden = !["home", "ranked", "daily"].includes(name);
    for (const a of $$("#mode-pill a")) {
      if (a.dataset.mode === (name === "home" ? "fun" : "ranked")) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (name === "home") window.dispatchEvent(new Event("tf:home"));
  }

  function toast(msg, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), kind === "error" ? 5500 : 3200);
  }

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const myName = () => ($("#name").value || localStorage.getItem("tf_name") || "").trim().slice(0, 16);

  // ------------------------------------------------------------------ home
  function buildSample() {
    const rows = ["India", "China", "United States", "Indonesia"];
    let html = "";
    for (let i = 1; i <= 10; i++) {
      const name = rows[i - 1];
      html += name
        ? `<li class="plate found" style="--d:${i - 1}"><span class="bulb">${i}</span><span class="plate-body"><span class="ans">${name}</span></span><span class="pts"></span></li>`
        : `<li class="plate hidden"><span class="bulb">${i}</span><span class="plate-body"></span><span class="pts"></span></li>`;
    }
    $("#sample-board").innerHTML = html;
  }

  function requireName() {
    const name = myName();
    if (!name) {
      toast("Enter your name first.", "error");
      $("#name").focus();
      return null;
    }
    localStorage.setItem("tf_name", name);
    return name;
  }

  async function createRoom() {
    if (!requireName()) return;
    $("#btn-create").disabled = true;
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't create a room.");
      enterRoom(data.code);
    } catch (err) {
      toast(err.message || "Couldn't create a room. Check your connection and try again.", "error");
    } finally {
      $("#btn-create").disabled = false;
    }
  }

  async function joinRoom() {
    if (!requireName()) return;
    const c = $("#code").value.trim().toUpperCase();
    if (c.length !== 5) return toast("Room codes have 5 characters.", "error");
    try {
      const res = await fetch(`/api/rooms/${c}`);
      if (!res.ok) return toast("No room with that code. Check the letters and try again.", "error");
    } catch {
      return toast("Couldn't reach the server. Check your connection.", "error");
    }
    enterRoom(c);
  }

  function enterRoom(c) {
    code = c;
    leaving = false;
    state = null;
    retries = 0;
    sessionStorage.setItem("tf_room", c);
    history.replaceState(null, "", `?room=${c}`);
    show("connecting");
    connect();
  }

  function leaveRoom(silent) {
    leaving = true;
    clearTimeout(reconnectTimer);
    stopPing();
    if (ws) {
      try { ws.close(1000, "leave"); } catch {}
    }
    ws = null; state = null; code = null; joinSent = false; lastTurnPid = null; lastLogId = null;
    selectedClassic = null; classicsKey = ""; chipsFor = null;
    animated.clear(); myReports.clear();
    sessionStorage.removeItem("tf_room");
    history.replaceState(null, "", "/");
    $("#conn").hidden = true;
    $("#report-modal").hidden = true;
    show("home");
    if (!silent) toast("You left the room.");
  }

  // ------------------------------------------------------------------ connection
  function connect() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws/${code}`);
    ws = sock;
    sock.onopen = () => {
      retries = 0;
      $("#conn").hidden = true;
      sock.send(JSON.stringify({ t: "join", pid, name: myName() || "Player" }));
      stopPing();
      pingTimer = setInterval(() => send({ t: "ping" }), 25000);
    };
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "state") onState(m);
      else if (m.t === "you") pid = m.id;
      else if (m.t === "toast") {
        if (m.kind === "error") budgetAt = 0;
        toast(m.msg, m.kind);
      }
    };
    sock.onclose = (ev) => {
      if (sock !== ws || leaving) return;
      stopPing();
      if (ev && ev.code === 4001) {
        // The room went quiet, so the server released the connection. Don't reconnect on our own.
        const c = code;
        leaveRoom(true);
        $("#code").value = c || "";
        toast("You were disconnected after a quiet spell. Join again to carry on.", "error");
        return;
      }
      $("#conn").hidden = false;
      scheduleReconnect();
    };
  }

  function stopPing() { clearInterval(pingTimer); pingTimer = null; }

  function scheduleReconnect() {
    retries++;
    const delay = Math.min(500 * 2 ** (retries - 1), 8000);
    reconnectTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/rooms/${code}`);
        if (res.status === 404) {
          toast("That room has closed.", "error");
          return leaveRoom(true);
        }
      } catch { /* offline: keep trying */ }
      if (!leaving) connect();
    }, delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && code && !leaving && (!ws || ws.readyState > 1)) {
      clearTimeout(reconnectTimer);
      connect();
    }
  });

  function onState(m) {
    state = m;
    skew = m.serverNow - Date.now();
    render();
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    const s = state;
    if (!s) return;
    const me = s.players.find((p) => p.id === pid);

    // Watchers rejoin automatically once the room is back in the lobby.
    if (s.phase === "lobby" && !s.ranked && !me && !joinSent) {
      joinSent = true;
      send({ t: "join", pid, name: myName() || "Player" });
    }
    if (me || s.phase !== "lobby") joinSent = false;

    if (s.phase === "lobby" || s.phase === "generating") showSource = false;
    if (s.phase === "lobby" && !s.ranked) { show("lobby"); animated.clear(); lastLogId = null; myReports.clear(); renderLobby(s, me); }
    else if (s.phase === "generating" || (s.phase === "lobby" && s.ranked)) {
      show("generating");
      const opp = s.ranked && s.ranked.players.find((p) => p.id !== pid);
      $("#gen-title").textContent = s.ranked ? "Opponent found" : "Building the top ten";
      $("#gen-topic").textContent = s.ranked ? `Waiting for ${opp ? opp.name : "your opponent"} to connect…` : s.topic;
    }
    else { show("game"); renderGame(s, me); }
  }

  function avatar(p) {
    return `<span class="avatar" style="--h:${hue(p.name)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
  }

  function renderChips() {
    chipsFor = state ? state.config.difficulty : "easy";
    $("#topic-chips").innerHTML = pick(4).map((t) => `<button class="chip" type="button">${esc(t)}</button>`).join("");
  }

  function renderClassics(list) {
    const key = JSON.stringify(list || []);
    if (key === classicsKey) return;
    classicsKey = key;
    $("#classics").innerHTML = (list || [])
      .map((c) => `<button class="chip" type="button" data-id="${esc(c.id)}" data-title="${esc(c.title)}" aria-pressed="false">${esc(c.title)}</button>`)
      .join("");
    $("#classics-wrap").hidden = !(list && list.length);
  }

  async function refreshBudget() {
    if (Date.now() - budgetAt < 20000) return;
    budgetAt = Date.now();
    try {
      const res = await fetch("/api/budget");
      const b = await res.json();
      $("#budget-note").textContent =
        b.remaining > 0
          ? `Free AI lists left today: ${b.remaining} of ${b.cap}. Lists someone has already played, and the built-in lists, don't use any.`
          : "Today's free AI allowance is used up. Built-in lists and lists that have been played before still work.";
    } catch { /* leave the note as it was */ }
  }

  function renderLobby(s, me) {
    const isHost = s.hostId === pid;
    $("#room-code").innerHTML = [...(code || "")].map((c) => `<span>${esc(c)}</span>`).join("");
    $("#player-count").textContent = `${s.players.length} of 8`;
    $("#lobby-players").innerHTML = s.players
      .map(
        (p) =>
          `<li>${avatar(p)}<span class="pname">${esc(p.name)}${p.id === pid ? " (you)" : ""}${p.id === s.hostId ? '<span class="tag">Host</span>' : ""}${p.connected ? "" : '<span class="tag tag-away">Away</span>'}</span></li>`,
      )
      .join("");

    // Settings: show local edits straight away and keep the controls in sync with the server.
    const c = s.config;
    const lives = effective("lives", c.lives);
    const timerEnabled = effective("timer", c.timerEnabled);
    const seconds = effective("seconds", c.turnSeconds);
    const difficulty = effective("difficulty", c.difficulty);
    const hints = effective("hints", c.hints);

    $("#lives-val").textContent = lives;
    $("#lives-dec").disabled = !isHost || lives <= 1;
    $("#lives-inc").disabled = !isHost || lives >= 10;

    const timerOn = $("#timer-on");
    timerOn.checked = timerEnabled;
    timerOn.disabled = !isHost;
    const range = $("#timer-sec");
    if (document.activeElement !== range) range.value = seconds;
    range.disabled = !isHost || !timerEnabled;
    $("#timer-val").textContent = `${seconds} seconds`;
    $("#range-row").dataset.off = String(!timerEnabled);

    for (const b of $$(".seg")) {
      b.setAttribute("aria-checked", String(b.dataset.diff === difficulty));
      b.disabled = !isHost;
    }
    $("#hints-val").textContent = hints;
    $("#hints-dec").disabled = !isHost || hints <= 0;
    $("#hints-inc").disabled = !isHost || hints >= 5;
    $("#settings-note").hidden = isHost;

    // Topic: host only.
    $("#topic").disabled = !isHost;
    $("#topic").closest(".field").hidden = !isHost;
    $(".topic-tools").hidden = !isHost;
    $("#classics-wrap").hidden = !isHost || !(s.classics && s.classics.length);
    $("#budget-note").hidden = !isHost;
    $("#btn-start").hidden = !isHost;
    $("#wait-note").hidden = isHost;
    if (chipsFor !== difficulty) {
      // chips follow the selected difficulty
      const prev = state.config.difficulty;
      state.config.difficulty = difficulty;
      renderChips();
      state.config.difficulty = prev;
      chipsFor = difficulty;
    }
    renderClassics(s.classics);
    if (isHost) refreshBudget();
  }

  function renderSource(s, finished) {
    const btn = $("#btn-source");
    const line = $("#source-line");
    const visible = !!s.source && (finished || showSource);
    btn.hidden = finished || !s.source || !!s.ranked;
    btn.textContent = showSource ? "Hide source" : "Show source";
    btn.setAttribute("aria-expanded", String(visible));
    line.hidden = !visible;
    if (visible) {
      const q = encodeURIComponent(`${s.topic} ${s.source}`);
      const link = `<a href="https://duckduckgo.com/?q=${q}" target="_blank" rel="noopener noreferrer">Search to verify</a>`;
      line.innerHTML = s.classic
        ? `Source: ${esc(s.source)}. ${link}`
        : `<span class="tentative">AI-suggested source, not verified:</span> ${esc(s.source)}. ${link}`;
    }
  }

  function renderHints(s, me) {
    const bar = $("#hint-bar");
    const on = s.phase === "playing" && s.config.hints > 0 && me && !me.eliminated;
    bar.hidden = !on;
    if (!on) return;
    const voted = s.hintVotes.includes(pid);
    const btn = $("#btn-hint");
    btn.disabled = s.hintsLeft <= 0;
    btn.setAttribute("aria-pressed", String(voted));
    const tally = `${s.hintVotes.length}/${s.hintVoters}`;
    btn.textContent = s.hintsLeft <= 0 ? "No hints left" : voted ? `Voted for a hint (${tally})` : `Vote for a hint (${tally})`;
    $("#hint-note").textContent =
      s.hintsLeft > 0
        ? `${s.hintsLeft} ${s.hintsLeft === 1 ? "hint" : "hints"} left. One unlocks when everyone still playing votes.`
        : "";
  }

  function renderGame(s, me) {
    const finished = s.phase === "finished";
    const isMyTurn = s.phase === "playing" && s.turnPid === pid;
    const cur = s.players.find((p) => p.id === s.turnPid);

    $("#btn-leave").hidden = !!(s.ranked && s.phase === "playing");
    $("#btn-resign").hidden = !(s.ranked && s.phase === "playing" && me);
    $("#g-title").textContent = s.topic;
    $("#g-basis").textContent = s.listDifficulty ? `${s.basis} (${s.listDifficulty} list)` : s.basis;
    renderSource(s, finished);
    renderHints(s, me);

    // Turn banner
    const turn = $("#turn-text");
    turn.classList.toggle("mine", isMyTurn);
    if (finished) turn.textContent = "Game over";
    else if (isMyTurn) turn.textContent = "Your turn";
    else if (cur && !cur.connected) turn.textContent = `${cur.name} is away`;
    else if (cur) turn.textContent = `${cur.name}'s turn`;
    else turn.textContent = "";
    if (s.phase === "playing" && !s.deadline && s.config.timerEnabled && cur) turn.textContent += " (paused until players reconnect)";

    if (isMyTurn && lastTurnPid !== pid) {
      navigator.vibrate?.(60);
      $("#guess").focus({ preventScroll: true });
      resetSignals();
    }
    lastTurnPid = s.turnPid;

    // Board
    $("#board").innerHTML = s.answers
      .map((a) => {
        const revealed = a.answer !== undefined;
        const f = a.found;
        const by = f ? s.players.find((p) => p.id === f.by) : null;
        let cls = "plate " + (f ? "found" : revealed ? "missed" : "hidden");
        if (f && !animated.has(a.rank)) { animated.add(a.rank); cls += " just"; }
        const bonus = f && (f.speed || f.streak) ? [f.speed ? `quick +${f.speed}` : "", f.streak ? `streak +${f.streak}` : ""].filter(Boolean).join(", ") : "";
        let sub = "";
        let hint = "";
        if (revealed) {
          const mine = myReports.has(`r${a.rank}`);
          const flagged = a.reports ? `<span class="reported">Flagged x${a.reports}</span>` : "";
          const flag = `<button type="button" class="flag" data-rank="${a.rank}" data-answer="${esc(a.answer)}"${mine ? " disabled" : ""}>${mine ? "Reported" : "Report"}</button>`;
          const lead = f ? `Found by ${esc(by ? by.name : "someone")}` : "Missed";
          sub = `<span class="sub">${lead}${a.detail ? `, ${esc(a.detail)}` : ""}${flagged}${flag}</span>`;
        } else if (a.hint) {
          hint = `<span class="plate-hint">Hint: ${esc(a.hint)}</span>`;
        }
        return `<li class="${cls}"><span class="bulb">${a.rank}</span><span class="plate-body">${revealed ? `<span class="ans">${esc(a.answer)}</span>${sub}` : hint}</span><span class="pts">${f ? `+${f.points}${bonus ? `<small>${esc(bonus)}</small>` : ""}` : ""}</span></li>`;
      })
      .join("");

    $("#wrong-wrap").hidden = !s.wrong.length;
    $("#wrong").innerHTML = s.wrong
      .map((w) => {
        const mine = myReports.has(`a${w.toLowerCase()}`);
        return `<li><button type="button" class="chip-x" data-guess="${esc(w)}"${mine ? " disabled" : ""} title="Tap to report a rejected guess">${esc(w)}</button></li>`;
      })
      .join("");

    // Players
    const hearts = (p) => {
      if (s.config.lives > 5) return `<span class="hearts"><svg class="heart"><use href="#i-heart"/></svg><span class="n">${p.lives}</span></span>`;
      let h = "";
      for (let i = 0; i < s.config.lives; i++) h += `<svg class="heart ${i < p.lives ? "" : "lost"}"><use href="#i-heart"/></svg>`;
      return `<span class="hearts" aria-label="${p.lives} lives">${h}</span>`;
    };
    $("#players").innerHTML = s.players
      .map((p) => {
        const cls = ["player", p.id === s.turnPid ? "turn" : "", p.eliminated ? "out" : ""].join(" ");
        const status = p.eliminated ? "Out" : !p.connected ? "Away" : p.streak >= 2 ? `${p.streak} in a row` : "";
        return `<li class="${cls}">${avatar(p)}<span class="pname">${esc(p.name)}${p.id === pid ? " (you)" : ""}${p.rating ? `<span class="rating">${p.rating}</span>` : ""}</span><span class="pscore">${p.score}</span><span class="pmeta">${hearts(p)}${status ? `<span>${status}</span>` : ""}</span></li>`;
      })
      .join("");

    // Feed + shake on new misses
    const log = s.log;
    const newest = log.length ? log[log.length - 1].id : 0;
    if (lastLogId !== null && log.some((l) => l.id > lastLogId && (l.kind === "wrong" || l.kind === "timeout"))) {
      const w = $("#board-wrap");
      w.classList.remove("shake");
      void w.offsetWidth;
      w.classList.add("shake");
    }
    lastLogId = newest;
    $("#feed").innerHTML = [...log].reverse().slice(0, 8).map((l) => `<li class="${l.kind}">${esc(l.text)}</li>`).join("");

    // Guess bar
    const input = $("#guess");
    const canGuess = isMyTurn;
    input.disabled = !canGuess;
    $("#btn-guess").disabled = !canGuess;
    $("#guess-form").dataset.state = canGuess ? "mine" : "wait";
    input.placeholder = finished ? "Round finished" : !me ? "You're watching this round" : canGuess ? "Type an answer" : cur ? `Waiting for ${cur.name}…` : "Waiting…";
    $("#guess-form").hidden = finished;

    // Results
    $("#results").hidden = !finished;
    if (finished) {
      const sorted = [...s.players].sort((a, b) => b.score - a.score);
      const winners = s.players.filter((p) => s.winners.includes(p.id));
      let title;
      if (!winners.length) title = "Nobody scored this round";
      else if (s.players.length === 1) title = `You scored ${winners[0].score} points`;
      else if (winners.length === 1) title = `${winners[0].name} wins with ${winners[0].score} points`;
      else title = `${winners.map((w) => w.name).join(" and ")} tie on ${winners[0].score} points`;
      let ratingLine = "";
      if (s.ranked) {
        const r = s.ranked.result;
        const idx = s.ranked.players.findIndex((p) => p.id === pid);
        if (r && r.outcome === "abort") { title = "Match cancelled"; ratingLine = "No rating change."; }
        else if (r) {
          const won = (r.outcome === "a" && idx === 0) || (r.outcome === "b" && idx === 1);
          title = r.outcome === "draw" ? "Draw" : won ? "You won" : "You lost";
          if (r.pending) ratingLine = "Updating your rating…";
          else if (idx >= 0) {
            const delta = idx === 0 ? r.aDelta : r.bDelta;
            const after = idx === 0 ? r.aRating : r.bRating;
            ratingLine = `Rating ${after - delta} → ${after} (${delta >= 0 ? "+" : ""}${delta})`;
          }
        }
      }
      $("#res-title").textContent = title;
      const rl = $("#res-rating");
      rl.hidden = !ratingLine;
      rl.textContent = ratingLine;
      let place = 0, prev = null;
      $("#res-list").innerHTML = sorted
        .map((p, i) => {
          if (p.score !== prev) place = i + 1;
          prev = p.score;
          return `<li class="${s.winners.includes(p.id) ? "winner" : ""}"><span class="place">${place}</span>${avatar(p)}<span class="sname">${esc(p.name)}${p.id === pid ? " (you)" : ""}</span><span class="sscore">${p.score}</span></li>`;
        })
        .join("");
      const isHost = s.hostId === pid;
      $("#btn-rematch").hidden = !!s.ranked || !isHost;
      $("#res-wait").hidden = !!s.ranked || isHost || !me;
      $("#btn-ranked-back").hidden = !s.ranked;
    }
    tick();
  }

  // ------------------------------------------------------------------ clock
  function tick() {
    const s = state;
    const bar = $("#turnbar");
    if (!s || s.phase === "lobby" || s.phase === "generating") return;
    const fill = $("#clock-fill");
    const num = $("#clock-num");
    if (s.phase === "playing" && s.deadline) {
      const left = Math.max(0, s.deadline - (Date.now() + skew));
      const pct = s.turnMs > 0 ? Math.min(1, left / s.turnMs) : 0;
      fill.style.width = `${pct * 100}%`;
      fill.classList.toggle("low", pct < 0.25);
      num.textContent = Math.ceil(left / 1000);
      bar.classList.remove("no-clock");
      if (s.awayGrace) num.title = "Skipping this player if they don't return";
    } else {
      fill.style.width = "100%";
      fill.classList.remove("low");
      num.textContent = s.phase === "playing" && !s.config.timerEnabled ? "No limit" : "";
      bar.classList.add("no-clock");
    }
  }
  setInterval(tick, 100);

  // ------------------------------------------------------------------ reports
  function openReport(ctx) {
    reportCtx = ctx;
    if (ctx.kind === "alias") {
      $("#report-title").textContent = "Report a rejected guess";
      $("#report-text").textContent = `You're saying “${ctx.guess}” should have counted as a correct answer.`;
      $("#report-options").innerHTML = "";
    } else {
      $("#report-title").textContent = `Report #${ctx.rank} ${ctx.answer}`;
      $("#report-text").textContent = "What's wrong with this answer?";
      $("#report-options").innerHTML =
        '<label><input type="radio" name="rkind" value="wrong" checked> This answer isn\'t correct</label>' +
        '<label><input type="radio" name="rkind" value="rank"> It\'s in the wrong place in the ranking</label>';
    }
    $("#report-modal").hidden = false;
    $("#report-send").focus();
  }
  function closeReport() {
    $("#report-modal").hidden = true;
    reportCtx = null;
  }
  $("#board").addEventListener("click", (e) => {
    const b = e.target.closest(".flag");
    if (b && !b.disabled) openReport({ kind: "rank", rank: Number(b.dataset.rank), answer: b.dataset.answer });
  });
  $("#wrong").addEventListener("click", (e) => {
    const b = e.target.closest(".chip-x");
    if (b && !b.disabled) openReport({ kind: "alias", guess: b.dataset.guess });
  });
  $("#report-cancel").addEventListener("click", closeReport);
  $("#report-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeReport(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#report-modal").hidden) closeReport(); });
  $("#report-send").addEventListener("click", () => {
    if (!reportCtx) return;
    if (reportCtx.kind === "alias") {
      send({ t: "report", kind: "alias", guess: reportCtx.guess });
      myReports.add(`a${reportCtx.guess.toLowerCase()}`);
    } else {
      const kind = ($('input[name="rkind"]:checked') || {}).value || "wrong";
      send({ t: "report", kind, rank: reportCtx.rank });
      myReports.add(`r${reportCtx.rank}`);
    }
    closeReport();
    if (state) render();
  });

  // ------------------------------------------------------------------ events
  $("#home-form").addEventListener("submit", (e) => { e.preventDefault(); $("#code").value.trim() ? joinRoom() : createRoom(); });
  $("#btn-create").addEventListener("click", createRoom);
  $("#code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  $("#btn-leave").addEventListener("click", () => leaveRoom(false));
  $("#brand").addEventListener("click", (e) => { if (code) { e.preventDefault(); leaveRoom(false); } });

  // Only the changed field is sent, so quick successive changes never overwrite each other.
  const pushConfig = (patch) => {
    if (state) send({ t: "config", ...patch });
  };
  function stepSetting(key, field, delta, min, max) {
    if (!state) return;
    const base = key in pending ? pending[key] : state.config[field];
    const next = Math.min(max, Math.max(min, base + delta));
    if (next === base) return;
    setPending(key, next);
    render();
    pushConfig({ [field]: next });
  }
  $("#lives-dec").addEventListener("click", () => stepSetting("lives", "lives", -1, 1, 10));
  $("#lives-inc").addEventListener("click", () => stepSetting("lives", "lives", 1, 1, 10));
  $("#hints-dec").addEventListener("click", () => stepSetting("hints", "hints", -1, 0, 5));
  $("#hints-inc").addEventListener("click", () => stepSetting("hints", "hints", 1, 0, 5));
  $("#timer-on").addEventListener("change", (e) => {
    setPending("timer", e.target.checked);
    render();
    pushConfig({ timerEnabled: e.target.checked });
  });
  $("#timer-sec").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    setPending("seconds", value);
    $("#timer-val").textContent = `${value} seconds`;
    clearTimeout(configTimer);
    configTimer = setTimeout(() => pushConfig({ turnSeconds: value }), 150);
  });
  for (const b of $$(".seg")) {
    b.addEventListener("click", () => {
      if (b.disabled) return;
      setPending("difficulty", b.dataset.diff);
      render();
      pushConfig({ difficulty: b.dataset.diff });
    });
  }

  $("#topic-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    selectedClassic = null;
    for (const c of $$("#classics .chip")) c.setAttribute("aria-pressed", "false");
    $("#topic").value = b.textContent;
    $("#topic").focus();
  });
  $("#classics").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    selectedClassic = b.dataset.id;
    for (const c of $$("#classics .chip")) c.setAttribute("aria-pressed", String(c === b));
    $("#topic").value = b.dataset.title;
  });
  $("#topic").addEventListener("input", () => {
    const chosen = selectedClassic && $(`#classics .chip[data-id="${selectedClassic}"]`);
    if (!chosen || chosen.dataset.title !== $("#topic").value.trim()) {
      selectedClassic = null;
      for (const c of $$("#classics .chip")) c.setAttribute("aria-pressed", "false");
    }
  });
  $("#btn-surprise").addEventListener("click", () => {
    selectedClassic = null;
    for (const c of $$("#classics .chip")) c.setAttribute("aria-pressed", "false");
    $("#topic").value = pick(1)[0];
    renderChips();
  });
  $("#btn-start").addEventListener("click", () => {
    const topic = $("#topic").value.trim();
    if (selectedClassic) return send({ t: "start", classic: selectedClassic });
    if (topic.length < 3) { toast("Enter a topic first, pick a built-in list, or tap Surprise me.", "error"); return $("#topic").focus(); }
    send({ t: "start", topic });
  });
  $("#topic").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-start").click(); });

  $("#btn-copy").addEventListener("click", async () => {
    const link = `${location.origin}/?room=${code}`;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied."); }
    catch { toast(`Share this link: ${link}`); }
  });

  $("#btn-hint").addEventListener("click", () => send({ t: "hint" }));
  $("#btn-source").addEventListener("click", () => {
    showSource = !showSource;
    if (showSource && state && state.phase === "playing") send({ t: "source" });
    if (state) render();
  });

  // Quiet fair-play signals for ranked answers (see src/anticheat.ts): how an answer was entered, never what's on screen.
  const sig = { paste: false, keys: 0, firstKey: 0, blurMs: 0, blurStart: 0, refocusAt: 0 };
  const tnow = () => performance.now();
  function resetSignals() {
    sig.paste = false; sig.keys = 0; sig.firstKey = 0; sig.blurMs = 0; sig.refocusAt = 0;
    sig.blurStart = document.hidden || (document.hasFocus && !document.hasFocus()) ? tnow() : 0;
  }
  function collectSignals() {
    const t = tnow();
    return {
      paste: sig.paste,
      keys: sig.keys,
      typeMs: sig.firstKey ? Math.round(t - sig.firstKey) : 0,
      blurMs: Math.round(sig.blurMs + (sig.blurStart ? t - sig.blurStart : 0)),
      refocusMs: sig.refocusAt ? Math.round(t - sig.refocusAt) : 99999,
    };
  }
  const guessBox = $("#guess");
  guessBox.addEventListener("keydown", (e) => {
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return;
    sig.keys++;
    if (!sig.firstKey) sig.firstKey = tnow();
  });
  guessBox.addEventListener("paste", () => { sig.paste = true; });
  guessBox.addEventListener("drop", () => { sig.paste = true; });
  guessBox.addEventListener("input", (e) => {
    if (e.inputType && /insertFromPaste|insertFromDrop|insertFromYank/.test(e.inputType)) sig.paste = true;
  });
  const goneAway = () => { if (!sig.blurStart) sig.blurStart = tnow(); };
  const cameBack = () => { if (sig.blurStart) { sig.blurMs += tnow() - sig.blurStart; sig.blurStart = 0; sig.refocusAt = tnow(); } };
  window.addEventListener("blur", goneAway);
  window.addEventListener("focus", cameBack);
  document.addEventListener("visibilitychange", () => (document.hidden ? goneAway() : cameBack()));

  $("#guess-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#guess");
    const text = input.value.trim();
    if (!text || input.disabled) return;
    send({ t: "guess", text, ...(state && state.ranked ? { sig: collectSignals() } : {}) });
    input.value = "";
  });
  $("#btn-resign").addEventListener("click", () => {
    if (confirm("Resign this ranked match? It counts as a loss.")) send({ t: "resign" });
  });
  $("#btn-ranked-back").addEventListener("click", () => {
    leaveRoom(true);
    location.hash = "#/ranked";
  });
  $("#btn-rematch").addEventListener("click", () => send({ t: "rematch" }));

  // ------------------------------------------------------------------ daily challenge hooks (see daily.js)
  // ------------------------------------------------------------------ avatars (preset colour + picture, never a photo)
  const AV_HUES = [210, 340, 28, 150, 270, 190, 50, 0, 310, 120, 230, 80];
  const AV_ICONS = [
    '<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.2l-5.9 3.4 1.3-6.6-4.9-4.6 6.6-.8z"/>',
    '<path d="M13.5 2L5 13.5h5.5L9.5 22 19 10h-5.8z"/>',
    '<path d="M3 8l4.5 4L12 4l4.5 8L21 8l-2 11H5z"/>',
    '<path d="M12 2c.6 3.6 5 5.6 5 10.5a5 5 0 0 1-10 0c0-1.9.9-3.1 1.9-4 .1 1.8.9 2.7 2 2.8C10.2 8.7 10.2 5.4 12 2z"/>',
    '<path d="M12 2l8 8-8 12L4 10z"/>',
    '<path d="M20 14.6A8.6 8.6 0 0 1 9.4 4 8.6 8.6 0 1 0 20 14.6z"/>',
    '<path d="M20 4C10.5 4 4 9 4 15.2 4 18 6 20 9 20c6 0 11-6 11-16z"/>',
    '<path d="M12 2l8 3v6c0 5-3.4 8.8-8 11-4.6-2.2-8-6-8-11V5z"/>',
    '<path d="M12 2a6 6 0 0 0-6 6v4l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0z"/>',
    '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
    '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/>',
    '<circle cx="12" cy="12" r="5"/><path d="M11 1h2v4h-2zM11 19h2v4h-2zM1 11h4v2H1zM19 11h4v2h-4zM4.2 5.6l1.4-1.4 2.8 2.8-1.4 1.4zM15.6 17l1.4-1.4 2.8 2.8-1.4 1.4zM5.6 19.8L4.2 18.4 7 15.6l1.4 1.4zM17 8.4l-1.4-1.4 2.8-2.8 1.4 1.4z"/>',
  ];
  /** "colour:picture" (0 to 11 each) as a round SVG badge. */
  function avatarSvg(av, size = 32) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(av || "");
    const c = m ? Number(m[1]) % 12 : 0;
    const i = m ? Number(m[2]) % 12 : 0;
    return `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="Profile picture"><circle cx="20" cy="20" r="20" fill="hsl(${AV_HUES[c]} 62% 50%)"/><g transform="translate(8 8)" fill="#fff">${AV_ICONS[i]}</g></svg>`;
  }

  function openDaily() {
    if (code) leaveRoom(true);
    show("daily");
    window.dispatchEvent(new Event("tf:daily"));
  }
  function openRanked() {
    if (code) leaveRoom(true);
    show("ranked");
    window.dispatchEvent(new Event("tf:ranked"));
  }
  window.Tenfold = { $, $$, esc, show, toast, openDaily, openRanked, enterRoom: (c) => enterRoom(c), avatar: avatarSvg, avatarParts: { hues: AV_HUES, icons: AV_ICONS } };
  function route() {
    if (location.hash.startsWith("#/daily")) openDaily();
    else if (location.hash.startsWith("#/ranked")) openRanked();
    else if (!code && (!$("#screen-daily").hidden || !$("#screen-ranked").hidden)) show("home");
  }
  window.addEventListener("hashchange", route);

  // ------------------------------------------------------------------ boot
  buildSample();
  renderChips();
  $("#name").value = localStorage.getItem("tf_name") || "";
  const linked = new URLSearchParams(location.search).get("room");
  const saved = sessionStorage.getItem("tf_room");
  if (location.hash.startsWith("#/daily")) {
    openDaily();
  } else if (location.hash.startsWith("#/ranked")) {
    openRanked();
  } else if (saved && myName()) {
    fetch(`/api/rooms/${saved}`).then((r) => (r.ok ? enterRoom(saved) : (sessionStorage.removeItem("tf_room"), show("home")))).catch(() => show("home"));
  } else {
    if (linked) $("#code").value = linked.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    show("home");
    if (linked && !$("#name").value) $("#name").focus();
  }
})();
