import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
const BASE = "http://localhost:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const errors = []; const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message)); vc.on("error", (e) => errors.push(String(e)));
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<link[^>]*fonts[^>]*>/g, "").replace(/<script src="\/app.js" defer><\/script>/, "");
const css = fs.readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: BASE + "/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window; w.fetch = (u, o) => fetch(new URL(u, BASE), o);
let audioStarts = 0;
w.AudioContext = class {
  currentTime = 0;
  state = "running";
  destination = {};
  createOscillator() { return { frequency: { value: 0 }, connect() {}, start() { audioStarts++; }, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
};
w.eval(fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"));
const $ = (s) => w.document.querySelector(s); const $$ = (s) => [...w.document.querySelectorAll(s)];
const visible = (id) => !$(id).hidden;
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(40); } return false; };
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
const submitGuess = (text) => { $("#guess").value = text; $("#guess-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };

ok(visible("#screen-home") && $$("#sample-board .plate").length === 10, "home screen with sample board");
$("#name").value = "Tester"; click($("#btn-create"));
ok(await until(() => visible("#screen-lobby")), "lobby after creating a room");
const code = $$("#room-code span").map((s) => s.textContent).join("");

console.log("lobby controls");
ok($("#score-setup-modal").hidden, "player setup stays closed until Start game is pressed");
ok($$("#classics .chip").length === 6, "six built-in lists offered");
ok($("#list-url").type === "url" && $("#prefer-latest-year").type === "checkbox" && $("#prefer-latest-year").closest(".settings"), "the latest-year preference sits with match settings");
ok(/input\[type="url"\][\s\S]*?color:\s*var\(--chalk\)/.test(css) && /input\[type="url"\][\s\S]*?background:\s*var\(--stage-deep\)/.test(css), "the list URL input uses readable text on the dark input background");
ok(await until(() => /Free AI lists left today: \d+ of \d+/.test($("#budget-note").textContent)), "host sees the free-AI budget note: " + $("#budget-note").textContent.slice(0, 60));
ok($$(".seg").length === 2 && $(".seg[data-diff=easy]").getAttribute("aria-checked") === "true", "difficulty defaults to Easy");
ok($("#hints-val").textContent === "3", "hints default to 3");

const bobPid = "pid-bob-12345678"; let bob = null, bobState = null;
const bobWs = new WebSocket(`ws://localhost:8787/ws/${code}`, { headers: { Origin: BASE } });
bobWs.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === "state") bobState = m; };
await new Promise((r) => (bobWs.onopen = r));
const bsend = (o) => bobWs.send(JSON.stringify(o));
bsend({ t: "join", pid: bobPid, name: "Bob" });
ok(await until(() => $$("#lobby-players li").length === 2), "both players listed");
ok(!!$("#lobby-players [data-promote]"), "the leader can promote a connected player");
click($("#lobby-players [data-promote]"));
ok(await until(() => bobState && bobState.hostId === bobPid) && !$("#lobby-players [data-promote]"), "promotion transfers lobby controls to the other player");
bsend({ t: "promote", targetId: w.sessionStorage.getItem("tf_pid") });
ok(await until(() => bobState && bobState.hostId !== bobPid && !!$("#lobby-players [data-promote]")), "the new leader can promote the original leader back");

click($(".seg[data-diff=hard]"));
ok($(".seg[data-diff=hard]").getAttribute("aria-checked") === "true" && bobState.config.difficulty === undefined, "Hard changes the suggested topic category, not shared match settings");
$("#prefer-latest-year").checked = true; $("#prefer-latest-year").dispatchEvent(new w.Event("change", { bubbles: true }));
ok(await until(() => bobState && bobState.config.preferLatestYear === true), "latest-year preference syncs with the other match settings");
click($("#hints-inc")); click($("#hints-inc"));
ok(await until(() => bobState.config.hints === 5) && $("#hints-val").textContent === "5" && $("#hints-inc").disabled, "hints stepper: two quick taps give 5 and cap at 5");
click($("#hints-dec")); click($("#hints-dec")); click($("#hints-dec"));
ok(await until(() => bobState.config.hints === 2) && $("#hints-val").textContent === "2", "three quick taps down give 2");
$("#timer-on").checked = false; $("#timer-on").dispatchEvent(new w.Event("change", { bubbles: true }));
ok(await until(() => bobState.config.timerEnabled === false), "time limit switched off (keeps the test deterministic)");

console.log("built-in list round");
const chip = $$("#classics .chip").find((c) => c.dataset.id === "mountains"); click(chip);
ok($("#topic").value === "Highest mountains in the world" && chip.getAttribute("aria-pressed") === "true", "picking a built-in list fills the topic and marks it selected");
click($("#btn-start"));
ok(await until(() => !$("#score-setup-modal").hidden), "Start game opens player and scoring setup before list generation");
ok($('input[name="play-mode"][value="automatic"]').closest(".play-option").hidden && $('input[name="play-mode"][value="network"]').checked, "multiple lobby devices default to turn-taking with no presentation option");
click($("#score-setup-start"));
ok(await until(() => visible("#screen-game")), "game starts from a built-in list (no AI)");
ok($("#g-basis").textContent.includes("Height above sea level") && !$("#g-basis").textContent.includes("list)"), "basis shown, no difficulty label for built-ins");
ok(!$("#btn-source").hidden && $("#source-line").hidden && $("#btn-source").textContent === "Show source", "source is hidden until asked for");
click($("#btn-source"));
ok(!$("#source-line").hidden && /^Source: Wikipedia/.test($("#source-line").textContent) && !/AI-suggested/.test($("#source-line").textContent) && $("#source-line a").href.includes("duckduckgo.com/?q="), "source shown with a verify link; built-in lists aren't labelled AI-suggested");
ok($("#btn-source").getAttribute("aria-expanded") === "true", "toggle reports expanded");
ok(await until(() => $$("#feed li").some((l) => /Tester opened the source for this list/.test(l.textContent))), "opening the source shows up in the feed for everyone");
click($("#btn-source")); click($("#btn-source"));
await sleep(400);
ok($$("#feed li").filter((l) => /opened the source/.test(l.textContent)).length === 1 && w.localStorage.getItem("tf_source") === null, "reopening doesn't repeat the announcement and nothing is remembered between games");

console.log("hint voting");
ok(!$("#hint-bar").hidden && /Vote for a hint \(0\/2\)/.test($("#btn-hint").textContent), "hint bar shows 0 of 2 votes");
click($("#btn-hint"));
ok(await until(() => /Voted for a hint \(1\/2\)/.test($("#btn-hint").textContent)) && $("#btn-hint").getAttribute("aria-pressed") === "true", "my vote shows as 1 of 2");
ok($$(".plate-hint").length === 0, "no clue yet with one vote");
bsend({ t: "hint" });
ok(await until(() => $$(".plate-hint").length === 1), "clue appears once everyone votes");
ok($(".plate-hint").textContent === "Hint: 2 words, 12 letters, starts with M" && !$("#board").textContent.includes("Everest"), "clue narrows it down without naming the answer");
ok(/1 hint left/.test($("#hint-note").textContent), "one hint left");

console.log("guessing and reporting");
const turnIsMine = () => $("#guess-form").dataset.state === "mine";
const bobTurn = () => bobState && bobState.turnPid === bobPid;
async function ensureMyTurn() { for (let i = 0; i < 60 && !turnIsMine(); i++) { if (bobTurn()) { bsend({ t: "guess", text: "zzz-bob-" + i }); await sleep(250); } else await sleep(50); } return turnIsMine(); }
ok(await ensureMyTurn(), "got my turn");
submitGuess("everest");
ok(await until(() => $$("#board .plate.found").length === 1) && $("#board .plate.found .ans").textContent === "Mount Everest", "alias 'everest' reveals Mount Everest");
ok(await until(() => audioStarts === 2), "a newly correct answer plays the synthesized ding once");
ok(!$(".plate-hint") || $$(".plate-hint").length === 0, "the clue disappears once that answer is found");
const flag = $("#board .plate.found .flag"); ok(!!flag && flag.textContent === "Report", "found answers carry a Report link");
click(flag);
ok(visible("#report-modal") && /Report #1 Mount Everest/.test($("#report-title").textContent) && $$("#report-options input").length === 2, "report dialog opens with two reasons");
$$("#report-options input").find((i) => i.value === "rank").checked = true; click($("#report-send"));
ok($("#report-modal").hidden && await until(() => $("#board .plate.found .flag").textContent === "Reported" && $("#board .plate.found .flag").disabled), "report sent; link becomes 'Reported'");
ok(await until(() => /Flagged x1/.test($("#board .plate.found .sub").textContent)) && $$("#feed li").some((l) => /flagged #1 Mount Everest as ranked wrongly/.test(l.textContent)), "room sees the flag and the feed says why");
// a wrong guess by me -> tap the chip -> report as rejected
ok(await ensureMyTurn(), "my turn again");
submitGuess("Mont Blanc");
ok(await until(() => $$("#wrong .chip-x").some((c) => c.dataset.guess === "Mont Blanc")), "wrong guess appears under 'Already tried'");
const wrongChip = $$("#wrong .chip-x").find((c) => c.dataset.guess === "Mont Blanc"); click(wrongChip);
ok(visible("#report-modal") && /Mont Blanc/.test($("#report-text").textContent) && $$("#report-options input").length === 0, "tapping a rejected guess opens the 'should have counted' report");
click($("#report-send"));
ok(await until(() => $$("#wrong .chip-x").find((c) => c.dataset.guess === "Mont Blanc")?.disabled === true), "that chip is marked as reported");

console.log("finish and results");
const names = ["Everest","K2","Kangchenjunga","Lhotse","Makalu","Cho Oyu","Dhaulagiri","Manaslu","Nanga Parbat","Annapurna"];
for (let g = 0; g < 60 && !visible("#results"); g++) {
  const idx = $$("#board .plate").findIndex((p) => !p.classList.contains("found")); if (idx < 0) break;
  if (turnIsMine()) submitGuess(names[idx]); else if (bobTurn()) bsend({ t: "guess", text: names[idx] });
  await sleep(200);
}
ok(await until(() => visible("#results")), "results panel when the board is cleared");
ok($("#btn-source").hidden && !$("#source-line").hidden, "after the game the source is always shown");
ok($$("#board .plate").every((p) => p.classList.contains("found") || p.classList.contains("missed")) && $$("#board .flag").length === 10, "every answer is revealed and reportable");
ok(visible("#results") && !$("#btn-rematch").hidden, "host can play again");
click($("#btn-rematch"));
ok(await until(() => visible("#screen-lobby")) && $$("#classics .chip").length === 6, "back in the lobby with built-in lists offered again");

console.log("AI round with Hard difficulty");
bobWs.close();
ok(await until(() => $("#lobby-players .tag-away")), "the lobby updates when the other device disconnects");
click($("#btn-custom-list"));
ok(!$("#custom-answers").hidden && $$("#custom-answer-fields [data-manual-answer]").length === 10 && $("#topic-label").textContent === "Category / list title" && $(".topic-tools").hidden && $("#classics-wrap").hidden, "custom-list mode offers ten ranked answer fields");
$("#topic").value = "My custom category";
for (const [index, input] of $$("#custom-answer-fields [data-manual-answer]").entries()) input.value = `Custom answer ${index + 1}`;
click($("#btn-start"));
ok(await until(() => !$("#score-setup-modal").hidden) && !$("#solo-setup").hidden && $("#score-setup-title").textContent === "Ready to play solo?", "curated list setup is designed for solo play after pressing Start game");
ok($('input[name="play-mode"][value="network"]').closest(".play-option").hidden, "a one-device lobby does not show the device-to-device option");
ok($("#score-setup-start").textContent === "Start solo game" && !$("#score-roster-details").open, "solo play is the primary action and scoring setup is optional");
ok($("#solo-setup").classList.contains("selected") && !$("#solo-setup-description").hidden && !$("#score-roster-details").classList.contains("selected"), "solo is highlighted with its description when setup opens");
click($("#score-roster-details summary"));
ok(await until(() => $("#score-roster-details").open && $("#score-roster-details").classList.contains("selected")), "opening Add teammates highlights the teammate option");
ok(!$("#solo-setup").classList.contains("selected") && $("#solo-setup-description").hidden, "selecting teammates removes the solo highlight and description");
click($("#score-roster-details summary"));
ok(await until(() => !$("#score-roster-details").open && $("#solo-setup").classList.contains("selected") && !$("#solo-setup-description").hidden), "closing Add teammates restores the solo highlight and description");
click($("#score-roster-details summary"));
await until(() => $("#score-roster-details").open);
click($("#solo-setup"));
ok(await until(() => !$("#score-roster-details").open && $("#solo-setup").classList.contains("selected")), "clicking Play solo selects it again and deselects teammates");
ok($("#solo-setup").getAttribute("aria-pressed") === "true", "solo selection is exposed accessibly");
click($("#score-roster-details summary"));
await until(() => $("#score-roster-details").open);
$("#score-player-name").value = "Local guest";
$("#score-player-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
ok($$("#local-score-players li").length === 1 && $("#score-setup-start").textContent === "Start scored game", "adding a local player automatically enables scoring");
click($("#score-setup-start"));
ok(await until(() => visible("#screen-game"), 8000) && $("#g-title").textContent === "My custom category" && $("#g-basis").textContent.includes("Player-created list"), "the manual category starts as a player-created list");
ok($$("#players .player").length === 2 && $$("#players .player").some((p) => p.textContent.includes("Local guest")), "the leader and locally added player are included in the score roster");
const manualAnswers = Array.from({ length: 10 }, (_, i) => `Custom answer ${i + 1}`);
for (let i = 0; i < manualAnswers.length; i++) {
  ok(await until(() => turnIsMine()), `leader can enter custom answer ${i + 1} for the current player`);
  submitGuess(manualAnswers[i]);
  ok(await until(() => $$("#board .plate.found").length >= i + 1 || visible("#results")), `custom answer ${i + 1} is accepted`);
}
ok(await until(() => visible("#results")), "the custom round completes normally");
click($("#btn-rematch"));
ok(await until(() => visible("#screen-lobby")), "rematch returns to the lobby after custom play");
$("#topic").value = "Audience category";
for (const [index, input] of $$("#custom-answer-fields [data-manual-answer]").entries()) input.value = `Audience answer ${index + 1}`;
click($("#btn-start"));
ok(await until(() => !$("#score-setup-modal").hidden), "player setup appears after pressing Start game");
ok(!$("#score-roster-details").open && $("#solo-setup").classList.contains("selected") && !$("#solo-setup-description").hidden, "a new setup defaults back to the highlighted solo option");
$("#score-roster-details").open = true;
click($("#local-score-players [data-remove-local-player]"));
ok($("#score-setup-start").textContent === "Start solo game", "without additional players the start action is a no-score solo game");
click($("#score-setup-start"));
ok($("#score-setup-modal").hidden, "solo setup closes immediately when the game starts");
ok(await until(() => visible("#screen-game") && !$("#play-mode-note").hidden), "the curated list can also be started in no-score audience mode");
ok($("#btn-hint").textContent === "Reveal hint" && !/vote/i.test($("#hint-note").textContent), "solo presentation offers a direct reveal-hint action without voting text");
ok($("#guess").placeholder === "Take a guess", "solo guess input prompts the player to take a guess");
ok($("#turnbar").hidden && $("#players").hidden && !$("#play-mode-note").hidden, "audience mode is presented without turn or score UI");
const livesAtStart = $$("#players .player").length;
submitGuess("Audience wrong guess");
ok(await until(() => $$("#wrong .chip-x").some((chip) => chip.textContent === "Audience wrong guess")) && $$("#players .player").length === livesAtStart, "audience wrong guesses do not cost lives");
await sleep(1100);
for (let i = 0; i < 10; i++) {
  await sleep(120);
  submitGuess(`Audience answer ${i + 1}`);
  ok(await until(() => $$("#board .plate.found").length >= i + 1 || visible("#results")), `audience finds answer ${i + 1}`);
}
ok(await until(() => visible("#results")) && $("#res-title").textContent.includes("audience found all 10") && $("#res-list").hidden, "audience clears the board without a score table");
click($("#btn-rematch"));
ok(await until(() => visible("#screen-lobby")), "audience round can be rematched");
click($("#btn-custom-list"));
click($(".seg[data-diff=hard]"));
click($("#topic-chips .chip"));
click($("#btn-start"));
ok(await until(() => !$("#score-setup-modal").hidden), "AI list enters player setup before generation");
click($("#score-setup-start"));
ok(await until(() => visible("#screen-game") && !$("#play-mode-note").hidden, 8000), "AI list starts an audience presentation in a solo lobby");
ok(/\(hard list\)/.test($("#g-basis").textContent), "header labels it a hard list: " + $("#g-basis").textContent);
ok($("#source-line").hidden, "the source starts hidden again in the next game");
click($("#btn-source"));
ok(/AI-suggested source, not verified/.test($("#source-line").textContent), "AI source is clearly labelled as unverified");

click($("#btn-leave")); ok(visible("#screen-home"), "leave returns home");
ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log(failures ? `\n${failures} FAILURE(S)` : "\nUI CHECKS PASSED");
process.exit(failures ? 1 : 0);
