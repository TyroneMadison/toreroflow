import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { explainPublishFailure } from "@toreroflow/core";
import { ZernioProvider } from "@toreroflow/publishers";
import { FailedPostDismissSchema, WorkflowPlatformSchema } from "@toreroflow/contracts";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { requeueFailedTarget } from "../posts/requeue";

/**
 * Failed posts: the platform error, a plain reason, and one manual Retry (or
 * Reconnect when the account's connection is gone). Nothing here retries on
 * its own. Before re-queueing, the provider is asked whether the post went
 * live after all, so a retry can never put the same video up twice.
 */

/** The reason explainPublishFailure gives a dead connection, matched by value. */
const RECONNECT_SUMMARY = explainPublishFailure("token expired").summary;

export function retryAction(error: string | null, accountStatus: string): "retry" | "reconnect" {
  return accountStatus === "needs_reconnect" || explainPublishFailure(error).summary === RECONNECT_SUMMARY ? "reconnect" : "retry";
}

const PLATFORMS = WorkflowPlatformSchema.options;

export async function failedPostRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const zernio = () =>
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY) : null;

  app.get<{ Querystring: { brandId?: string } }>("/failed-posts", async (request) => {
    const targets = await prisma.postTarget.findMany({
      where: {
        status: "failed",
        failureDismissedAt: null,
        platform: { in: [...PLATFORMS] },
        post: { deletedAt: null, client: { agencyId: request.user.agencyId }, ...(request.query.brandId ? { clientId: request.query.brandId } : {}) },
      },
      include: { post: { select: { clientId: true } }, socialAccount: { select: { status: true } } },
      orderBy: { scheduledAt: "desc" },
      take: 200,
    });
    const items = targets.map((t) => {
      const why = explainPublishFailure(t.error);
      return {
        postTargetId: t.id,
        platform: t.platform as (typeof PLATFORMS)[number],
        brandId: t.post.clientId,
        error: t.error ?? "",
        reason: why.summary,
        advice: why.advice,
        action: retryAction(t.error, t.socialAccount.status),
        scheduledAt: t.scheduledAt?.toISOString() ?? null,
      };
    });
    return { count: items.length, items };
  });

  /*
   * Remove failure notices from the list. Only the notice goes: the post, its
   * media and its calendar slot stay exactly as they were, and only failed
   * targets match, so a published post is never touched. A retry clears it.
   */
  const dismiss = async (agencyId: string, where: { id?: { in: string[] }; post?: { clientId: string } }) => {
    const { count } = await prisma.postTarget.updateMany({
      where: { ...where, status: "failed", failureDismissedAt: null, platform: { in: [...PLATFORMS] }, post: { ...where.post, client: { agencyId } } },
      data: { failureDismissedAt: new Date() },
    });
    return { dismissed: count };
  };
  const viewer = (request: { user: unknown }) => (request.user as { role?: string }).role === "viewer";

  app.post<{ Params: { postTargetId: string } }>("/failed-posts/:postTargetId/dismiss", async (request, reply) => {
    if (viewer(request)) return reply.status(403).send({ error: "viewers cannot remove failed posts" });
    const r = await dismiss(request.user.agencyId, { id: { in: [request.params.postTargetId] } });
    if (r.dismissed) return r;
    // Already gone from the list (removed elsewhere, retried, or live): the card can go, nothing to change.
    const known = await prisma.postTarget.findFirst({
      where: { id: request.params.postTargetId, post: { client: { agencyId: request.user.agencyId } } },
      select: { id: true },
    });
    return known ? r : reply.status(404).send({ error: "no failed post to remove" });
  });

  /** Bulk: `{ postTargetIds }` for the selected ones, `{ all: true }` (optionally per brand) for every one. */
  app.post("/failed-posts/dismiss", async (request, reply) => {
    if (viewer(request)) return reply.status(403).send({ error: "viewers cannot remove failed posts" });
    const body = FailedPostDismissSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "send postTargetIds, or all: true" });
    const { postTargetIds, all, brandId } = body.data;
    return dismiss(request.user.agencyId, {
      ...(all ? {} : { id: { in: postTargetIds ?? [] } }),
      ...(brandId ? { post: { clientId: brandId } } : {}),
    });
  });

  app.post<{ Params: { postTargetId: string } }>("/failed-posts/:postTargetId/retry", async (request, reply) => {
    if ((request.user as { role?: string }).role === "viewer") return reply.status(403).send({ error: "viewers cannot retry posts" });
    const target = await prisma.postTarget.findFirst({
      where: { id: request.params.postTargetId, post: { client: { agencyId: request.user.agencyId } } },
      include: { socialAccount: { select: { status: true, providerAccountId: true } } },
    });
    if (!target) return reply.status(404).send({ error: "post not found" });
    if (target.status === "posted" || target.publishedAt) return { outcome: "already_live" };
    // "publishing" is in flight at the platform; re-queueing it is how a client gets it twice.
    if (target.status !== "failed") {
      return reply.status(409).send({ error: `only failed posts can be retried; this one is ${target.status}` });
    }
    if (retryAction(target.error, target.socialAccount.status) === "reconnect") return { outcome: "needs_reconnect" };

    // Did it go live after all? If the provider cannot say, do not guess.
    const provider = zernio();
    if (target.remotePostId && provider) {
      let live: { url: string | null } | undefined;
      try {
        const status = await provider.postStatus(target.remotePostId);
        live = status.platforms.find(
          (p) =>
            p.status === "published" &&
            (p.accountId ? p.accountId === target.socialAccount.providerAccountId : p.platform === target.platform),
        );
      } catch (e) {
        return reply.status(503).send({
          error: "could not check with the provider whether this post is already live, so it was not retried",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      if (live) {
        await prisma.postTarget.update({
          where: { id: target.id },
          data: { status: "posted", error: null, publishedAt: new Date(), remoteUrl: live.url ?? target.remoteUrl },
        });
        return { outcome: "already_live" };
      }
    }
    await requeueFailedTarget(target);
    return { outcome: "queued" };
  });
}
