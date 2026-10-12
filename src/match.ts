export interface Found {
  by: string;
  points: number;
  speed: number;
  streak: number;
}

export interface Answer {
  answer: string;
  aliases: string[];
  detail?: string;
  found?: Found;
  /** How many players in this room flagged the answer. */
  reports?: number;
}

export type Match =
  | { kind: "hit"; index: number; /** false when it was a typo or a partial name */ exact: boolean }
  | { kind: "dupe"; index: number }
  | { kind: "miss" };

/** Lower-case, strip accents/punctuation/leading articles so "The Beatles!" == "beatles". */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Short answers must be exact; longer ones tolerate a typo or two. */
function allowedDistance(len: number): number {
  if (len < 5) return 0;
  if (len < 9) return 1;
  return 2;
}

// Words that carry no meaning on their own, and descriptors that shouldn't make a guess count by themselves
// ("Lake" must not match "Lake Victoria", but "Victoria" should).
const STOP = new Set(["the", "a", "an", "of", "and", "de", "la", "le", "el", "al", "von", "van", "da", "di", "du", "del", "y"]);
const GENERIC = new Set([
  "lake", "mount", "mountain", "mt", "island", "islands", "isle", "river", "sea", "ocean", "bay", "gulf", "city", "town",
  "republic", "kingdom", "state", "states", "united", "new", "north", "south", "east", "west", "northern", "southern",
  "eastern", "western", "great", "greater", "little", "saint", "st", "san", "santa", "fc", "club", "national",
  "international", "democratic", "federal", "federation", "empire", "king", "queen", "prince", "princess", "sir",
  "lord", "dr", "mr", "mrs", "ms", "mister", "miss",
]);

const sig = (s: string): string[] => s.split(" ").filter((t) => t && !STOP.has(t));

function tokenEq(a: string, b: string): boolean {
  if (a === b) return true;
  const allowed = allowedDistance(Math.min(a.length, b.length));
  return allowed > 0 && levenshtein(a, b, allowed) <= allowed;
}

/**
 * Decides whether a guess counts.
 *  1. Exact match on the answer or an alias, ignoring case, accents and punctuation.
 *  2. A small typo (longer answers tolerate more).
 *  3. A partial name: every meaningful word of the guess appears in one answer ("Everest" for "Mount Everest"),
 *     or the guess is the answer plus only descriptive filler ("Lake Victoria" for "Victoria").
 *     If a partial guess could mean more than one answer it doesn't count. Guesses with extra
 *     meaningful words ("Chad Kenya") never count, so players can't hedge.
 */
export function matchGuess(guessRaw: string, answers: Answer[]): Match {
  const g = normalize(guessRaw);
  if (!g) return { kind: "miss" };

  const result = (index: number, exact: boolean): Match =>
    answers[index].found ? { kind: "dupe", index } : { kind: "hit", index, exact };

  // 1 and 2: exact or typo
  let best: { index: number; dist: number } | null = null;
  answers.forEach((a, index) => {
    for (const form of [a.answer, ...a.aliases]) {
      const f = normalize(form);
      if (!f) continue;
      const allowed = allowedDistance(f.length);
      const d = levenshtein(g, f, allowed);
      if (d > allowed) continue;
      const better =
        !best ||
        d < best.dist ||
        // On a tie, prefer an answer that hasn't been found yet.
        (d === best.dist && answers[best.index].found && !a.found);
      if (better) best = { index, dist: d };
    }
  });
  if (best) {
    const hit = best as { index: number; dist: number };
    return result(hit.index, hit.dist === 0);
  }

  // 3: partial name
  const gs = sig(g);
  if (!gs.length) return { kind: "miss" };
  if (gs.length === 1 && GENERIC.has(gs[0])) return { kind: "miss" };
  if (gs.every((t) => t.length < 3 && !/\d/.test(t))) return { kind: "miss" };

  const candidates = new Set<number>();
  answers.forEach((a, index) => {
    for (const form of [a.answer, ...a.aliases]) {
      const as = sig(normalize(form));
      if (!as.length) continue;
      const forward = gs.every((t) => as.some((u) => tokenEq(t, u)));
      const reverse =
        as.every((u) => gs.some((t) => tokenEq(t, u))) &&
        gs.filter((t) => !as.some((u) => tokenEq(t, u))).every((t) => GENERIC.has(t));
      if (forward || reverse) {
        candidates.add(index);
        break;
      }
    }
  });
  if (candidates.size !== 1) return { kind: "miss" };
  return result([...candidates][0], false);
}
