// The classifier decides whether a Retry button is offered at all, so the
// costly mistake is calling a permanent refusal retryable: an operator presses
// it, watches it fail, and the client's video is still not posted. The real
// strings below were read off the live provider on 2026-08-18.
import assert from "node:assert/strict";
import {
  explainPublishFailure,
  QUOTA_DEFERRALS_MAX,
  quotaDeferralAt,
} from "./publishFailure";

// The one measured on the account: 5 TikTok targets carried exactly this.
{
  const f = explainPublishFailure("Daily active user quota reached.");
  assert.equal(f.outlook, "later", "a cap is not retryable now");
  assert.equal(f.tiktokDailyCap, true, "and it is the one with a same-day route around it");
  assert(f.advice.includes("midnight UTC"), "the operator is told when it lifts");
}

// The other real one on the account.
{
  const f = explainPublishFailure("Publishing failed due to max retries reached");
  assert.equal(f.outlook, "now", "a message with no cause in it stays retryable");
  assert.equal(f.tiktokDailyCap, false);
}

// The per-creator cap is a different fact from the app cap, and must not be
// offered the inbox workaround: that route consumes the same per-account quota.
{
  const f = explainPublishFailure("You have created too many posts in the last 24 hours via the API.");
  assert.equal(f.outlook, "later");
  assert.equal(f.tiktokDailyCap, false, "this one is the account's own limit");
}

// Our own sentence from confirmPublishing, for a container the platform
// accepted and abandoned.
{
  const f = explainPublishFailure(
    'The platform never confirmed this post. It was last reported as "awaiting-finalize".',
  );
  assert.equal(f.outlook, "now");
}

// Content refusals: retrying is guaranteed to fail again, so no button.
for (const raw of [
  "Video is too long for this format",
  "Unsupported aspect ratio 1:1",
  "invalid media: file size exceeds limit",
]) {
  assert.equal(explainPublishFailure(raw).outlook, "never", raw);
}

// Connection problems are fixed in Settings, not by pressing retry.
for (const raw of [
  "The access token has expired",
  "unauthorized: missing permission instagram_content_publish",
  "Account needs to reconnect",
]) {
  assert.equal(explainPublishFailure(raw).outlook, "never", raw);
}

// Rate limiting is a wait, not a refusal.
assert.equal(explainPublishFailure("429 Too Many Requests").outlook, "later");

// An empty or missing error still produces something an operator can read,
// because a failed post with no message is exactly when they need the most help.
for (const raw of [null, undefined, "", "   "]) {
  const f = explainPublishFailure(raw);
  assert(f.summary.length > 0, "always a summary");
  assert.equal(f.outlook, "now", "unknown means try again rather than give up");
}

// Case and punctuation from the provider must not change the classification.
assert.equal(
  explainPublishFailure("DAILY ACTIVE USER QUOTA REACHED").tiktokDailyCap,
  true,
  "matching is case-insensitive so a provider copy edit is not an outage",
);

// Anything unrecognised is retryable rather than declared unrecoverable.
assert.equal(explainPublishFailure("something nobody has seen before").outlook, "now");

/*
 * The deferral clock. A post blocked by TikTok's shared cap is moved past the
 * midnight-UTC reset rather than failed, so the arithmetic here decides when a
 * client's video actually goes out.
 */
{
  const at = (iso: string) => new Date(iso);
  const evening = quotaDeferralAt(at("2026-08-20T22:30:00.000Z"), "target-a");
  assert.equal(evening.toISOString().slice(0, 10), "2026-08-21", "an evening failure waits for tomorrow");
  assert.equal(evening.getUTCHours(), 0, "and lands just after the reset");
  assert.ok(
    evening.getUTCMinutes() >= 4 && evening.getUTCMinutes() <= 25,
    "a few minutes past the boundary, never exactly on it",
  );

  // A failure just after midnight waits for the NEXT reset, not the one it is
  // already past; otherwise it would retry immediately into the same cap.
  const justAfter = quotaDeferralAt(at("2026-08-18T01:30:00.000Z"), "target-a");
  assert.equal(justAfter.toISOString().slice(0, 10), "2026-08-19", "01:30 waits a full day");

  // Two targets deferred the same night do not stack on one minute.
  const a = quotaDeferralAt(at("2026-08-20T22:30:00.000Z"), "target-a");
  const b = quotaDeferralAt(at("2026-08-20T22:30:00.000Z"), "target-b");
  assert.notEqual(a.getTime(), b.getTime(), "the jitter spreads them");

  // Deterministic: the same target deferred twice in one night gets one answer,
  // so a re-run of the sweep cannot walk a post further into the future.
  assert.equal(
    quotaDeferralAt(at("2026-08-20T22:30:00.000Z"), "target-a").getTime(),
    a.getTime(),
    "same target, same night, same slot",
  );

  // A month boundary rolls the month, not just the day.
  const eom = quotaDeferralAt(at("2026-08-31T23:50:00.000Z"), "x");
  assert.equal(eom.toISOString().slice(0, 10), "2026-09-01", "the last night of a month rolls over");

  assert.equal(QUOTA_DEFERRALS_MAX, 3, "three nights, then it says so out loud");
}

console.log("publishFailure.check: all checks passed");
