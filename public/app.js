(() => {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
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

  const TOPICS = [
    "Most populous countries", "Best-selling video game consoles of all time", "Highest-grossing films ever",
    "Tallest mountains in the world", "Most-streamed artists on Spotify", "Largest countries by area",
    "Most-visited tourist attractions", "Premier League all-time top scorers", "Longest rivers in the world",
    "Most spoken languages", "Largest cities in Europe", "Most successful Olympic nations",
    "Bestselling book series", "Richest people in the world", "Tallest buildings in the world",
    "Most-subscribed YouTube channels", "Largest lakes in the world", "Most-visited countries",
    "Best-selling cars of all time", "Largest islands in the world", "Biggest tech companies by market value",
    "Most valuable football clubs", "Longest-running TV shows", "Most Grand Slam titles in men's tennis",
    "Largest companies by revenue", "Most popular boys' names in the UK", "Biggest dog breeds",
    "Most-listened-to albums of all time", "Largest deserts in the world", "Highest waterfalls in the world",
  ];
  const pick = (n) => [...TOPICS].sort(() => Math.random() - 0.5).slice(0, n);

  // ------------------------------------------------------------------ state
  const pid = (() => {
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
  const animated = new Set();
  let configTimer = null;
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

  const screens = ["home", "connecting", "lobby", "generating", "game"];
  function show(name) {
    for (const s of screens) $(`#screen-${s}`).hidden = s !== name;
    $("#btn-leave").hidden = name === "home";
  }

  function toast(msg, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), kind === "error" ? 5000 : 3200);
  }

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const myName = () => ($("#name").value || localStorage.getItem("tf_name") || "").trim().slice(0, 16);

  // ------------------------------------------------------------------ home
  function buildSample() {
    const rows = [["India", 1], ["China", 2], ["United States", 3], ["Indonesia", 4]];
    let html = "";
    for (let i = 1; i <= 10; i++) {
      const row = rows[i - 1];
      html += row
        ? `<li class="plate found" style="--d:${i - 1}"><span class="bulb">${i}</span><span class="plate-body"><span class="ans">${row[0]}</span></span><span class="pts"></span></li>`
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
    animated.clear();
    sessionStorage.removeItem("tf_room");
    history.replaceState(null, "", "/");
    $("#conn").hidden = true;
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
      else if (m.t === "toast") toast(m.msg, m.kind);
    };
    sock.onclose = () => {
      if (sock !== ws || leaving) return;
      stopPing();
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
    if (s.phase === "lobby" && !me && !joinSent) {
      joinSent = true;
      send({ t: "join", pid, name: myName() || "Player" });
    }
    if (me || s.phase !== "lobby") joinSent = false;

    if (s.phase === "lobby") { show("lobby"); animated.clear(); lastLogId = null; renderLobby(s, me); }
    else if (s.phase === "generating") { show("generating"); $("#gen-topic").textContent = s.topic; }
    else { show("game"); renderGame(s, me); }
  }

  function avatar(p) {
    return `<span class="avatar" style="--h:${hue(p.name)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
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

    // Settings: keep the controls in sync without fighting the host's cursor.
    const c = s.config;
    const lives = effective("lives", c.lives);
    const timerEnabled = effective("timer", c.timerEnabled);
    const seconds = effective("seconds", c.turnSeconds);
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
    $("#settings-note").hidden = isHost;

    // Topic: host only.
    $("#topic").disabled = !isHost;
    $("#topic").closest(".field").hidden = !isHost;
    $(".topic-tools").hidden = !isHost;
    $("#btn-start").hidden = !isHost;
    $("#wait-note").hidden = isHost;
  }

  function renderGame(s, me) {
    const finished = s.phase === "finished";
    const isMyTurn = s.phase === "playing" && s.turnPid === pid;
    const cur = s.players.find((p) => p.id === s.turnPid);

    $("#g-title").textContent = s.topic;
    $("#g-basis").textContent = s.basis;

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
        const sub = f
          ? `Found by ${esc(by ? by.name : "someone")}${a.detail ? ` · ${esc(a.detail)}` : ""}`
          : revealed ? `Missed${a.detail ? ` · ${esc(a.detail)}` : ""}` : "";
        return `<li class="${cls}"><span class="bulb">${a.rank}</span><span class="plate-body">${revealed ? `<span class="ans">${esc(a.answer)}</span><span class="sub">${sub}</span>` : ""}</span><span class="pts">${f ? `+${f.points}${bonus ? `<small>${esc(bonus)}</small>` : ""}` : ""}</span></li>`;
      })
      .join("");

    $("#wrong-wrap").hidden = !s.wrong.length;
    $("#wrong").innerHTML = s.wrong.map((w) => `<li class="chip-x">${esc(w)}</li>`).join("");

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
        return `<li class="${cls}">${avatar(p)}<span class="pname">${esc(p.name)}${p.id === pid ? " (you)" : ""}</span><span class="pscore">${p.score}</span><span class="pmeta">${hearts(p)}${status ? `<span>${status}</span>` : ""}</span></li>`;
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
      $("#res-title").textContent = title;
      let place = 0, prev = null;
      $("#res-list").innerHTML = sorted
        .map((p, i) => {
          if (p.score !== prev) place = i + 1;
          prev = p.score;
          return `<li class="${s.winners.includes(p.id) ? "winner" : ""}"><span class="place">${place}</span>${avatar(p)}<span class="sname">${esc(p.name)}${p.id === pid ? " (you)" : ""}</span><span class="sscore">${p.score}</span></li>`;
        })
        .join("");
      const isHost = s.hostId === pid;
      $("#btn-rematch").hidden = !isHost;
      $("#res-wait").hidden = isHost || !me;
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
  function stepLives(delta) {
    if (!state) return;
    const base = "lives" in pending ? pending.lives : state.config.lives;
    const next = Math.min(10, Math.max(1, base + delta));
    if (next === base) return;
    setPending("lives", next);
    render();
    pushConfig({ lives: next });
  }
  $("#lives-dec").addEventListener("click", () => stepLives(-1));
  $("#lives-inc").addEventListener("click", () => stepLives(1));
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

  function renderChips() {
    $("#topic-chips").innerHTML = pick(4).map((t) => `<button class="chip" type="button">${esc(t)}</button>`).join("");
  }
  $("#topic-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) { $("#topic").value = b.textContent; $("#topic").focus(); }
  });
  $("#btn-surprise").addEventListener("click", () => { $("#topic").value = pick(1)[0]; renderChips(); });
  $("#btn-start").addEventListener("click", () => {
    const topic = $("#topic").value.trim();
    if (topic.length < 3) { toast("Enter a topic first, or tap Surprise me.", "error"); return $("#topic").focus(); }
    send({ t: "start", topic });
  });
  $("#topic").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-start").click(); });

  $("#btn-copy").addEventListener("click", async () => {
    const link = `${location.origin}/?room=${code}`;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied."); }
    catch { toast(`Share this link: ${link}`); }
  });

  $("#guess-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#guess");
    const text = input.value.trim();
    if (!text || input.disabled) return;
    send({ t: "guess", text });
    input.value = "";
  });
  $("#btn-rematch").addEventListener("click", () => send({ t: "rematch" }));

  // ------------------------------------------------------------------ boot
  buildSample();
  renderChips();
  $("#name").value = localStorage.getItem("tf_name") || "";
  const linked = new URLSearchParams(location.search).get("room");
  const saved = sessionStorage.getItem("tf_room");
  if (saved && myName()) {
    fetch(`/api/rooms/${saved}`).then((r) => (r.ok ? enterRoom(saved) : (sessionStorage.removeItem("tf_room"), show("home")))).catch(() => show("home"));
  } else {
    if (linked) $("#code").value = linked.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    show("home");
    if (linked && !$("#name").value) $("#name").focus();
  }
})();
