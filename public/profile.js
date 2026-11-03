(() => {
  "use strict";
  const T = window.Tenfold;
  if (!T) return;
  const { $, $$, esc, toast } = T;

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

  const plink = (name) => `<a class="plink" href="#/u/${encodeURIComponent(name)}">${esc(name)}</a>`;
  const monthName = (ym) => { const d = new Date(`${ym}-01T00:00:00Z`); return isNaN(d) ? ym : d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }); };
  const playerNav = () => '<nav class="pl-nav" aria-label="Profile navigation"><a class="btn pl-back" href="#/ranked" aria-label="Back to Ranked hub"><span class="pl-back-icon" aria-hidden="true">←</span><span>Ranked hub</span></a></nav>';

  // ==================================================================== your profile (settings)
  let savedAvatar = "0:0";
  let pick = { color: 0, icon: 0 };
  let providerLabels = {};

  const linkMessages = {
    taken: "That account is already used by another Tenfold account, so it can't be linked. Sign in with it on its own, or delete that account first.",
    provider: "You've already linked an account from that provider. Unlink it first if you want to switch.",
    auth: "Please sign in again, then try linking.",
  };

  async function loadMe() {
    const who = await api("/api/me");
    if (!who.signedIn) { location.hash = "#/ranked"; return; }

    const q = new URL(location.href).searchParams;
    const [pr, pv] = await Promise.all([api("/api/me/profile"), api("/api/auth/providers")]);
    providerLabels = Object.fromEntries((pv.providers || []).map((p) => [p.id, p.label]));
    if (q.get("linked")) toast(`${providerLabels[q.get("linked")] || "Account"} linked.`);
    if (q.get("linkerror")) toast(linkMessages[q.get("linkerror")] || "Couldn't link that account.", "error");
    if (q.get("linked") || q.get("linkerror")) history.replaceState(null, "", "/#/me");
    if (pr.error) return toast(pr.error, "error");

    $("#me-title").textContent = pr.name;
    $("#me-sub").textContent = "Your profile";
    savedAvatar = pr.avatar;
    const [c, i] = pr.avatar.split(":").map(Number);
    pick = { color: c, icon: i };
    drawEditor();

    $("#me-name").value = pr.name;
    $("#me-name").disabled = !!pr.nextNameChange;
    $("#me-name-form button").disabled = !!pr.nextNameChange;
    $("#me-name-note").textContent = pr.nextNameChange ? `You can change your username again on ${pr.nextNameChange}.` : "";

    renderIdentities(pr, pv.providers || []);
    $("#me-allow").checked = pr.allowRequests;
    $("#me-public").checked = pr.profilePublic;
    $("#me-since").textContent = monthName(pr.memberSince);
  }

  function renderIdentities(pr, available) {
    const linked = pr.identities;
    const canUnlink = linked.length > 1;
    const rows = linked.map((i) => {
      const label = i.provider === "original" ? "Original sign-in" : providerLabels[i.provider] || i.provider;
      return `<li><span class="idp">${esc(label)}<small>Linked on ${esc(i.linkedOn)}</small></span>${canUnlink ? `<button class="btn btn-small" type="button" data-unlink="${esc(i.provider)}">Unlink</button>` : '<span class="hint">Your only sign-in</span>'}</li>`;
    });
    const have = new Set(linked.map((i) => i.provider));
    for (const p of available) {
      if (!have.has(p.id)) rows.push(`<li><span class="idp">${esc(p.label)}<small>Not linked</small></span><a class="btn btn-small btn-primary" href="/api/auth/${esc(p.id)}/start?link=1">Link</a></li>`);
    }
    $("#me-identities").innerHTML = rows.join("");
  }

  $("#me-identities").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-unlink]");
    if (!b) return;
    if (!confirm("Unlink this sign-in method? You'll still be able to sign in with your others.")) return;
    const r = await api("/api/me/unlink", { provider: b.dataset.unlink });
    if (r.error) return toast(r.error, "error");
    toast("Unlinked.");
    loadMe();
  });

  // ---- picture
  function drawEditor() {
    const { hues } = T.avatarParts;
    $("#av-colors").innerHTML = hues
      .map((h, i) => `<button class="swatch" type="button" data-color="${i}" aria-pressed="${i === pick.color}" aria-label="Colour ${i + 1}"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="hsl(${h} 62% 50%)"/></svg></button>`)
      .join("");
    $("#av-icons").innerHTML = T.avatarParts.icons
      .map((_, i) => `<button class="swatch icon" type="button" data-icon="${i}" aria-pressed="${i === pick.icon}" aria-label="Picture ${i + 1}">${T.avatar(`${pick.color}:${i}`, 38)}</button>`)
      .join("");
    $("#me-avatar").innerHTML = T.avatar(`${pick.color}:${pick.icon}`, 72);
  }
  $("#screen-me .avatar-editor").addEventListener("click", (e) => {
    const b = e.target.closest(".swatch");
    if (!b) return;
    if (b.dataset.color !== undefined) pick.color = Number(b.dataset.color);
    if (b.dataset.icon !== undefined) pick.icon = Number(b.dataset.icon);
    drawEditor();
  });
  $("#av-save").addEventListener("click", async () => {
    const r = await api("/api/me/avatar", { color: pick.color, icon: pick.icon });
    if (r.error) return toast(r.error, "error");
    savedAvatar = r.avatar;
    toast("Picture saved.");
  });

  // ---- username
  $("#me-name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await api("/api/me/name", { name: $("#me-name").value });
    if (r.error) return toast(r.error, "error");
    toast("Username saved.");
    loadMe();
  });

  // ---- privacy
  for (const [id, key] of [["#me-allow", "allowRequests"], ["#me-public", "profilePublic"]]) {
    $(id).addEventListener("change", async (e) => {
      const r = await api("/api/me/settings", { [key]: e.target.checked });
      if (r.error) { toast(r.error, "error"); return loadMe(); }
      toast("Saved.");
    });
  }

  // ---- sign out and delete
  $("#me-signout").addEventListener("click", async () => {
    await api("/api/ranked/leave", {});
    await api("/api/auth/logout", {});
    location.hash = "#/ranked";
  });
  $("#me-delete").addEventListener("click", async () => {
    if (!confirm("Delete your account? This erases your username, rating, match history, daily results and friends, and can't be undone.")) return;
    await api("/api/ranked/leave", {});
    const r = await api("/api/me/delete", {});
    if (r.error) return toast(r.error, "error");
    toast("Your account has been deleted.");
    location.hash = "#/ranked";
  });

  // ==================================================================== someone else's profile
  let viewing = "";

  const badge = (r) => `<span class="badge ${r}">${r === "win" ? "WIN" : r === "loss" ? "LOSS" : "DRAW"}</span>`;
  const playerStatus = (p) => p.provisional ? "Provisional rating" : "Established player";

  function actionsHtml(p) {
    const b = (act, label, primary, extra = "") => `<button class="btn${primary ? " btn-primary" : ""}${extra}" type="button" data-act="${act}">${label}</button>`;
    switch (p.relationship) {
      case "self": return '<a class="btn pl-back" href="#/me"><span class="pl-back-icon" aria-hidden="true">↗</span><span>Edit your profile</span></a>';
      case "friends": return `<span class="friend-badge">Friends</span>${b("remove", "Remove friend", false, " btn-quiet")}`;
      case "outgoing": return `<span class="hint">Request sent.</span>${b("cancel", "Cancel request", false)}`;
      case "incoming": return `<span class="hint">${esc(p.name)} wants to be friends.</span>${b("accept", "Accept", true)}${b("decline", "Decline", false)}`;
      default: return p.acceptsRequests ? b("request", "Add friend", true) : `<span class="hint">${esc(p.name)} isn't accepting friend requests.</span>`;
    }
  }

  function renderPlayer(p) {
    const rank = p.rank ? `<span class="pl-detail">Rank <strong>#${p.rank}</strong></span>` : "";
    const since = p.memberSince ? `<span class="pl-detail">member since <strong>${esc(monthName(p.memberSince))}</strong></span>` : "";
    const challenge = p.relationship === "friends" ? '<button class="btn btn-primary profile-challenge" type="button" data-challenge aria-haspopup="dialog" aria-controls="profile-challenge-dialog">Challenge</button>' : "";
    const head = `<header class="pl-head panel"><span class="profile-avatar">${T.avatar(p.avatar, 96)}</span><div class="pl-identity"><p class="pl-eyebrow">${playerStatus(p)}</p><h1 class="display profile-name">${esc(p.name)}</h1><div class="pl-details">${rank}${since}</div></div><div class="profile-side">${challenge}<div class="profile-rating"><span class="rating-big">${p.rating}</span><span class="hint">rating</span></div></div><div class="pl-actions">${actionsHtml(p)}</div></header>`;
    const challengeDialog = p.relationship === "friends" ? `<dialog id="profile-challenge-dialog" class="challenge-dialog" aria-labelledby="profile-challenge-title"><button class="challenge-close" type="button" data-close-challenge aria-label="Close challenge options">×</button><h2 class="h2" id="profile-challenge-title">Challenge ${esc(p.name)}</h2><p class="hint">Choose how you would like to play.</p><div class="challenge-dialog-options"><button class="btn btn-primary" type="button" data-play-mode="rated">Ranked</button><button class="btn" type="button" data-play-mode="casual">For fun</button></div></dialog>` : "";
    if (p.restricted) {
      return `<div class="pl-page">${playerNav()}${head}<section class="panel pl-private"><h2 class="h2">Private profile</h2><p class="hint">${esc(p.name)} only shares their stats and recent games with friends.</p></section>${challengeDialog}</div>`;
    }
    const recent = p.recent.length
      ? p.recent.map((r) => `<div class="recent-row"><span class="recent-avatar">${T.avatar(r.opponent.avatar, 36)}</span><span class="recent-opponent"><span class="who">${plink(r.opponent.name)}</span><span class="recent-rating">${r.opponent.rating} rating</span></span>${badge(r.result)}<span class="delta ${r.delta > 0 ? "pos" : r.delta < 0 ? "neg" : ""}">${r.delta > 0 ? "+" : ""}${r.delta}</span><span class="meta">${esc(r.title)} <span aria-hidden="true">·</span> ${T.ago(r.time)}</span></div>`).join("")
      : '<div class="pl-empty"><span class="pl-empty-mark" aria-hidden="true">—</span><p class="hint">No ranked games yet.</p></div>';
    const record = `<section class="panel pl-record"><h2 class="h2">Ranked record</h2><div class="stat-row">${T.statsHtml(p, p.streak || 0)}</div><div class="trend">${T.trendSvg(p.trend || [])}</div></section>`;
    const games = `<section class="panel pl-games"><h2 class="h2">Recent ranked games</h2>${recent}</section>`;
    return `<div class="pl-page">${playerNav()}<div class="pl-summary">${head}${record}</div>${games}${challengeDialog}</div>`;
  }

  async function loadPlayer() {
    const who = await api("/api/me");
    if (!who.signedIn) { location.hash = "#/ranked"; return; }
    try { viewing = decodeURIComponent(location.hash.slice(4)); } catch { viewing = ""; }
    const body = $("#pl-body");
    body.innerHTML = '<p class="hint">Loading…</p>';
    const p = await api(`/api/players/${encodeURIComponent(viewing)}`);
    body.innerHTML = p.error
      ? `${playerNav()}<section class="panel"><h2 class="h2">Player not found</h2><p class="hint">${esc(p.error)}</p></section>`
      : renderPlayer(p);
  }

  $("#pl-body").addEventListener("click", async (e) => {
    const challenge = e.target.closest("[data-challenge]");
    const playMode = e.target.closest("[data-play-mode]");
    if (challenge) {
      $("#profile-challenge-dialog").showModal();
      return;
    }
    if (e.target.closest("[data-close-challenge]")) {
      $("#profile-challenge-dialog").close();
      return;
    }
    if (playMode) {
      playMode.disabled = true;
      const mode = playMode.dataset.playMode;
      const r = await api("/api/ranked/invites", { name: viewing, mode });
      if (r.error) {
        toast(r.error, "error");
        playMode.disabled = false;
      } else {
        toast(`${mode === "rated" ? "Ranked" : "For fun"} game invitation sent.`);
        $("#profile-challenge-dialog").close();
      }
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "remove" && !confirm(`Remove ${viewing} from your friends?`)) return;
    b.disabled = true;
    const r = await api(`/api/friends/${b.dataset.act}`, { name: viewing });
    if (r.error) toast(r.error, "error");
    else if (b.dataset.act === "request") toast(r.status === "friends" ? `You're now friends with ${viewing}.` : `Request sent to ${viewing}.`);
    else if (b.dataset.act === "accept") toast(`You're now friends with ${viewing}.`);
    loadPlayer();
  });

  window.addEventListener("tf:me", loadMe);
  window.addEventListener("tf:player", loadPlayer);
  if (!$("#screen-me").hidden) loadMe();
  if (!$("#screen-player").hidden) loadPlayer();
})();
