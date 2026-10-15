/** Read a number from a wrangler var (which may arrive as a string or a number). */
export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

// No 0/O/1/I so codes are easy to read out loud.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
