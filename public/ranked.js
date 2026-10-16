(() => {
  "use strict";
  const T = window.Tenfold;
  if (!T) return;
  const { $, $$, esc, toast } = T;

  let pollTimer = null;
  let waitingSince = 0;
  let enteringMatch = false;
  let dailyTab = "today";
  let pick = { color: 0, icon: 0 };
  let savedAvatar = "0:0";

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    try {
      const res = await fetch(path, { credentials: "same-origin", ...opts });
      const data = await res.json().catch(() => ({}));
      return { httpStatus: res.status, ...data };
    } catch {
      return { httpStatus: 0, error: "Couldn't reach the server. Check your connection." };
    }
  }

  const ordinal = (n) => { const v = n % 100; return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"); };
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const hhmm = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };

  function panels(show) {
    for (const id of ["ranked-signin", "ranked-name-form", "ranked-hub", "ranked-account"]) $(`#${id}`).hidden = !show.includes(id);
  }

  const errorMessages = {
    denied: "Sign-in was cancelled.",
    state: "That sign-in link expired. Please try again.",
    blocked: "This account can't be used.",
  };

  // ------------------------------------------------------------------ page flow
  async function refresh() {
    stopPolling();
    enteringMatch = false;
    const authError = new URL(location.href).searchParams.get("autherror");
    if (authError) {
      toast(errorMessages[authError] || "Sign-in didn't work. Please try again.", "error");
      history.replaceState(null, "", "/#/ranked");
    }
    const who = await api("/api/me");
    if (!who.signedIn) {
      const pv = await api("/api/auth/providers");
      const list = pv.providers || [];
      $("#ranked-providers").innerHTML = list.map((p) => `<a class="btn btn-primary" href="/api/auth/${esc(p.id)}/start?next=ranked">Continue with ${esc(p.label)}</a>`).join("");
      $("#ranked-no-providers").hidden = list.length > 0;
      panels(["ranked-signin"]);
      return;
    }
    $("#rk-acct-name").textContent = who.name || "(no name yet)";
    if (!who.name) {
      panels(["ranked-name-form", "ranked-account"]);
      $("#ranked-name").focus();
      return;
    }
    await loadHub();
  }

  async function loadHub() {
    const [me, hist, ladder, daily] = await Promise.all([
      api("/api/ranked/me"),
      api("/api/ranked/history"),
      api("/api/ranked/ladder"),
      api("/api/daily/state"),
    ]);
    if (me.httpStatus === 401) return refresh();
    if (me.error) return toast(me.error, "error");
    panels(["ranked-hub", "ranked-account"]);
    renderProfile(me, hist);
    renderRecent(hist);
    renderDaily(daily);
    loadDailyBoard();
    $("#rk-ladder-body").innerHTML = ladder.rows ? ladderHtml(ladder.rows.slice(0, 20), ladder.me) : '<p class="hint">Couldn\'t load the ladder just now.</p>';
    if (me.status === "matched") return goToMatch(me);
    if (me.status === "waiting") return showWaiting(me);
    showIdle();
  }

  // ------------------------------------------------------------------ profile
  function renderProfile(me, hist) {
    savedAvatar = me.avatar || "0:0";
    $("#rk-avatar").innerHTML = T.avatar(savedAvatar, 84);
    $("#rk-name").textContent = me.name;
    $("#rk-sub").textContent = `${me.provisional ? "Provisional rating" : "Established player"}${me.rank ? `, #${me.rank} on the ladder` : ""}`;
    $("#rk-rating").textContent = me.rating;

    const streak = hist.streak || 0;
    const stats = [
      [me.peak, "Peak rating"],
      [me.games, me.games === 1 ? "Game" : "Games"],
      [me.games ? `${Math.round((me.wins / me.games) * 100)}%` : "n/a", "Win rate"],
      [`${me.wins}-${me.losses}-${me.draws}`, "Won-lost-drawn"],
      [streak > 0 ? `${streak} W` : streak < 0 ? `${-streak} L` : "0", "Current streak"],
    ];
    $("#rk-stats").innerHTML = stats.map(([n, l]) => `<div class="stat"><span class="stat-n">${esc(n)}</span><span class="stat-l">${l}</span></div>`).join("");
    $("#rk-trend").innerHTML = trendSvg(hist.trend || []);
    $("#rk-acct-name").textContent = me.name;
  }

  function trendSvg(values) {
    if (values.length < 2) return '<p class="hint">Play a few matches to see your rating trend.</p>';
    const W = 240, H = 64, pad = 8;
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = Math.max(1, hi - lo);
    const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (W - pad * 2), H - pad - ((v - lo) / span) * (H - pad * 2)]);
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Rating over your last ${values.length - 1} games, from ${values[0]} to ${values[values.length - 1]}"><polyline class="line" points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/><circle class="dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4"/></svg>`;
  }

  // ------------------------------------------------------------------ recent games
  function reasonText(r) {
    if (r.reason === "resigned") return r.result === "win" ? "opponent resigned" : "you resigned";
    if (r.reason === "disconnected") return r.result === "win" ? "opponent disconnected" : "you disconnected";
    return "played to the end";
  }

  function renderRecent(hist) {
    const rows = hist.rows || [];
    $("#rk-recent").innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<div class="recent-row"><span>${T.avatar(r.opponent.avatar, 32)}</span><span class="who">${esc(r.opponent.name)}<span class="rating">${r.opponent.rating}</span></span><span class="badge ${r.result}">${r.result === "win" ? "WIN" : r.result === "loss" ? "LOSS" : "DRAW"}</span><span class="delta ${r.delta > 0 ? "pos" : r.delta < 0 ? "neg" : ""}">${r.delta > 0 ? "+" : ""}${r.delta}</span><span class="meta">${esc(r.title)}. ${reasonText(r)}, now ${r.ratingAfter}, ${ago(r.time)}</span></div>`,
          )
          .join("")
      : '<p class="hint">No ranked games yet. Find a match to get your first rating.</p>';
  }

  // ------------------------------------------------------------------ daily challenge card
  function renderDaily(d) {
    const play = $("#rk-daily-play");
    if (d.error || !d.status) {
      $("#rk-daily-status").textContent = "One list a day, the same for everyone.";
      play.textContent = "Play today's challenge";
      return;
    }
    if (d.status === "done") {
      $("#rk-daily-status").textContent = `You scored ${d.score}${d.place ? `, ${ordinal(d.place)} today` : ""}. The next list is in ${hhmm(d.msUntilReset)}.`;
      play.textContent = "View today's results";
    } else if (d.status === "playing") {
      $("#rk-daily-status").textContent = "You're partway through today's attempt. The clock is running.";
      play.textContent = "Continue today's challenge";
    } else {
      $("#rk-daily-status").textContent = "Today's list is ready. One attempt, 3 lives, scored on speed.";
      play.textContent = "Play today's challenge";
    }
  }

  async function loadDailyBoard() {
    const b = await api(`/api/daily/leaderboard?scope=${dailyTab}`);
    $("#rk-daily-board").innerHTML = b.rows ? T.lbTable(b.rows.slice(0, 10), b.me, dailyTab === "month") : '<p class="hint">Couldn\'t load the leaderboard just now.</p>';
  }

  for (const t of $$("[data-daily-tab]")) {
    t.addEventListener("click", () => {
      dailyTab = t.dataset.dailyTab;
      for (const o of $$("[data-daily-tab]")) o.setAttribute("aria-selected", String(o === t));
      loadDailyBoard();
    });
  }

  // ------------------------------------------------------------------ ladder
  function ladderHtml(rows, me) {
    if (!rows.length) return '<p class="hint">Nobody has a rating yet. Play a match to get on the ladder.</p>';
    const row = (r) =>
      `<tr class="${r.me ? "me" : ""}"><td class="rk">${r.rank}</td><td><span class="who-cell">${T.avatar(r.avatar, 24)}${esc(r.name)}${r.me ? " (you)" : ""}</span></td><td class="num">${r.rating}${r.provisional ? '<span class="prov">?</span>' : ""}</td><td class="num">${r.wins}-${r.losses}-${r.draws}</td></tr>`;
    return `<table class="lb"><thead><tr><th>#</th><th>Player</th><th class="num">Rating</th><th class="num">W-L-D</th></tr></thead><tbody>${rows.map(row).join("")}${me ? row(me) : ""}</tbody></table>${rows.some((r) => r.provisional) ? '<p class="hint">? means still provisional (fewer than 20 rated games).</p>' : ""}`;
  }

  // ------------------------------------------------------------------ picture editor
  function drawEditor() {
    const { hues } = T.avatarParts;
    $("#av-colors").innerHTML = hues
      .map((h, i) => `<button class="swatch" type="button" data-color="${i}" aria-pressed="${i === pick.color}" aria-label="Colour ${i + 1}"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="hsl(${h} 62% 50%)"/></svg></button>`)
      .join("");
    $("#av-icons").innerHTML = T.avatarParts.icons
      .map((_, i) => `<button class="swatch icon" type="button" data-icon="${i}" aria-pressed="${i === pick.icon}" aria-label="Picture ${i + 1}">${T.avatar(`${pick.color}:${i}`, 38)}</button>`)
      .join("");
    $("#rk-avatar").innerHTML = T.avatar(`${pick.color}:${pick.icon}`, 84);
  }

  $("#rk-edit-avatar").addEventListener("click", () => {
    const open = $("#rk-avatar-editor").hidden;
    $("#rk-avatar-editor").hidden = !open;
    $("#rk-edit-avatar").setAttribute("aria-expanded", String(open));
    if (open) {
      const [c, i] = savedAvatar.split(":").map(Number);
      pick = { color: c, icon: i };
      drawEditor();
    } else {
      $("#rk-avatar").innerHTML = T.avatar(savedAvatar, 84);
    }
  });
  $("#rk-avatar-editor").addEventListener("click", (e) => {
    const b = e.target.closest(".swatch");
    if (!b) return;
    if (b.dataset.color !== undefined) pick.color = Number(b.dataset.color);
    if (b.dataset.icon !== undefined) pick.icon = Number(b.dataset.icon);
    drawEditor();
  });
  $("#av-cancel").addEventListener("click", () => {
    $("#rk-avatar-editor").hidden = true;
    $("#rk-edit-avatar").setAttribute("aria-expanded", "false");
    $("#rk-avatar").innerHTML = T.avatar(savedAvatar, 84);
  });
  $("#av-save").addEventListener("click", async () => {
    const r = await api("/api/me/avatar", { color: pick.color, icon: pick.icon });
    if (r.error) return toast(r.error, "error");
    toast("Picture saved.");
    $("#rk-avatar-editor").hidden = true;
    $("#rk-edit-avatar").setAttribute("aria-expanded", "false");
    loadHub();
  });

  // ------------------------------------------------------------------ the queue
  function showIdle() {
    $("#rk-idle").hidden = false;
    $("#rk-wait").hidden = true;
    stopPolling();
  }

  function showWaiting(s) {
    $("#rk-idle").hidden = true;
    $("#rk-wait").hidden = false;
    waitingSince = Date.now() - (s.waitedMs || 0);
    updateWaitText(s);
    if (!pollTimer) pollTimer = setInterval(poll, 1500);
  }

  function updateWaitText(s) {
    const secs = Math.max(0, Math.round((Date.now() - waitingSince) / 1000));
    const range = s && s.window ? ` Searching within ${s.window} rating points.` : "";
    $("#rk-wait-text").textContent = `Looking for an opponent… ${secs}s.${range}`;
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function poll() {
    if ($("#screen-ranked").hidden) return stopPolling(); // left the page: the server drops stale queue entries itself
    const s = await api("/api/ranked/status");
    if (s.httpStatus === 401) return refresh();
    if (s.status === "matched") return goToMatch(s);
    if (s.status === "waiting") return updateWaitText(s);
    if (s.status === "idle") {
      showIdle();
      toast("You were taken out of the queue. Join again to keep looking.");
    }
  }

  function goToMatch(s) {
    if (enteringMatch) return;
    enteringMatch = true;
    stopPolling();
    const name = $("#rk-acct-name").textContent;
    if (name) localStorage.setItem("tf_name", name);
    toast(`Opponent found: ${s.opponent.name} (${s.opponent.rating})`);
    T.enterRoom(s.code);
  }

  $("#rk-find").addEventListener("click", async () => {
    $("#rk-find").disabled = true;
    const s = await api("/api/ranked/queue", {});
    $("#rk-find").disabled = false;
    if (s.error) return toast(s.error, "error");
    if (s.status === "matched") return goToMatch(s);
    showWaiting(s);
  });

  $("#rk-cancel").addEventListener("click", async () => {
    await api("/api/ranked/leave", {});
    showIdle();
  });

  // ------------------------------------------------------------------ account
  $("#ranked-name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/me/name", { name: $("#ranked-name").value });
    if (r.error) return toast(r.error, "error");
    refresh();
  });

  $("#rk-signout").addEventListener("click", async () => {
    await api("/api/ranked/leave", {});
    await api("/api/auth/logout", {});
    refresh();
  });

  $("#rk-delete").addEventListener("click", async () => {
    if (!confirm("Delete your account? This erases your rating, match history and daily results, and can't be undone.")) return;
    await api("/api/ranked/leave", {});
    const r = await api("/api/me/delete", {});
    if (r.error) return toast(r.error, "error");
    toast("Your account has been deleted.");
    refresh();
  });

  window.addEventListener("tf:ranked", refresh);
  if (!$("#screen-ranked").hidden) refresh(); // app.js may have opened this page before this script loaded
})();
