/**
 * Quiet fair-play checks for the daily challenge.
 *
 * The browser reports a few facts about how each answer was entered (never what else is on the
 * screen or in the clipboard). None of these is proof on its own: password managers, voice
 * dictation and assistive tools can look unusual. So signals only add up to a "risk" score, and a
 * high score sends the attempt to a person for review instead of acting automatically.
 */
export interface Signals {
  /** The answer was pasted or dropped into the box. */
  paste: boolean;
  /** Number of key presses while typing it. */
  keys: number;
  /** Milliseconds from the first key press to submitting. */
  typeMs: number;
  /** Milliseconds this tab was hidden or unfocused during the turn. */
  blurMs: number;
  /** Milliseconds between the tab coming back into focus and submitting. */
  refocusMs: number;
  /** Characters submitted. */
  len: number;
}

export interface Assessment {
  weight: number;
  flags: string[];
}

/** Total risk at or above this holds the attempt for review. */
export const REVIEW_THRESHOLD = 4;

const clamp = (v: unknown, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(max, Math.max(0, n));
};

export function cleanSignals(raw: any, len: number): Signals {
  return {
    paste: raw?.paste === true,
    keys: clamp(raw?.keys, 500),
    typeMs: clamp(raw?.typeMs, 600_000),
    blurMs: clamp(raw?.blurMs, 600_000),
    refocusMs: clamp(raw?.refocusMs, 600_000),
    len,
  };
}

export function assessGuess(sig: Signals, ctx: { correct: boolean; rank: number; elapsedMs: number }): Assessment {
  let weight = 0;
  const flags: string[] = [];
  const add = (w: number, f: string) => { weight += w; flags.push(f); };

  if (sig.paste) add(2, "paste");
  else if (sig.len >= 6 && sig.keys === 0) add(2, "no-typing");
  else if (sig.len >= 8 && sig.keys > 0 && sig.typeMs > 0 && sig.typeMs < sig.len * 35) add(2, "superhuman-typing");

  if (ctx.correct && sig.blurMs >= 2500 && sig.refocusMs <= 4000) add(1, "tab-away-then-answer");
  if (ctx.correct && ctx.rank >= 8 && ctx.elapsedMs < 1500) add(1, "instant-hard-answer");
  return { weight, flags };
}

/** Checks that only make sense once the whole attempt is known. */
export function assessAttempt(found: { rank: number; ms: number }[], wrong: number): Assessment {
  if (found.length === 10 && wrong === 0) {
    const sorted = found.map((f) => f.ms).sort((a, b) => a - b);
    const median = (sorted[4] + sorted[5]) / 2;
    if (median < 5000) return { weight: 2, flags: ["flawless-and-fast"] };
  }
  return { weight: 0, flags: [] };
}
