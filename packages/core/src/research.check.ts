import assert from "node:assert/strict";
import {
  estimateCents,
  isResearchPlatform,
  isStale,
  normalizeHandle,
  platformsFor,
  RESEARCH_PLATFORMS,
  withinBudget,
  type PlannedFetch,
} from "./research";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * Two things are pinned here because both spend real money or point research
 * at a real stranger: the ceiling can never be exceeded, and every way a
 * client might write the same handle has to reduce to the same account.
 */

/* ---- handles ---- */

// Every one of these is the same account and must resolve once, not six times.
for (const written of [
  "carguy",
  "@carguy",
  "@@carguy",
  "  CarGuy  ",
  "https://www.instagram.com/carguy/",
  "instagram.com/carguy",
  "https://www.tiktok.com/@carguy",
  "tiktok.com/@carguy?lang=en",
]) {
  assert.equal(normalizeHandle(written), "carguy", `did not normalise: ${written}`);
}

assert.equal(normalizeHandle(""), "");
assert.equal(normalizeHandle("   "), "");
assert.equal(normalizeHandle("real.car_guy1"), "real.car_guy1", "legal handle characters survive");

/* ---- platform answers ---- */

assert.deepEqual(platformsFor("instagram"), ["instagram"]);
assert.deepEqual(platformsFor("tiktok"), ["tiktok"]);
assert.deepEqual(platformsFor("both"), ["instagram", "tiktok"]);
// Blank, missing, or a value from a future version of the form: research both
// rather than silently researching nobody.
for (const answer of ["", null, undefined, "Both", "youtube", "  "]) {
  assert.deepEqual(platformsFor(answer), ["instagram", "tiktok"], `answer: ${String(answer)}`);
}

for (const p of RESEARCH_PLATFORMS) assert.equal(isResearchPlatform(p), true);
assert.equal(isResearchPlatform("youtube"), false, "youtube is deliberately out of scope");
assert.equal(isResearchPlatform(null), false);

/* ---- cost ---- */

const unresolved = (handle: string): PlannedFetch => ({
  platform: "instagram",
  handle,
  resolved: false,
});
const resolved = (handle: string): PlannedFetch => ({
  platform: "tiktok",
  handle,
  resolved: true,
});

// An unresolved account is two calls, a resolved one is a single call.
assert.equal(estimateCents([unresolved("a")], 1), 2);
assert.equal(estimateCents([resolved("a")], 1), 1);
assert.equal(estimateCents([unresolved("a"), resolved("b")], 1), 3);
assert.equal(estimateCents([], 1), 0);

// Fractional per-call pricing rounds up: a ceiling that under-counts is not a
// ceiling.
assert.equal(estimateCents([unresolved("a")], 0.15), 1);
assert.equal(estimateCents([unresolved("a"), unresolved("b")], 0.15), 1);

/* ---- the ceiling ---- */

const five = ["a", "b", "c", "d", "e"].map(unresolved);

// Enough room for everything: nothing is dropped.
{
  const { run, skipped } = withinBudget(five, 1, 10);
  assert.equal(run.length, 5);
  assert.equal(skipped.length, 0);
}

// Exactly enough for two accounts at two calls each.
{
  const { run, skipped } = withinBudget(five, 1, 4);
  assert.equal(run.length, 2, "should fit exactly two");
  assert.equal(skipped.length, 3, "and report the rest as dropped");
  assert.equal(estimateCents(run, 1) <= 4, true);
}

// A ceiling too small for even one account runs nothing rather than one
// "free" call.
{
  const { run, skipped } = withinBudget(five, 1, 1);
  assert.equal(run.length, 0);
  assert.equal(skipped.length, 5);
}

// Whatever the inputs, the plan never costs more than the ceiling, and
// nothing is ever lost between run and skipped.
for (const max of [0, 1, 2, 3, 5, 7, 9, 100]) {
  for (const perCall of [0.15, 1, 2.5]) {
    const { run, skipped } = withinBudget(five, perCall, max);
    assert.equal(estimateCents(run, perCall) <= max, true, `over ceiling at max=${max}`);
    assert.equal(run.length + skipped.length, five.length, "an account went missing");
  }
}

/* ---- staleness ---- */

const now = new Date("2026-07-29T12:00:00Z");
assert.equal(isStale(null, now), true, "never fetched is always worth fetching");
assert.equal(isStale(undefined, now), true);
assert.equal(isStale(new Date("2026-07-29T11:00:00Z"), now), false, "an hour old is fresh");
assert.equal(isStale(new Date("2026-07-20T12:00:00Z"), now), true, "nine days old is stale");
assert.equal(isStale(new Date("2026-07-22T12:00:00Z"), now), true, "exactly seven days is stale");
assert.equal(isStale(new Date("2026-07-28T12:00:00Z"), now, 1), true, "honours a custom age");

console.log("research: all checks passed");

/*
 * Links from the other apps, and links that name nobody.
 *
 * Only Instagram and TikTok were parsed while the research form was the only
 * caller. The client welcome form asks for YouTube, Facebook and Snapchat too,
 * and a YouTube link used to fall through and come out as "https:", which
 * would have become an account by that name.
 */
assert.equal(normalizeHandle("https://youtube.com/@realcaleb/videos"), "realcaleb");
assert.equal(normalizeHandle("https://www.facebook.com/cacvmotors"), "cacvmotors");
assert.equal(normalizeHandle("https://snapchat.com/add/carguy"), "add", "first segment wins");
// A link with nothing after the host names nobody.
for (const empty of ["https://instagram.com/", "https://instagram.com", "tiktok.com/"]) {
  assert.equal(normalizeHandle(empty), "", `${empty} is not a handle`);
}
// A handle with a dot in it is a handle, not a domain.
assert.equal(normalizeHandle("real.carguy"), "real.carguy");
assert.equal(normalizeHandle("not a handle"), "", "a space means it was never a handle");
