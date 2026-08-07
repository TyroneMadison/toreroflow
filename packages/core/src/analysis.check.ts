import assert from "node:assert/strict";
import { SCORE_BANDS, bandFor, momentKind, peakScore } from "./analysis";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * What is pinned here is the rubric's arithmetic, because that is the part a
 * later edit could soften without anyone noticing: the 40/35/25 weighting, the
 * hook cap, and the band cut points. A score that drifts upward flatters the
 * creator and stops being worth reading.
 */

/* ---- the weighting ---- */

assert.equal(peakScore(100, 100, 100), 100);
assert.equal(peakScore(0, 0, 0), 0);
assert.equal(peakScore(60, 60, 60), 60, "equal dials give their own value back");

// Hook is worth more than retention, which is worth more than payoff. Move the
// same points between two dials and the peak proves the ordering.
assert.ok(
  peakScore(70, 50, 50) > peakScore(50, 70, 50),
  "twenty points on the hook beat twenty on retention",
);
assert.ok(
  peakScore(50, 70, 50) > peakScore(50, 50, 70),
  "twenty points on retention beat twenty on payoff",
);
assert.equal(peakScore(80, 60, 40), Math.round(0.4 * 80 + 0.35 * 60 + 0.25 * 40));

/* ---- rounding at the boundary ---- */

assert.equal(peakScore(40, 40, 42), 41, "an exact .5 rounds up (40.5)");
assert.equal(peakScore(41, 40, 40), 40, "40.4 rounds down");
assert.equal(peakScore(40, 41, 42), 41, "40.85 rounds up");
assert.ok(Number.isInteger(peakScore(63, 47, 81)), "the peak is always an integer");

/* ---- the cap, which is the whole point of the hook weighting ---- */

assert.equal(
  peakScore(39, 100, 100),
  55,
  "a video nobody stops for cannot peak, however good the rest is",
);
assert.equal(peakScore(0, 100, 100), 55, "no hook at all is capped the same way");
assert.equal(peakScore(40, 100, 100), 76, "exactly 40 is not below 40, so no cap");
assert.equal(
  peakScore(39, 10, 10),
  Math.round(0.4 * 39 + 0.35 * 10 + 0.25 * 10),
  "the cap is a ceiling, not a floor: a weak video keeps its low score",
);

/* ---- rubbish in ---- */

assert.equal(peakScore(200, 200, 200), 100, "scores above the scale clamp");
assert.equal(peakScore(-50, 50, 50), 30, "a negative hook clamps to 0, then caps");
assert.equal(peakScore(Number.NaN, 50, 50), 30, "a missing dial reads as 0, never as NaN");

/* ---- bands ---- */

assert.equal(bandFor(90, "hook"), "Excellent");
assert.equal(bandFor(80, "hook"), "Excellent", "80 is the excellent cut point");
assert.equal(bandFor(79, "retention"), "Good");
assert.equal(bandFor(60, "retention"), "Good");
assert.equal(bandFor(59, "payoff"), "Average");
assert.equal(bandFor(40, "payoff"), "Average", "40 is where average starts, per the rubric");
assert.equal(bandFor(39, "payoff"), "Failing", "and 39 is failing");
assert.equal(bandFor(0, "hook"), "Failing");

// The three gauges read the same ladder. If one ever needs its own, the table
// is per dial already, but nothing may quietly diverge without touching this.
for (const s of [0, 39, 40, 59, 60, 79, 80, 100]) {
  assert.equal(bandFor(s, "hook"), bandFor(s, "retention"));
  assert.equal(bandFor(s, "hook"), bandFor(s, "payoff"));
}

/* ---- the peak ladder is its own, and harsher in the middle ---- */

assert.equal(bandFor(35), "Average", "the default dial is peak");
assert.equal(bandFor(35, "peak"), "Average");
assert.equal(bandFor(20), "Broken");
assert.equal(bandFor(21), "Weak");
assert.equal(bandFor(34), "Weak");
assert.equal(bandFor(50), "Average", "a 50 is still only average on the peak ladder");
assert.equal(bandFor(51), "Above average");
assert.equal(bandFor(59), "Above average");
assert.equal(bandFor(60), "Good");
assert.equal(bandFor(75), "Good");
assert.equal(bandFor(76), "Very good");
assert.equal(bandFor(84), "Very good");
assert.equal(bandFor(85), "Exceptional", "reserved, and it starts at 85");
assert.equal(bandFor(100), "Exceptional");
assert.notEqual(
  bandFor(55, "peak"),
  bandFor(55, "hook"),
  "the same number reads differently as a peak and as a dial, so the tables stay separate",
);

/* ---- every table covers 0 to 100 with no gap and no overlap ---- */

for (const [dial, bands] of Object.entries(SCORE_BANDS)) {
  assert.equal(bands[0].min, 0, `${dial} starts at 0`);
  assert.equal(bands[bands.length - 1].max, 100, `${dial} ends at 100`);
  bands.forEach((b, i) => {
    assert.ok(b.max >= b.min, `${dial} band ${i} is not inside out`);
    if (i > 0) assert.equal(b.min, bands[i - 1].max + 1, `${dial} band ${i} joins the one before`);
  });
  for (let s = 0; s <= 100; s++) {
    assert.equal(bands.filter((b) => s >= b.min && s <= b.max).length, 1, `${dial} labels ${s} once`);
  }
}

// Out of range still gets a word rather than undefined; the gauge always draws.
assert.equal(bandFor(140), "Exceptional");
assert.equal(bandFor(-1), "Broken");
assert.equal(bandFor(Number.NaN), "Broken");

/* ---- moment kinds ---- */

assert.equal(momentKind("strong"), "strong");
assert.equal(momentKind("STRONG"), "strong", "the rubric writes it in capitals");
assert.equal(momentKind(" Strong "), "strong");
assert.equal(momentKind("risk"), "risk");
assert.equal(momentKind("RISK"), "risk");
assert.equal(momentKind("drop-off"), "risk");
assert.equal(momentKind(""), "risk");
assert.equal(momentKind(undefined), "risk", "anything unreadable draws red, not white");
assert.equal(momentKind(null), "risk");
assert.equal(momentKind(7), "risk");

console.log("analysis.check.ts: ok");
