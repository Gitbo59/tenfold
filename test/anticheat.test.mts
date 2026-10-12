import { assessGuess, assessAttempt, cleanSignals, REVIEW_THRESHOLD } from "../src/anticheat.ts";
let failures = 0; const ok = (c: boolean, m: string) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const human = { paste: false, keys: 8, typeMs: 1400, blurMs: 0, refocusMs: 99999, len: 8 };
const flags = (s: any, c: any = { correct: true, rank: 3, elapsedMs: 6000 }) => assessGuess({ ...human, ...s }, c).flags.join(",");
const weight = (s: any, c: any = { correct: true, rank: 3, elapsedMs: 6000 }) => assessGuess({ ...human, ...s }, c).weight;

console.log("single guesses");
ok(weight({}) === 0, "ordinary typing scores nothing");
ok(flags({ paste: true }) === "paste" && weight({ paste: true }) === 2, "a pasted answer adds 2");
ok(flags({ keys: 0 }) === "no-typing", "text with no key presses at all is flagged");
ok(flags({ keys: 0, len: 4 }) === "", "...but not for very short answers");
ok(flags({ typeMs: 100 }) === "superhuman-typing", "8 characters typed in 0.1s is flagged");
ok(flags({ typeMs: 400 }) === "", "fast but possible typing is not flagged");
ok(flags({ blurMs: 5000, refocusMs: 1500 }) === "tab-away-then-answer", "leaving the tab, coming back and answering fast is flagged");
ok(flags({ blurMs: 5000, refocusMs: 30000 }) === "", "...but not if they took a while after returning");
ok(flags({ blurMs: 5000, refocusMs: 1500 }, { correct: false, rank: 0, elapsedMs: 5000 }) === "", "a wrong answer after leaving the tab isn't flagged");
ok(flags({}, { correct: true, rank: 9, elapsedMs: 900 }) === "instant-hard-answer", "a hard answer in under 1.5s is flagged");
ok(flags({}, { correct: true, rank: 2, elapsedMs: 900 }) === "", "an easy answer in under 1.5s is fine");
ok(weight({ paste: true }) < REVIEW_THRESHOLD && weight({ paste: true, blurMs: 5000, refocusMs: 1000 }) < REVIEW_THRESHOLD, "one paste (even with a tab switch) doesn't reach the review threshold");
ok(weight({ paste: true }) * 2 >= REVIEW_THRESHOLD, "two pastes do");

console.log("whole attempts and input cleaning");
const run = (ms: number) => Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, ms }));
ok(assessAttempt(run(3000), 0).flags[0] === "flawless-and-fast", "all ten, no misses, ~3s each is flagged");
ok(assessAttempt(run(9000), 0).weight === 0 && assessAttempt(run(3000), 1).weight === 0 && assessAttempt(run(3000).slice(0, 9), 0).weight === 0, "slower, imperfect or incomplete runs are not");
const c = cleanSignals({ paste: "yes", keys: -5, typeMs: 1e12, blurMs: NaN, refocusMs: "x" }, 7);
ok(c.paste === false && c.keys === 0 && c.typeMs === 600000 && c.blurMs === 0 && c.refocusMs === 0 && c.len === 7, "hostile or malformed signals are clamped safely");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nANTI-CHEAT CHECKS PASSED"); process.exit(failures ? 1 : 0);
