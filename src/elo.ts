/**
 * Elo-style ratings for ranked 1v1.
 *
 * Your expected score depends on the rating gap, and your rating moves by K x (actual - expected).
 * Beating a stronger player earns more than beating a weaker one, and losing to a weaker player costs more.
 * Players with fewer than 20 rated games have a higher K, so new ratings settle quickly.
 * (chess.com uses Glicko, which adds a "rating deviation" instead of a fixed K; this is the simpler cousin.)
 */
export const START_RATING = 1200;
export const MIN_RATING = 100;
export const PROVISIONAL_GAMES = 20;

/** Chance (0 to 1) that a player rated `ra` beats a player rated `rb`. */
export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function kFactor(gamesPlayed: number): number {
  return gamesPlayed < PROVISIONAL_GAMES ? 40 : 20;
}

export interface Side {
  rating: number;
  games: number;
}

/** `scoreA` is 1 if A won, 0 if A lost and 0.5 for a draw. Returns each side's rating change. */
export function ratingChange(a: Side, b: Side, scoreA: number): { aDelta: number; bDelta: number } {
  const ea = expectedScore(a.rating, b.rating);
  const eb = 1 - ea;
  const rawA = Math.round(kFactor(a.games) * (scoreA - ea));
  const rawB = Math.round(kFactor(b.games) * (1 - scoreA - eb));
  // Never drop below the floor.
  const aDelta = Math.max(rawA, MIN_RATING - a.rating);
  const bDelta = Math.max(rawB, MIN_RATING - b.rating);
  return { aDelta, bDelta };
}
