import type { PostTargetInfo } from "./api";
import { queueRows } from "./queue";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  },
};

/**
 * Runnable check for the queue's rows: `pnpm --filter @toreroflow/desktop test`.
 *
 * The regression this exists to prevent: a scheduled video's card now leaves
 * the upload list, so a failed post that appeared in neither place would be a
 * problem with nowhere to see it. Failures must be listed, and listed first.
 */

const row = (
  id: string,
  status: PostTargetInfo["status"],
  scheduledAt: string | null,
): PostTargetInfo => ({
  id,
  postId: `p-${id}`,
  platform: "instagram",
  status,
  scheduledAt,
  publishedAt: null,
  error: status === "failed" ? "token expired" : null,
  caption: null,
  assetName: `${id}.mp4`,
  thumbUrl: null,
  assetKind: "video",
  slideCount: 0,
});

/* Failures are listed, and sort above everything upcoming. */
{
  const rows = queueRows([
    row("a", "scheduled", "2026-07-28T10:00:00.000Z"),
    row("b", "failed", "2026-07-29T10:00:00.000Z"),
    row("c", "publishing", "2026-07-28T09:00:00.000Z"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "c", "a"],
    "failed first, then the rest by time",
  );
}

/* Scheduled rows keep their time order. */
{
  const rows = queueRows([
    row("late", "scheduled", "2026-07-30T10:00:00.000Z"),
    row("early", "scheduled", "2026-07-28T10:00:00.000Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["early", "late"], "earliest scheduled first");
}

/* Posted work is done and lives in Analytics, never in the queue. */
{
  const rows = queueRows([
    row("done", "posted", "2026-07-01T10:00:00.000Z"),
    row("next", "scheduled", "2026-07-28T10:00:00.000Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["next"], "posted rows are excluded");
}

/* The cap holds, and a failure never loses its place to the cap. */
{
  const many = [
    ...Array.from({ length: 6 }, (_, i) =>
      row(`s${i}`, "scheduled", `2026-07-2${i}T10:00:00.000Z`),
    ),
    row("boom", "failed", "2026-07-29T10:00:00.000Z"),
  ];
  const rows = queueRows(many);
  assert.equal(rows.length, 6, "cap honored");
  assert.equal(rows[0].id, "boom", "the failure survives the cap");
}

/* The caller's array is never reordered underneath it. */
{
  const input = [
    row("a", "scheduled", "2026-07-30T10:00:00.000Z"),
    row("b", "failed", "2026-07-28T10:00:00.000Z"),
  ];
  queueRows(input);
  assert.deepEqual(input.map((r) => r.id), ["a", "b"], "input order untouched");
}

console.log("queue rows: all checks passed");
