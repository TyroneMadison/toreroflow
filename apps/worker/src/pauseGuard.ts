import type { PrismaClient } from "@toreroflow/db";

/**
 * Claim a target for publishing: only while it is still scheduled and its
 * brand is not paused. One conditional update, so a pause that lands between
 * the worker reading the target and publishing it still holds the post.
 * A held target stays "scheduled" with its time untouched; resuming re-queues it.
 */
export async function claimForPublish(
  prisma: Pick<PrismaClient, "postTarget">,
  targetId: string,
): Promise<boolean> {
  const claimed = await prisma.postTarget.updateMany({
    where: { id: targetId, status: "scheduled", post: { client: { pausedAt: null } } },
    data: { status: "publishing" },
  });
  return claimed.count > 0;
}
