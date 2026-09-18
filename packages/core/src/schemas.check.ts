import assert from "node:assert/strict";
import { PLATFORM_MAX_UPLOAD_BYTES, schedulePostSchema, uploadSizeError } from "./schemas";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The rule being pinned: a video goes to exactly the platforms the operator
 * picked, each once. One PostTarget is created per entry in this list, and a
 * target is a real upload to a real client's channel, so anything that grows
 * this list beyond what was chosen publishes something nobody asked for.
 */

const at = "2026-08-15T18:00:00.000Z";
const parse = (platforms: string[]) => schedulePostSchema.parse({ platforms, scheduledAt: at });

/* What was picked is what comes out, in order. */
assert.deepEqual(parse(["tiktok"]).platforms, ["tiktok"]);
assert.deepEqual(parse(["facebook"]).platforms, ["facebook"]);
assert.deepEqual(parse(["instagram", "youtube"]).platforms, ["instagram", "youtube"]);

/* One platform never becomes several. */
assert.equal(parse(["tiktok"]).platforms.length, 1, "a single choice must stay single");

/* A repeat collapses rather than posting twice to the same account. */
assert.deepEqual(parse(["tiktok", "tiktok"]).platforms, ["tiktok"]);
assert.deepEqual(parse(["youtube", "instagram", "youtube"]).platforms, ["youtube", "instagram"]);

/* Nothing is ever added that was not asked for. */
for (const picked of [["tiktok"], ["facebook"], ["instagram", "tiktok"]]) {
  const out = parse(picked);
  for (const p of out.platforms) {
    assert.equal(picked.includes(p), true, `${p} was published to but never chosen`);
  }
  assert.equal(out.platforms.length <= picked.length, true, "more targets than choices");
}

/* Choosing nothing is refused rather than silently meaning everything. */
assert.throws(() => parse([]), "an empty selection must not be accepted");

/* An unknown platform is refused rather than dropped silently. */
assert.throws(
  () => schedulePostSchema.parse({ platforms: ["myspace"], scheduledAt: at }),
  "unknown platforms must be rejected",
);

/*
 * accountIds carries the same weight with the same rules: each entry becomes
 * a real upload to a real account, so a repeat collapses and an empty list is
 * refused rather than read as "all of them". Absent stays absent, because the
 * server's per-platform fallback must only run when the caller truly did not
 * say which accounts.
 */
{
  const withIds = schedulePostSchema.parse({
    platforms: ["facebook"],
    accountIds: ["acc-1", "acc-2", "acc-1"],
    scheduledAt: at,
  });
  assert.deepEqual(withIds.accountIds, ["acc-1", "acc-2"], "a repeated account posts once");
  assert.equal(
    parse(["facebook"]).accountIds,
    undefined,
    "no ids sent means no ids parsed, not an empty list",
  );
  assert.throws(
    () =>
      schedulePostSchema.parse({ platforms: ["facebook"], accountIds: [], scheduledAt: at }),
    "an empty account list must not be accepted",
  );
}

/*
 * Upload size, the guard that keeps a doomed post out of the queue.
 *
 * The failure being pinned: a 506MB export was scheduled, waited hours for its
 * slot, and only then was refused by the provider as too large for a reel. The
 * size was knowable the whole time.
 */
{
  const MB = 1024 * 1024;
  const limit = PLATFORM_MAX_UPLOAD_BYTES.instagram!;
  assert.equal(limit, 300 * MB, "instagram is capped at the provider's 300MB");

  assert.equal(uploadSizeError("instagram", 299 * MB), null, "under the limit publishes");
  assert.equal(uploadSizeError("instagram", limit), null, "exactly the limit is allowed");

  const over = uploadSizeError("instagram", 506 * MB);
  assert.ok(over, "the video that started this must be refused");
  assert.match(over!, /506MB/, "the message names the measured size");
  assert.match(over!, /300MB/, "the message names the limit");

  /*
   * A platform with no stated limit is unchecked, not assumed. Inventing a
   * number would refuse videos that publish fine today.
   */
  assert.equal(uploadSizeError("tiktok", 900 * MB), null, "an unknown limit refuses nothing");
  assert.equal(uploadSizeError("youtube", 900 * MB), null, "an unknown limit refuses nothing");
}

console.log("schedule schema: all checks passed");
