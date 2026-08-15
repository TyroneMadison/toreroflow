import assert from "node:assert/strict";
import { entryFor, outcomeOf, type ProviderEntry } from "./confirmPublish";

/**
 * Runnable check: `pnpm --filter @toreroflow/worker test`.
 *
 * This decides whether a client's post is called live or dead. Getting it wrong
 * in either direction is expensive: mark a failure posted and nobody ever finds
 * out the video is missing, which is the exact bug this file was written for;
 * mark a live post failed and the operator republishes it, double posting to a
 * client's account.
 */

const e = (
  platform: string,
  status: string,
  accountId: string | null = null,
  error: string | null = null,
): ProviderEntry => ({ platform, status, accountId, error, url: null });

/* ---- reading a status ---- */

assert.equal(outcomeOf("published"), "posted", "published is published");
assert.equal(outcomeOf("PUBLISHED"), "posted", "case does not change the meaning");
assert.equal(outcomeOf("failed"), "failed", "failed is failed");
assert.equal(outcomeOf("rejected"), "failed", "so is rejected");

// Anything in flight, or anything new the provider invents, waits. It must
// never fall through to "posted": an unrecognised status called a success is
// how a failure becomes invisible again.
for (const s of ["pending", "processing", "queued", "some_new_state", "", null, undefined]) {
  assert.equal(outcomeOf(s), "waiting", `"${String(s)}" must wait, never pass as posted`);
}

/* ---- picking the right entry ---- */

// The case from the real incident: one post, three platforms, Instagram
// refused while the other two went up. Each target must read its own row.
const crossPost = [
  e("instagram", "failed", "ig-1", "Publishing failed due to max retries reached"),
  e("tiktok", "published", "tt-1"),
  e("youtube", "published", "yt-1"),
];
assert.equal(entryFor(crossPost, "instagram", "ig-1")?.status, "failed", "instagram reads failed");
assert.equal(entryFor(crossPost, "tiktok", "tt-1")?.status, "published", "tiktok reads published");
assert.equal(
  outcomeOf(entryFor(crossPost, "youtube", "yt-1")?.status),
  "posted",
  "youtube is unaffected by instagram's refusal",
);

// One entry per platform: the id is not needed to resolve it.
assert.equal(
  entryFor([e("instagram", "published")], "instagram", null)?.status,
  "published",
  "a single entry resolves without an account id",
);

// Two accounts on one platform, told apart by id.
const twoPages = [
  e("facebook", "published", "page-a"),
  e("facebook", "failed", "page-b", "no permission"),
];
assert.equal(entryFor(twoPages, "facebook", "page-a")?.status, "published", "page A is live");
assert.equal(entryFor(twoPages, "facebook", "page-b")?.status, "failed", "page B is not");

// Two on one platform with nothing to tell them apart: refuse to guess.
// Guessing would attach one account's failure to the other's target.
assert.equal(
  entryFor(twoPages, "facebook", null),
  undefined,
  "ambiguous entries resolve to nothing rather than a coin flip",
);
assert.equal(
  outcomeOf(entryFor(twoPages, "facebook", null)?.status),
  "waiting",
  "and an unresolved entry waits rather than being decided",
);

// A platform absent from the response entirely.
assert.equal(entryFor(crossPost, "snapchat", null), undefined, "no entry means no entry");

console.log("confirmPublish.check.ts: ok");
