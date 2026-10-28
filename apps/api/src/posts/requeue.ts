import { getPrisma, reschedule } from "@toreroflow/db";

/** The queue call, on an object so a check can stand in for pg-boss. */
export const publishQueue = { reschedule };

/**
 * Put a failed target back on the publish queue, now. Shared by the calendar's
 * retry and the Failed posts list, so there is one way to re-queue.
 *
 * scheduledAt moves to the present, because publishTarget refuses to run a job
 * more than a minute ahead of its slot. `tiktokDraft` sends it to the client's
 * TikTok inbox instead of publishing. The caller checks the target is failed.
 */
export async function requeueFailedTarget(
  target: { id: string; postId: string; options: unknown },
  tiktokDraft = false,
): Promise<Date> {
  const prisma = getPrisma();
  // A dismissed failure that is retried and fails again is news again,
  // so the dismissal does not survive the retry.
  const { queueDismissedAt: _dismissed, ...options } = (target.options as Record<string, unknown> | null) ?? {};
  const nextOptions = tiktokDraft
    ? { ...options, tiktok: { ...((options.tiktok as Record<string, unknown>) ?? {}), draft: true } }
    : options;

  const when = new Date();
  await prisma.postTarget.update({
    where: { id: target.id },
    data: {
      status: "scheduled",
      // Cleared so a second failure shows its own reason rather than the
      // last one, which is what makes "it failed the same way" readable.
      error: null,
      scheduledAt: when,
      options: nextOptions as never,
    },
  });

  /*
   * The post itself was marked failed when its last target gave up. Lift
   * that only while something is in flight again; the remaining targets
   * keep their own statuses and the next failure re-marks it.
   */
  await prisma.post.update({ where: { id: target.postId }, data: { status: "scheduled" } });
  await publishQueue.reschedule("publish", { targetId: target.id }, target.id, when);
  return when;
}
