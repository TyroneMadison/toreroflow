import assert from "node:assert/strict";
import { median, rankClips, rawScore, shownScore } from "./clipScore";

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

ok("raw sums the four sub-scores", () => assert.equal(rawScore({ hook: 9, flow: 8, value: 7, trend: 6 }), 30));
ok("raw clamps and rounds", () => assert.equal(rawScore({ hook: 12, flow: -1, value: 7.6, trend: NaN }), 18));
ok("prompt blends relevance", () =>
  assert.equal(rawScore({ hook: 9, flow: 9, value: 8, trend: 8, relevance: 7 }, true), Math.round(0.8 * 34 + 0.2 * 28)));
ok("prompt without relevance keeps base", () => assert.equal(rawScore({ hook: 5, flow: 5, value: 5, trend: 5 }, true), 20));
ok("relevance ignored without prompt", () =>
  assert.equal(rawScore({ hook: 5, flow: 5, value: 5, trend: 5, relevance: 0 }), 20));
ok("shown top is 99", () => assert.equal(shownScore(1, 20), 99));
ok("shown bottom is 59", () => assert.equal(shownScore(20, 20), 59));
ok("shown single is 99", () => assert.equal(shownScore(1, 1), 99));
ok("shown median of 21 is 79", () => assert.equal(shownScore(11, 21), 79));
ok("rank by raw then hook then flow", () => {
  const r = rankClips([
    { id: "a", hook: 5, flow: 9, value: 5, trend: 5 },
    { id: "b", hook: 9, flow: 5, value: 5, trend: 5 },
    { id: "c", hook: 9, flow: 9, value: 9, trend: 9 },
    { id: "d", hook: 9, flow: 6, value: 4, trend: 5 },
  ]);
  assert.deepEqual(r.map((x) => x.item.id), ["c", "d", "b", "a"]);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3, 4]);
  assert.equal(r[0].score, 99);
  assert.equal(r[3].score, 59);
});
ok("rank stable on full ties", () => {
  const r = rankClips([
    { id: "x", hook: 5, flow: 5, value: 5, trend: 5 },
    { id: "y", hook: 5, flow: 5, value: 5, trend: 5 },
  ]);
  assert.deepEqual(r.map((x) => x.item.id), ["x", "y"]);
});
ok("rank empty", () => assert.deepEqual(rankClips([]), []));
ok("median", () => {
  assert.equal(median([1, 9, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), 0);
});

console.log(`clipScore.check: ${passed} passed`);
