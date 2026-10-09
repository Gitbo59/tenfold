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
}

export type Match =
  | { kind: "hit"; index: number }
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

export function matchGuess(guessRaw: string, answers: Answer[]): Match {
  const g = normalize(guessRaw);
  if (!g) return { kind: "miss" };

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

  if (!best) return { kind: "miss" };
  const hit = best as { index: number; dist: number };
  return answers[hit.index].found
    ? { kind: "dupe", index: hit.index }
    : { kind: "hit", index: hit.index };
}
