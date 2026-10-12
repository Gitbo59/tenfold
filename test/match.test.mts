import { matchGuess, type Answer } from "../src/match.ts";
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const A = (answer: string, aliases: string[] = []): Answer => ({ answer, aliases });
const kind = (g: string, list: Answer[]) => { const m = matchGuess(g, list); return m.kind === "hit" ? `hit:${m.index}:${m.exact ? "exact" : "close"}` : m.kind === "dupe" ? `dupe:${m.index}` : "miss"; };

const peaks = [A("Mount Everest"), A("K2"), A("Nanga Parbat"), A("Great Bear Lake")];
console.log("exact and typos");
ok(kind("mount everest", peaks) === "hit:0:exact", "exact (case-insensitive) is flagged exact");
ok(kind("Mount Evrest", peaks) === "hit:0:close", "a typo is accepted but flagged close");
ok(kind("k2", peaks) === "hit:1:exact", "short answers need to be exact");
ok(kind("k3", peaks) === "miss", "...and don't accept near-misses");

console.log("partial names");
ok(kind("Everest", peaks) === "hit:0:close", "'Everest' counts for 'Mount Everest' with no alias needed");
ok(kind("Parbat", peaks) === "hit:2:close", "'Parbat' counts for 'Nanga Parbat'");
ok(kind("Evrest", peaks) === "hit:0:close", "a typo inside a partial name still counts");
ok(kind("Bear", peaks) === "hit:3:close", "'Bear' counts for 'Great Bear Lake'");
ok(kind("Lake Bear", peaks) === "hit:3:close", "word order doesn't matter for a partial name");
ok(kind("Mount", peaks) === "miss" && kind("Lake", peaks) === "miss" && kind("Great", peaks) === "miss", "generic words alone never count");
ok(kind("of the", peaks) === "miss" && kind("st", peaks) === "miss", "filler and tiny words never count");

console.log("descriptive extras, ambiguity, hedging");
const places = [A("Victoria"), A("Chad"), A("United States of America"), A("United Arab Emirates")];
ok(kind("Lake Victoria", places) === "hit:0:close", "'Lake Victoria' counts for 'Victoria' (filler word added)");
ok(kind("Republic of Chad", places) === "hit:1:close", "'Republic of Chad' counts for 'Chad'");
ok(kind("United States", places) === "hit:2:close", "'United States' counts for 'United States of America'");
ok(kind("United", places) === "miss", "'United' is ambiguous and generic, so it doesn't count");
ok(kind("Chad Kenya", places) === "miss", "two names in one guess never count (no hedging)");
ok(kind("Chad Victoria", places) === "miss", "...even when both are on the list");
const players = [A("Harry Kane"), A("Kane Williamson"), A("Harry Maguire")];
ok(kind("Kane", players) === "miss" && kind("Harry", players) === "miss", "a name that fits two answers doesn't count");
ok(kind("Maguire", players) === "hit:2:close" && kind("Williamson", players) === "hit:1:close", "...but a surname that fits one does");

console.log("exact beats partial; found answers");
const africa = [A("Guinea"), A("Equatorial Guinea"), A("Niger"), A("Nigeria")];
ok(kind("Guinea", africa) === "hit:0:exact" && kind("Equatorial Guinea", africa) === "hit:1:exact", "an exact answer wins over a partial one");
ok(kind("Niger", africa) === "hit:2:exact" && kind("Nigeria", africa) === "hit:3:exact", "similar names stay distinct");
const found: Answer[] = [{ ...A("Mount Everest"), found: { by: "x", points: 1, speed: 0, streak: 0 } }, A("K2")];
ok(kind("Everest", found) === "dupe:0", "a partial guess at an already-found answer is a free retry");
ok(kind("", found) === "miss" && kind("   ", found) === "miss", "empty guesses never count");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nMATCHING CHECKS PASSED");
process.exit(failures ? 1 : 0);
