import assert from "node:assert/strict";
import {
  BRAND,
  buildProvenance,
  knownPlatforms,
  refreshedOn,
  requiredLinks,
  sourceNames,
  UNMEASURED,
  unmeasuredFor,
} from "./dataProvenance";
import { METRIC_REPORTED_BY } from "./platformMetrics";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * This module renders onto a page a client is sent and reads months later, so
 * the failures worth guarding are the ones that put a false claim in front of
 * them: telling a brand something about a platform they do not use, listing a
 * required legal link twice or not at all, or saying a metric is unavailable
 * after it started arriving.
 */

/* ---- only the platforms actually present ---- */

assert.deepEqual(
  knownPlatforms(["youtube", "instagram"]),
  ["instagram", "youtube"],
  "order is stable regardless of the order they arrive in",
);
assert.deepEqual(knownPlatforms(["instagram", "instagram"]), ["instagram"], "no duplicates");
assert.deepEqual(knownPlatforms(["myspace"]), [], "an unknown platform is not invented");
assert.deepEqual(knownPlatforms([]), [], "no accounts is no platforms");

assert.equal(sourceNames(["instagram"]), "Instagram", "one platform reads as itself");
assert.equal(sourceNames(["instagram", "tiktok"]), "Instagram and TikTok", "two get an and");
assert.equal(
  sourceNames(["youtube", "instagram", "tiktok"]),
  "Instagram, TikTok and YouTube",
  "three get commas then an and",
);
assert.equal(sourceNames([]), "", "nothing connected names nothing");

/* ---- the links YouTube's terms require ---- */

const ytLinks = requiredLinks(["youtube"]);
assert.equal(ytLinks.length, 2, "YouTube requires both its terms and Google's privacy policy");
assert.ok(
  ytLinks.some((l) => l.href === "https://www.youtube.com/t/terms"),
  "the YouTube Terms of Service link is a condition of using the API",
);
assert.ok(
  ytLinks.some((l) => l.href === "https://policies.google.com/privacy"),
  "so is Google's privacy policy",
);

// A brand with no YouTube is not shown YouTube's terms.
assert.deepEqual(requiredLinks(["instagram", "tiktok"]), [], "no YouTube, no YouTube links");

// Instagram plus Facebook is one Meta, and must not repeat anything.
const metaLinks = requiredLinks(["instagram", "facebook", "youtube"]);
const hrefs = metaLinks.map((l) => l.href);
assert.equal(new Set(hrefs).size, hrefs.length, "a footer never lists the same link twice");

/* ---- the unmeasured notes ---- */

// The note that matters most: a brand with no TikTok is never told about TikTok.
const igOnly = unmeasuredFor(["instagram"]);
assert.ok(igOnly.length > 0, "there is always something no platform reports");
for (const note of igOnly) {
  assert.ok(
    note.platforms.includes("instagram"),
    `an Instagram-only brand was shown a note about ${note.platforms.join(", ")}`,
  );
}

// Saves are an Instagram thing, so an Instagram-only brand must not be told
// saves are unavailable when its one platform is exactly the one that has them.
assert.ok(
  !igOnly.some((n) => n.metric === "saves"),
  "Instagram reports saves, so an Instagram-only brand is never told they are missing",
);
assert.ok(
  unmeasuredFor(["tiktok"]).some((n) => n.metric === "saves"),
  "TikTok has the button but no reported count, which is worth saying",
);

/*
 * The guard that stops this rotting: a note claiming a metric is unavailable
 * for a platform the capability matrix says DOES report it is a lie the moment
 * a direct integration turns that metric on. This fails the day the two
 * disagree, which is the day someone needs to notice.
 */
for (const note of UNMEASURED) {
  if (!note.metric) continue;
  const reporters = METRIC_REPORTED_BY[note.metric];
  for (const platform of note.platforms) {
    assert.ok(
      !reporters.has(platform),
      `"${note.text.slice(0, 40)}..." says ${platform} does not report ${note.metric}, but METRIC_REPORTED_BY says it does`,
    );
  }
}

/* ---- dates ---- */

assert.equal(
  refreshedOn(new Date("2026-08-12T16:25:00.000Z")),
  new Date("2026-08-12T16:25:00.000Z").toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }),
  "a real date renders in the plain style",
);
// A date that is not true is worse than no date, so an absent one stays absent.
assert.equal(refreshedOn(null), "", "no timestamp means no line, never today's date");
assert.equal(refreshedOn(undefined), "", "undefined is not now either");
assert.equal(refreshedOn(new Date("nonsense")), "", "an unparseable date is not a date");

/* ---- the whole thing ---- */

const p = buildProvenance(["youtube", "instagram"], new Date("2026-08-12T00:00:00.000Z"));
assert.equal(p.sources, "Instagram and YouTube", "sources name what is connected");
assert.equal(p.links.length, 2, "YouTube's links ride along");
assert.equal(p.brand.name, BRAND.name, "the brand travels with it");
assert.ok(p.refreshed.length > 0, "a real date survives the build");

// Nothing connected: every renderer reads this as draw nothing.
const empty = buildProvenance([], null);
assert.equal(empty.sources, "", "an unconnected brand gets no panel");
assert.deepEqual(empty.links, [], "and no links");
assert.equal(empty.refreshed, "", "and no date");

console.log("dataProvenance.check.ts: ok");
