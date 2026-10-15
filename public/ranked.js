(() => {
  "use strict";
  const T = window.Tenfold;
  if (!T) return;
  const { $, $$, esc, toast } = T;

  let pollTimer = null;
  let waitingSince = 0;
  let enteringMatch = false;

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

  function panels(show) {
    for (const id of ["ranked-signin", "ranked-name-form", "ranked-profile", "ranked-account"]) $(`#${id}`).hidden = !show.includes(id);
  }

  // ------------------------------------------------------------------ ladder tables
  function ladderHtml(rows, me, compact) {
    if (!rows.length) return '<p class="hint">Nobody has a rating yet. Play a match to get on the ladder.</p>';
    const row = (r) =>
      `<tr class="${r.me ? "me" : ""}"><td class="rk">${r.rank}</td><td>${esc(r.name)}${r.me ? " (you)" : ""}</td><td class="num">${r.rating}${r.provisional ? '<span class="prov">?</span>' : ""}</td>${compact ? "" : `<td class="num">${r.wins}-${r.losses}-${r.draws}</td>`}</tr>`;
    return `<table class="lb"><thead><tr><th>#</th><th>Player</th><th class="num">Rating</th>${compact ? "" : '<th class="num">W-L-D</th>'}</tr></thead><tbody>${rows.map(row).join("")}${me ? row(me) : ""}</tbody></table>${rows.some((r) => r.provisional) ? '<p class="hint">? = still provisional (fewer than 20 rated games)</p>' : ""}`;
  }

  async function loadLadder() {
    const l = await api("/api/ranked/ladder");
    $("#rk-ladder-body").innerHTML = l.rows ? ladderHtml(l.rows, l.me, false) : '<p class="hint">Couldn\'t load the ladder just now.</p>';
  }

  let homeAt = 0;
  async function loadHomeLadder(force) {
    if (!force && Date.now() - homeAt < 30000) return;
    homeAt = Date.now();
    const l = await api("/api/ranked/ladder");
    $("#home-ladder-body").innerHTML = l.rows ? ladderHtml(l.rows.slice(0, 5), null, true) : '<p class="hint">Couldn\'t load the ladder just now.</p>';
  }

  // ------------------------------------------------------------------ the page
  const errorMessages = {
    denied: "Sign-in was cancelled.",
    state: "That sign-in link expired. Please try again.",
    blocked: "This account can't be used.",
  };

  async function refresh() {
    stopPolling();
    enteringMatch = false;
    const authError = new URL(location.href).searchParams.get("autherror");
    if (authError) {
      toast(errorMessages[authError] || "Sign-in didn't work. Please try again.", "error");
      history.replaceState(null, "", "/#/ranked");
    }
    loadLadder();
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
    await loadProfile();
  }

  async function loadProfile() {
    const me = await api("/api/ranked/me");
    if (me.httpStatus === 401) return refresh();
    if (me.error) return toast(me.error, "error");
    $("#rk-rating").textContent = me.rating;
    $("#rk-prov").textContent = me.provisional ? "provisional rating (moves faster for your first 20 games)" : "";
    $("#rk-record").textContent = me.games
      ? `${me.games} ${me.games === 1 ? "game" : "games"}: ${me.wins} won, ${me.losses} lost, ${me.draws} drawn. Peak ${me.peak}.`
      : "You haven't played a ranked match yet.";
    panels(["ranked-profile", "ranked-account"]);
    if (me.status === "matched") return goToMatch(me);
    if (me.status === "waiting") return showWaiting(me);
    showIdle();
  }

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

  // ------------------------------------------------------------------ actions
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

  $("#rk-signout").addEventListener("click", async () => {
    await api("/api/ranked/leave", {});
    await api("/api/auth/logout", {});
    refresh();
  });

  window.addEventListener("tf:ranked", refresh);
  window.addEventListener("tf:home", () => loadHomeLadder());
  if (!$("#screen-ranked").hidden) refresh();
  if (!$("#screen-home").hidden) loadHomeLadder(true);
})();
