(() => {
  "use strict";
  const T = window.Tenfold;
  if (!T) return;
  const { $, $$, esc, toast } = T;

  let state = null; // the player's attempt for today
  let signedIn = false;
  let deadline = 0; // local time when the current answer runs out
  let tab = "today";
  let refreshing = false;

  // ------------------------------------------------------------------ talking to the server
  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    try {
      const res = await fetch(path, { credentials: "same-origin", ...opts });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ...data };
    } catch {
      return { status: 0, error: "Couldn't reach the server. Check your connection." };
    }
  }

  // ------------------------------------------------------------------ quiet fair-play signals
  // Facts about HOW an answer was entered, never what is in the clipboard or on screen.
  // They only ever feed a review queue; nothing here is shown to the player.
  const sig = { paste: false, keys: 0, firstKey: 0, blurMs: 0, blurStart: 0, refocusAt: 0 };
  const now = () => performance.now();
  function resetSignals() {
    sig.paste = false; sig.keys = 0; sig.firstKey = 0; sig.blurMs = 0; sig.refocusAt = 0;
    sig.blurStart = document.hidden || (document.hasFocus && !document.hasFocus()) ? now() : 0;
  }
  function away() { if (!sig.blurStart) sig.blurStart = now(); }
  function back() {
    if (sig.blurStart) { sig.blurMs += now() - sig.blurStart; sig.blurStart = 0; sig.refocusAt = now(); }
  }
  function collectSignals() {
    const t = now();
    return {
      paste: sig.paste,
      keys: sig.keys,
      typeMs: sig.firstKey ? Math.round(t - sig.firstKey) : 0,
      blurMs: Math.round(sig.blurMs + (sig.blurStart ? t - sig.blurStart : 0)),
      refocusMs: sig.refocusAt ? Math.round(t - sig.refocusAt) : 99999,
    };
  }
  const input = $("#daily-guess");
  input.addEventListener("keydown", (e) => {
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return;
    sig.keys++;
    if (!sig.firstKey) sig.firstKey = now();
  });
  input.addEventListener("paste", () => { sig.paste = true; });
  input.addEventListener("drop", () => { sig.paste = true; });
  input.addEventListener("input", (e) => {
    if (e.inputType && /insertFromPaste|insertFromDrop|insertFromYank/.test(e.inputType)) sig.paste = true;
  });
  window.addEventListener("blur", away);
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", () => (document.hidden ? away() : back()));

  // ------------------------------------------------------------------ screens
  function panels(show) {
    for (const id of ["daily-signin", "daily-name-form", "daily-ready", "daily-play", "daily-result", "daily-board", "daily-account"]) {
      $(`#${id}`).hidden = !show.includes(id);
    }
    $("#daily-guess-form").hidden = !show.includes("daily-play");
  }

  const errorMessages = {
    denied: "Sign-in was cancelled.",
    state: "That sign-in link expired. Please try again.",
    blocked: "This account can't be used.",
  };

  async function refresh() {
    const url = new URL(location.href);
    const authError = url.searchParams.get("autherror");
    if (authError) {
      toast(errorMessages[authError] || "Sign-in didn't work. Please try again.", "error");
      history.replaceState(null, "", "/#/daily");
    }

    const me = await api("/api/me");
    signedIn = !!me.signedIn;
    if (!signedIn) {
      const pv = await api("/api/auth/providers");
      const list = pv.providers || [];
      $("#provider-buttons").innerHTML = list
        .map((p) => `<a class="btn btn-primary" href="/api/auth/${esc(p.id)}/start">Continue with ${esc(p.label)}</a>`)
        .join("");
      $("#no-providers").hidden = list.length > 0;
      panels(["daily-signin"]);
      loadBoard();
      $("#daily-board").hidden = false;
      return;
    }
    $("#acct-name").textContent = me.name || "(no name yet)";
    if (!me.name) {
      panels(["daily-name-form", "daily-account"]);
      $("#daily-name").focus();
      return;
    }
    await loadState();
  }

  async function loadState() {
    const s = await api("/api/daily/state");
    if (s.status === 401) return refresh();
    if (s.error) { toast(s.error, "error"); return; }
    setState(s);
  }

  function setState(s) {
    state = s;
    $("#rule-secs").textContent = Math.round(s.turnMs / 1000);
    deadline = Date.now() + (s.remainingMs || 0);
    resetSignals();
    if (s.status === "playing") {
      panels(["daily-play", "daily-account"]);
      renderPlay();
      $("#daily-guess").focus({ preventScroll: true });
    } else if (s.status === "done") {
      panels(["daily-result", "daily-board", "daily-account"]);
      renderDone();
      loadBoard();
    } else {
      panels(["daily-ready", "daily-board", "daily-account"]);
      loadBoard();
    }
  }

  // ------------------------------------------------------------------ playing
  function renderPlay() {
    const s = state;
    $("#daily-topic").textContent = s.topic || "Today's list";
    $("#daily-basis").textContent = s.basis || "";
    $("#daily-stats").innerHTML =
      `<span><span class="big">${s.score}</span> points</span>` +
      `<span class="hearts" aria-label="${s.livesLeft} lives">${[...Array(s.lives)].map((_, i) => `<svg class="heart ${i < s.livesLeft ? "" : "lost"}"><use href="#i-heart"/></svg>`).join("")}</span>` +
      `<span>${s.found.length} of 10 found</span>`;
    $("#daily-list").innerHTML = boardHtml(s);
    $("#daily-turn").textContent = "Your answer";
    tick();
  }

  function boardHtml(s) {
    let html = "";
    for (let rank = 1; rank <= 10; rank++) {
      const f = s.found.find((e) => e.rank === rank);
      html += f
        ? `<li class="plate found"><span class="bulb">${rank}</span><span class="plate-body"><span class="ans">${esc(f.answer)}</span>${f.detail ? `<span class="sub">${esc(f.detail)}</span>` : ""}</span><span class="pts">+${f.points}</span></li>`
        : `<li class="plate hidden"><span class="bulb">${rank}</span><span class="plate-body"></span><span class="pts"></span></li>`;
    }
    return html;
  }

  function tick() {
    if (!state || state.status !== "playing") return;
    const left = Math.max(0, deadline - Date.now());
    const pct = Math.min(1, left / state.turnMs);
    $("#daily-fill").style.width = `${pct * 100}%`;
    $("#daily-fill").classList.toggle("low", pct < 0.25);
    $("#daily-secs").textContent = Math.ceil(left / 1000);
    if (left <= 0 && !refreshing) {
      // The server applies the timeout; ask it where we stand.
      refreshing = true;
      setTimeout(async () => { await loadState(); refreshing = false; }, 400);
    }
  }
  setInterval(tick, 100);

  const result = {
    hit: (r) => toast(`+${r.points} for ${r.answer}`),
    miss: (r) => toast(r.livesLeft > 0 ? `Not on the list. ${r.livesLeft} ${r.livesLeft === 1 ? "life" : "lives"} left.` : "Not on the list. That was your last life.", "error"),
    dupe: (r) => toast(`${r.answer} is already on the board.`),
    repeat: () => toast("You already tried that one. No life lost."),
  };

  $("#daily-guess-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !state || state.status !== "playing") return;
    const signals = collectSignals();
    input.value = "";
    $("#daily-guess-btn").disabled = true;
    const r = await api("/api/daily/guess", { text, sig: signals });
    $("#daily-guess-btn").disabled = false;
    if (r.status === 429) return toast("Slow down a little.");
    if (r.error) return toast(r.error, "error");
    if (r.result && result[r.result.kind]) result[r.result.kind](r.result);
    setState(r);
  });

  // ------------------------------------------------------------------ finished
  function renderDone() {
    const s = state;
    $("#daily-result-title").textContent = `You scored ${s.score}`;
    $("#daily-result-detail").textContent =
      `${s.found.length} of 10 found, ${s.wrong} wrong${s.place ? `, ${ordinal(s.place)} today` : ""}.`;
    $("#daily-result-note").textContent =
      "The answers you missed are revealed after 00:00 UTC, so nobody can pass them on. Come back tomorrow for a new list.";
    const src = $("#daily-source");
    src.hidden = !s.source;
    if (s.source) {
      const q = encodeURIComponent(`${s.topic} ${s.source}`);
      src.innerHTML = `Source (AI-suggested, not verified): ${esc(s.source)}. <a href="https://duckduckgo.com/?q=${q}" target="_blank" rel="noopener noreferrer">Search to verify</a>`;
    }
  }
  const ordinal = (n) => { const v = n % 100; return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"); };

  $("#daily-report").addEventListener("click", async () => {
    const r = await api("/api/daily/report", {});
    toast(r.ok ? "Thanks, we'll take a look at today's list." : "Couldn't send that just now.", r.ok ? "info" : "error");
  });

  // ------------------------------------------------------------------ leaderboards
  function msText(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

  function tableHtml(rows, me, month) {
    if (!rows.length) return '<p class="hint">Nobody has finished yet. Be the first.</p>';
    const row = (r) =>
      `<tr class="${r.me ? "me" : ""}"><td class="rk">${r.rank}</td><td>${esc(r.name)}${r.me ? " (you)" : ""}</td><td class="num">${r.score}</td><td class="num">${month ? `${r.days} ${r.days === 1 ? "day" : "days"}` : `${r.found}/10`}</td><td class="num">${msText(r.ms)}</td></tr>`;
    return `<table class="lb"><thead><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num">${month ? "Played" : "Found"}</th><th class="num">Time</th></tr></thead><tbody>${rows.map(row).join("")}${me ? row(me) : ""}</tbody></table>`;
  }

  async function loadBoard() {
    const body = $("#lb-body");
    if (tab === "yesterday") {
      const y = await api("/api/daily/yesterday");
      if (!y.available) { body.innerHTML = '<p class="hint">There\'s no list from yesterday yet.</p>'; return; }
      body.innerHTML =
        `<h3 class="h3">${esc(y.title)}</h3><p class="hint">${esc(y.basis)}</p>` +
        `<ol class="reveal-list">${y.answers.map((a) => `<li><span class="n">${a.rank}</span><span>${esc(a.answer)}${a.detail ? ` <span class="hint">${esc(a.detail)}</span>` : ""}</span></li>`).join("")}</ol>` +
        (y.rows && y.rows.length ? `<h3 class="h3">Yesterday's top ${y.rows.length}</h3>${tableHtml(y.rows, y.me, false)}` : "");
      return;
    }
    const b = await api(`/api/daily/leaderboard?scope=${tab}`);
    body.innerHTML = tableHtml(b.rows || [], b.me, tab === "month");
  }

  for (const t of $$(".tab")) {
    t.addEventListener("click", () => {
      tab = t.dataset.tab;
      for (const o of $$(".tab")) o.setAttribute("aria-selected", String(o === t));
      loadBoard();
    });
  }

  // ------------------------------------------------------------------ home page leaderboard
  let homeTab = "today";
  let homeAt = 0;
  async function loadHomeBoard(force) {
    if (!force && Date.now() - homeAt < 30000) return;
    homeAt = Date.now();
    const b = await api(`/api/daily/leaderboard?scope=${homeTab}`);
    const body = $("#home-lb-body");
    if (!b.rows) { body.innerHTML = '<p class="hint">Couldn\'t load the leaderboard just now.</p>'; return; }
    const top = b.rows.slice(0, 10);
    const me = b.me || b.rows.find((r) => r.me && r.rank > 10) || null;
    body.innerHTML = tableHtml(top, me, homeTab === "month");
  }
  for (const t of $$(".htab")) {
    t.addEventListener("click", () => {
      homeTab = t.dataset.homeTab;
      for (const o of $$(".htab")) o.setAttribute("aria-selected", String(o === t));
      loadHomeBoard(true);
    });
  }
  window.addEventListener("tf:home", () => loadHomeBoard());
  if (!$("#screen-home").hidden) loadHomeBoard(true);

  // ------------------------------------------------------------------ account
  $("#daily-name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/me/name", { name: $("#daily-name").value });
    if (r.error) return toast(r.error, "error");
    refresh();
  });

  $("#daily-start").addEventListener("click", async () => {
    $("#daily-start").disabled = true;
    const r = await api("/api/daily/start", {});
    $("#daily-start").disabled = false;
    if (r.error) return toast(r.error, "error");
    setState(r);
  });

  $("#btn-signout").addEventListener("click", async () => {
    await api("/api/auth/logout", {});
    state = null;
    refresh();
  });

  $("#btn-delete").addEventListener("click", async () => {
    if (!confirm("Delete your account and all your results? If you've already played today you won't be able to play again until tomorrow.")) return;
    const r = await api("/api/me/delete", {});
    if (r.error) return toast(r.error, "error");
    toast("Your account has been deleted.");
    state = null;
    refresh();
  });

  // ------------------------------------------------------------------ entry
  window.addEventListener("tf:daily", refresh);
  if (!$("#screen-daily").hidden) refresh(); // app.js may have opened this page before this script loaded
})();
