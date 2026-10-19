(() => {
  "use strict";
  const T = window.Tenfold;
  if (!T) return;
  const { $, $$, esc, toast } = T;

  let pollTimer = null;
  let waitingSince = 0;
  let enteringMatch = false;
  let dailyTab = "today";

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
  const plink = (name) => `<a class="plink" href="#/u/${encodeURIComponent(name)}">${esc(name)}</a>`;

  function panels(show) {
    for (const id of ["ranked-signin", "ranked-name-form", "ranked-hub"]) $(`#${id}`).hidden = !show.includes(id);
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
    if (!who.name) {
      panels(["ranked-name-form"]);
      $("#ranked-name").focus();
      return;
    }
    await loadHub();
  }

  async function loadHub() {
    const [me, hist, ladder, daily, friends] = await Promise.all([
      api("/api/ranked/me"),
      api("/api/ranked/history"),
      api("/api/ranked/ladder"),
      api("/api/daily/state"),
      api("/api/friends"),
    ]);
    if (me.httpStatus === 401) return refresh();
    if (me.error) return toast(me.error, "error");
    panels(["ranked-hub"]);
    renderProfile(me, hist);
    renderRecent(hist);
    renderDaily(daily);
    renderFriends(friends);
    loadDailyBoard();
    $("#rk-ladder-body").innerHTML = ladder.rows ? ladderHtml(ladder.rows.slice(0, 20), ladder.me) : '<p class="hint">Couldn\'t load the ladder just now.</p>';
    if (me.status === "matched") return goToMatch(me);
    if (me.status === "waiting") return showWaiting(me);
    showIdle();
  }

  // ------------------------------------------------------------------ profile summary
  function renderProfile(me, hist) {
    $("#rk-avatar").innerHTML = T.avatar(me.avatar || "0:0", 84);
    $("#rk-name").textContent = me.name;
    $("#rk-sub").textContent = `${me.provisional ? "Provisional rating" : "Established player"}${me.rank ? `, #${me.rank} on the ladder` : ""}`;
    $("#rk-rating").textContent = me.rating;
    $("#rk-stats").innerHTML = statsHtml(me, hist.streak || 0);
    $("#rk-trend").innerHTML = trendSvg(hist.trend || []);
  }

  function statsHtml(p, streak) {
    const stats = [
      [p.peak, "Peak rating"],
      [p.games, p.games === 1 ? "Game" : "Games"],
      [p.games ? `${Math.round((p.wins / p.games) * 100)}%` : "n/a", "Win rate"],
      [`${p.wins}-${p.losses}-${p.draws}`, "Won-lost-drawn"],
      [streak > 0 ? `${streak} W` : streak < 0 ? `${-streak} L` : "0", "Current streak"],
    ];
    return stats.map(([n, l]) => `<div class="stat"><span class="stat-n">${esc(n)}</span><span class="stat-l">${l}</span></div>`).join("");
  }

  function trendSvg(values) {
    if (values.length < 2) return '<p class="hint">Play a few matches to see a rating trend.</p>';
    const W = 240, H = 64, pad = 8;
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = Math.max(1, hi - lo);
    const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (W - pad * 2), H - pad - ((v - lo) / span) * (H - pad * 2)]);
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Rating over the last ${values.length - 1} games, from ${values[0]} to ${values[values.length - 1]}"><polyline class="line" points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}"/><circle class="dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4"/></svg>`;
  }
  T.statsHtml = statsHtml;
  T.trendSvg = trendSvg;
  T.ago = ago;

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
              `<div class="recent-row"><span>${T.avatar(r.opponent.avatar, 32)}</span><span class="who">${plink(r.opponent.name)}<span class="rating">${r.opponent.rating}</span></span><span class="badge ${r.result}">${r.result === "win" ? "WIN" : r.result === "loss" ? "LOSS" : "DRAW"}</span><span class="delta ${r.delta > 0 ? "pos" : r.delta < 0 ? "neg" : ""}">${r.delta > 0 ? "+" : ""}${r.delta}</span><span class="meta">${esc(r.title)}. ${reasonText(r)}, now ${r.ratingAfter}, ${ago(r.time)}</span></div>`,
          )
          .join("")
      : '<p class="hint">No ranked games yet. Find a match to get your first rating.</p>';
  }

  // ------------------------------------------------------------------ friends
  function renderFriends(f) {
    if (!f || f.error) return;
    $("#fr-count").textContent = f.friends.length ? `(${f.friends.length})` : "";
    const row = (p, hint, actions) =>
      `<li class="fr-row"><span>${T.avatar(p.avatar, 32)}</span><span class="fr-name">${plink(p.name)}<span class="hint">${p.rating}${hint ? `, ${esc(hint)}` : ""}</span></span><span class="fr-actions">${actions}</span></li>`;
    const btn = (act, name, label, primary) => `<button class="btn btn-small${primary ? " btn-primary" : ""}" type="button" data-fr="${act}" data-name="${esc(name)}">${label}</button>`;
    $("#fr-requests").hidden = !f.incoming.length;
    $("#fr-incoming").innerHTML = f.incoming.map((p) => row(p, "wants to be friends", btn("accept", p.name, "Accept", true) + btn("decline", p.name, "Decline"))).join("");
    $("#fr-list").innerHTML = f.friends.length
      ? f.friends.map((p) => row(p, p.activity, "")).join("")
      : '<li class="hint">No friends yet. Send a request using a username above.</li>';
    $("#fr-sent").hidden = !f.outgoing.length;
    $("#fr-outgoing").innerHTML = f.outgoing.map((p) => row(p, "waiting for a reply", btn("cancel", p.name, "Cancel"))).join("");
  }

  async function reloadFriends() {
    renderFriends(await api("/api/friends"));
  }

  $("#fr-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#fr-add-name").value.trim();
    if (!name) return;
    const r = await api("/api/friends/request", { name });
    if (r.error) return toast(r.error, "error");
    $("#fr-add-name").value = "";
    toast(r.status === "friends" ? `You're now friends with ${name}.` : `Request sent to ${name}.`);
    reloadFriends();
  });

  $(".friends-card").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fr]");
    if (!b) return;
    b.disabled = true;
    const r = await api(`/api/friends/${b.dataset.fr}`, { name: b.dataset.name });
    if (r.error) toast(r.error, "error");
    else if (b.dataset.fr === "accept") toast(`You're now friends with ${b.dataset.name}.`);
    reloadFriends();
  });

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
      `<tr class="${r.me ? "me" : ""}"><td class="rk">${r.rank}</td><td><span class="who-cell">${T.avatar(r.avatar, 24)}${plink(r.name)}${r.me ? " (you)" : ""}</span></td><td class="num">${r.rating}${r.provisional ? '<span class="prov">?</span>' : ""}</td><td class="num">${r.wins}-${r.losses}-${r.draws}</td></tr>`;
    return `<table class="lb"><thead><tr><th>#</th><th>Player</th><th class="num">Rating</th><th class="num">W-L-D</th></tr></thead><tbody>${rows.map(row).join("")}${me ? row(me) : ""}</tbody></table>${rows.some((r) => r.provisional) ? '<p class="hint">? means still provisional (fewer than 20 rated games).</p>' : ""}`;
  }

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
    const name = $("#rk-name").textContent;
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

  $("#ranked-name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/me/name", { name: $("#ranked-name").value });
    if (r.error) return toast(r.error, "error");
    refresh();
  });

  window.addEventListener("tf:ranked", refresh);
  if (!$("#screen-ranked").hidden) refresh(); // app.js may have opened this page before this script loaded
})();
