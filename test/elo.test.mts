import { expectedScore, kFactor, ratingChange, START_RATING, MIN_RATING } from "../src/elo.ts";
let failures = 0; const ok = (c: boolean, m: string) => { console.log(c ? "  PASS" : "  FAIL", m); if (!c) failures++; };
const near = (a: number, b: number, e = 0.001) => Math.abs(a - b) < e;

console.log("expected scores");
ok(near(expectedScore(1200, 1200), 0.5), "equal ratings: 50%");
ok(near(expectedScore(1600, 1200), 10 / 11, 0.001), "400 points higher: about 91%");
ok(near(expectedScore(1200, 1600) + expectedScore(1600, 1200), 1), "the two sides' expectations add up to 1");
ok(expectedScore(1500, 1200) > expectedScore(1300, 1200), "a bigger gap means a bigger expectation");

console.log("rating changes");
const vet = (r: number) => ({ rating: r, games: 50 });
const nw = (r: number) => ({ rating: r, games: 0 });
let c = ratingChange(vet(1200), vet(1200), 1);
ok(c.aDelta === 10 && c.bDelta === -10, "equal veterans: winner +10, loser -10 (K=20)");
c = ratingChange(nw(1200), nw(1200), 1);
ok(c.aDelta === 20 && c.bDelta === -20, "equal new players move twice as fast (K=40)");
c = ratingChange(vet(1200), vet(1200), 0.5);
ok(c.aDelta === 0 && c.bDelta === 0, "a draw between equals changes nothing");

console.log("weighted by the opponent's rating (the point of Elo)");
const upset = ratingChange(vet(1200), vet(1600), 1);
const expected = ratingChange(vet(1600), vet(1200), 1);
ok(upset.aDelta > expected.aDelta * 5, `beating a player 400 higher earns +${upset.aDelta}; beating one 400 lower earns only +${expected.aDelta}`);
ok(upset.bDelta === -upset.aDelta && expected.bDelta === -expected.aDelta, "between two veterans it is zero-sum");
const lossToWeaker = ratingChange(vet(1600), vet(1200), 0);
ok(lossToWeaker.aDelta < -15, `losing to a much weaker player costs a lot (${lossToWeaker.aDelta})`);
const drawUp = ratingChange(vet(1200), vet(1400), 0.5);
ok(drawUp.aDelta > 0 && drawUp.bDelta < 0, "drawing with a stronger player gains points; the stronger one loses some");

console.log("provisional and floor");
ok(kFactor(0) === 40 && kFactor(19) === 40 && kFactor(20) === 20 && kFactor(500) === 20, "K is 40 for the first 20 games, then 20");
const mixed = ratingChange(nw(1200), vet(1200), 1);
ok(mixed.aDelta === 20 && mixed.bDelta === -10, "a new player beating a veteran gains more than the veteran loses");
const floor = ratingChange({ rating: MIN_RATING + 3, games: 50 }, { rating: MIN_RATING + 3, games: 50 }, 0);
ok(floor.aDelta === -3 && MIN_RATING + 3 + floor.aDelta === MIN_RATING, "ratings never fall below " + MIN_RATING + " (a -10 loss is trimmed to -3)");
ok(START_RATING === 1200, "new players start at 1200");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nRATING CHECKS PASSED"); process.exit(failures ? 1 : 0);
