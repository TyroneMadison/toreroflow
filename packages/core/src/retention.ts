/**
 * When a published video's source file can be thrown away.
 *
 * The source is 96% of what this app stores and nothing reads it once the
 * post is live: the platform has the video, the card renders from the
 * thumbnail, and the report reads numbers. Keeping every source forever grows
 * the disk by roughly a gigabyte a fortnight and buys nothing.
 *
 * Pure and pinned in a check because it decides to delete an operator's
 * primary asset, and the two ways to get that wrong are both expensive:
 * deleting one that is still needed, or never deleting anything.
 */

/** How long a posted video keeps its source, unless configured otherwise. */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * How long a posted video keeps its thumbnail and cover.
 *
 * Much longer than the source, and deliberately so. The image is roughly a
 * five-hundredth of the video's size, so it is not what fills a disk, and it
 * is what every card in the calendar, the queue and the upload list draws.
 * Once it goes the card keeps its title, platform, status and time and loses
 * only the picture.
 *
 * It cannot be rebuilt. The frame is extracted from the source, and the source
 * is gone at DEFAULT_RETENTION_DAYS, so this deletion is permanent in a way
 * the source deletion is not: the platform still holds the video, but nothing
 * anywhere holds the thumbnail.
 */
export const DEFAULT_THUMB_RETENTION_DAYS = 30;

export interface RetentionTarget {
  status: "scheduled" | "publishing" | "posted" | "failed";
  publishedAt: Date | null;
}

export type RetentionVerdict =
  | { deletable: true; since: Date }
  | { deletable: false; reason: string };

/**
 * Whether this video's source can go.
 *
 * Every target must have posted. Not most of them: a video goes to four
 * platforms, any one can fail, and a retry needs the file that a delete on
 * first success would already have removed. A post still waiting on a
 * platform, or one with a failure nobody has cleared, keeps its source.
 *
 * The clock starts at the last platform to publish, not the first, so the
 * grace period covers the whole post rather than the earliest part of it.
 */
export function sourceRetention(
  targets: RetentionTarget[],
  now: Date,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): RetentionVerdict {
  if (!targets.length) return { deletable: false, reason: "never scheduled anywhere" };

  const unfinished = targets.filter((t) => t.status !== "posted");
  if (unfinished.length) {
    const statuses = [...new Set(unfinished.map((t) => t.status))].sort().join(", ");
    return { deletable: false, reason: `still ${statuses} on ${unfinished.length} platform(s)` };
  }

  // A row marked posted with no timestamp cannot start a clock. Treating that
  // as "long ago" would delete it immediately, which is the wrong way to be
  // wrong, so it waits for a human instead.
  const stamps = targets.map((t) => t.publishedAt).filter((d): d is Date => d instanceof Date);
  if (stamps.length !== targets.length) {
    return { deletable: false, reason: "posted without a publish time" };
  }

  const last = new Date(Math.max(...stamps.map((d) => d.getTime())));
  const due = new Date(last.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  if (now < due) {
    const daysLeft = Math.ceil((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return { deletable: false, reason: `posted ${daysLeft} day(s) short of the window` };
  }
  return { deletable: true, since: last };
}
