import assert from "node:assert/strict";
import {
  buildReportSlug,
  buildReportSlugWithSuffix,
  clientSlug,
  REPORT_SLUG_SUFFIX,
  slugCombinations,
} from "./reportSlug";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * A report path is assigned once per client and never regenerated, because
 * the link may already be sitting in that client's inbox. That makes the
 * format effectively permanent, so it is pinned here: changing it is a
 * decision someone should have to make on purpose, not a rename that slips
 * through and 404s a link a client is holding.
 */

assert.equal(buildReportSlug("Caleb"), "caleb-monthly-reports");
assert.equal(buildReportSlug("CACV Motors"), "cacv-motors-monthly-reports");
assert.equal(buildReportSlug("JR Michael LLC"), "jr-michael-llc-monthly-reports");

// Lower case throughout: Netlify serves paths case sensitively, so a link
// retyped in lower case has to hit the same page.
assert.equal(buildReportSlug("CALEB"), buildReportSlug("caleb"));
assert.equal(buildReportSlug("Caleb"), buildReportSlug("Caleb").toLowerCase());

// Punctuation, accents and spacing all collapse to something URL safe.
assert.equal(clientSlug("Señor Díaz & Co."), "senor-diaz-co");
assert.equal(clientSlug("  Multiple   Spaces  "), "multiple-spaces");
assert.equal(clientSlug("!!!"), "client", "a name with nothing usable still yields a path");
assert.equal(clientSlug("A".repeat(60)).length, 40, "long names are capped");

// No leading or trailing hyphens, which would read as a broken URL.
for (const name of ["-Caleb-", "  CACV  ", "***Bob***"]) {
  const slug = buildReportSlug(name);
  assert.equal(/^[a-z0-9-]+$/.test(slug), true, `unsafe characters in ${slug}`);
  assert.equal(slug.startsWith("-"), false, `leading hyphen in ${slug}`);
  assert.equal(slug.endsWith("-"), false, `trailing hyphen in ${slug}`);
  assert.equal(slug.includes("--"), false, `doubled hyphen in ${slug}`);
}

// Every path ends in the shared suffix, which the API's disambiguation
// counter also builds from. If these drift, a second client sharing a name
// gets a path in a format nothing else recognises.
assert.equal(buildReportSlug("Caleb").endsWith(`-${REPORT_SLUG_SUFFIX}`), true);
assert.equal(REPORT_SLUG_SUFFIX, "monthly-reports");

// The unguessable variant still builds on the same base.
let n = 0;
const seq = (max: number): number => (n++ * 7) % max;
const long = buildReportSlugWithSuffix("Caleb", seq, 4);
assert.equal(long.startsWith("caleb-monthly-reports-"), true, long);
assert.equal(long.split("-").length, 3 + 4, "expected four extra words");

assert.equal(slugCombinations(4), 256 * 255 * 254 * 253);

console.log("reportSlug: all checks passed");
