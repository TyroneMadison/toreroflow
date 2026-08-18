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
  status: "scheduled" | "publishing" | "posted" | "failed" | "reminded";
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

  // "reminded" is as finished as this app can know: the package went out and
  // its download link dies at exactly this retention window, so the file and
  // the link expire together rather than the link outliving the file.
  const unfinished = targets.filter((t) => t.status !== "posted" && t.status !== "reminded");
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

/** How long a long-form upload keeps its source, from upload rather than publish. */
export const DEFAULT_LONGFORM_RETENTION_DAYS = 5;

/**
 * The long-form rule: five days from upload, per video, Tyrone's clock.
 *
 * Long-form is why the disk fills. A half-hour 1080p export is two to four
 * gigabytes against a reel's sixty megabytes, so these files get a shorter
 * window and a clock that starts at upload rather than at the last publish:
 * a video posted the day it arrives frees its space on day five instead of
 * day eight, and one that sat scheduled for a week frees it the moment its
 * publishes settle, the five days having already run out.
 *
 * The safety that bends the literal rule: the file is never removed while a
 * target still needs it. Zernio uploads FROM this file at publish time, so
 * deleting on day five with a publish scheduled for day six would not save
 * disk, it would break a client's post. The delete happens at whichever
 * comes later: the five-day mark, or every target settling. Same reuse-safe
 * reasoning as sourceRetention, whose settled test this leans on.
 */
export function longFormSourceRetention(
  uploadedAt: Date,
  targets: RetentionTarget[],
  now: Date,
  retentionDays: number = DEFAULT_LONGFORM_RETENTION_DAYS,
): RetentionVerdict {
  // Zero-day retention asks only "has every platform finished with it".
  const settled = sourceRetention(targets, now, 0);
  if (!settled.deletable) return settled;

  const due = new Date(uploadedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  if (now < due) {
    const daysLeft = Math.ceil((due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return { deletable: false, reason: `uploaded ${daysLeft} day(s) short of the window` };
  }
  return { deletable: true, since: settled.since > due ? settled.since : due };
}
