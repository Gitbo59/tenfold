/** Read a number from a wrangler var (which may arrive as a string or a number). */
export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}
