import { YOUTUBE_SHORTS_LIMIT_REASON } from "@toreroflow/core";
import type { PrismaClient } from "@toreroflow/db";

/**
 * Mark a YouTube Shorts target failed and do not post it.
 *
 * Called after the target has been claimed (status "publishing") and before
 * any provider call. Returning without throwing is what skips the retry
 * ladder: three attempts would post nothing and then fail with a different
 * sentence. The reason is the exact string the queue prints.
 *
 * Sibling targets on other platforms are left alone. The parent post is
 * failed only when every target has failed, so an Instagram post in the same
 * batch still goes out.
 */
export async function markYoutubeShortsOverLimit(
  db: Pick<PrismaClient, "postTarget" | "post">,
  target: { id: string; postId: string },
): Promise<void> {
  await db.postTarget.update({
    where: { id: target.id },
    data: { status: "failed", error: YOUTUBE_SHORTS_LIMIT_REASON },
  });
  const rows = await db.postTarget.findMany({
    where: { postId: target.postId },
    select: { status: true },
  });
  if (rows.length > 0 && rows.every((row) => row.status === "failed")) {
    await db.post.update({ where: { id: target.postId }, data: { status: "failed" } });
  }
}
