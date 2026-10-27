import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { botZernioKey, ZernioError, ZernioProvider } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The comments inbox: comments on a client's published Instagram and TikTok
 * posts, read and moderated through Zernio's /inbox/comments. Read-through,
 * like the DM inbox; Zernio caches for up to 10 minutes and is the store.
 *
 * Reading is open to every bot. Reply, hide and delete need the operator or a
 * full-access bot (Polly). Zernio's comment.received webhook is not wired:
 * this backend receives no Zernio webhooks yet, so the screen refreshes on
 * open and on demand instead.
 */
const PLATFORMS = new Set(["instagram", "tiktok"]);

const replySchema = z.object({
  accountId: z.string().min(1),
  message: z.string().trim().min(1).max(2200),
  commentId: z.string().min(1).optional(),
});
const hideSchema = z.object({ accountId: z.string().min(1), hidden: z.boolean() });

/** Operator, or a bot Tyrone gave full access. */
export function canModerate(request: FastifyRequest): boolean {
  return request.user.role !== "bot" || Boolean(request.botIdentity?.fullAccess);
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  /** The bot's own key when it has one, the agency key otherwise. */
  const providerFor = (request: FastifyRequest): ZernioProvider | null => {
    if (env.PUBLISH_PROVIDER !== "zernio") return null;
    const own = request.user.role === "bot" ? botZernioKey(request.user.bot, process.env) : null;
    const key = own ?? env.PUBLISH_PROVIDER_API_KEY;
    return key ? new ZernioProvider(key) : null;
  };

  /** The client and its Zernio-connected Instagram/TikTok accounts. */
  const clientOf = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      include: {
        socialAccounts: {
          where: { deletedAt: null, tokensEncrypted: "provider:zernio" },
          select: { id: true, platform: true, handle: true, providerAccountId: true },
        },
      },
    });

  type ClientRow = NonNullable<Awaited<ReturnType<typeof clientOf>>>;
  /** Only this client's own accounts can be read or moderated. */
  const ownAccount = (client: ClientRow, providerAccountId: string) =>
    client.socialAccounts.find(
      (a) => a.providerAccountId === providerAccountId && PLATFORMS.has(a.platform),
    );

  const fail = (err: unknown) => {
    if (err instanceof ZernioError) {
      const tiktok = err.code === "PLATFORM_LIMITATION";
      return {
        status: err.status >= 500 ? 502 : err.status === 403 ? 403 : 400,
        body: {
          error: tiktok
            ? "This TikTok account cannot show comments here. Zernio only reads TikTok comments for accounts connected through the TikTok for Business app."
            : err.message,
        },
      };
    }
    throw err;
  };

  app.get<{ Params: { id: string }; Querystring: { platform?: string } }>(
    "/clients/:id/comments",
    async (request, reply) => {
      const zernio = providerFor(request);
      const client = await clientOf(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      const canWrite = canModerate(request);
      if (!zernio || !client.providerProfileId) {
        return { posts: [], canModerate: canWrite, configured: false };
      }
      const platform = PLATFORMS.has(request.query.platform ?? "") ? request.query.platform : undefined;
      try {
        const posts = await zernio.commentedPosts(client.providerProfileId, { platform });
        return {
          posts: posts.filter((p) => PLATFORMS.has(p.platform) && ownAccount(client, p.accountId)),
          canModerate: canWrite,
          configured: true,
        };
      } catch (err) {
        const f = fail(err);
        return reply.status(f.status).send(f.body);
      }
    },
  );

  app.get<{ Params: { id: string; postId: string }; Querystring: { accountId?: string } }>(
    "/clients/:id/comments/:postId",
    async (request, reply) => {
      const zernio = providerFor(request);
      const client = await clientOf(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      if (!zernio) return reply.status(400).send({ error: "no publish provider configured" });
      const accountId = request.query.accountId ?? "";
      if (!ownAccount(client, accountId)) return reply.status(404).send({ error: "account not found" });
      try {
        return { comments: await zernio.postComments(request.params.postId, accountId) };
      } catch (err) {
        const f = fail(err);
        return reply.status(f.status).send(f.body);
      }
    },
  );

  /** Every write goes through here: who may, which account, then the call. */
  const write = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    accountId: string,
    run: (zernio: ZernioProvider) => Promise<unknown>,
  ): Promise<{ status: number; body: unknown }> => {
    if (!canModerate(request)) {
      return {
        status: 403,
        body: { error: "Reply, hide and delete need the operator. This bot can read comments only." },
      };
    }
    const zernio = providerFor(request);
    const client = await clientOf(request.params.id, request.user.agencyId);
    if (!client) return { status: 404, body: { error: "client not found" } };
    if (!zernio) return { status: 400, body: { error: "no publish provider configured" } };
    if (!ownAccount(client, accountId)) return { status: 404, body: { error: "account not found" } };
    try {
      return { status: 200, body: (await run(zernio)) ?? { ok: true } };
    } catch (err) {
      return fail(err);
    }
  };

  app.post<{ Params: { id: string; postId: string } }>(
    "/clients/:id/comments/:postId/reply",
    async (request, reply) => {
      const body = replySchema.parse(request.body);
      const out = await write(request, body.accountId, (z) =>
        z.replyToComment(request.params.postId, body),
      );
      return reply.status(out.status).send(out.body);
    },
  );

  app.post<{ Params: { id: string; postId: string; commentId: string } }>(
    "/clients/:id/comments/:postId/:commentId/hide",
    async (request, reply) => {
      const body = hideSchema.parse(request.body);
      const out = await write(request, body.accountId, async (z) => {
        await z.setCommentHidden(request.params.postId, request.params.commentId, body.accountId, body.hidden);
        return { hidden: body.hidden };
      });
      return reply.status(out.status).send(out.body);
    },
  );

  app.delete<{ Params: { id: string; postId: string; commentId: string }; Querystring: { accountId?: string } }>(
    "/clients/:id/comments/:postId/:commentId",
    async (request, reply) => {
      const accountId = request.query.accountId ?? "";
      const out = await write(request, accountId, (z) =>
        z.deleteComment(request.params.postId, accountId, request.params.commentId),
      );
      return reply.status(out.status).send(out.body);
    },
  );

  /**
   * The same Instagram publishing allowance the long-form checks show, for an
   * account rather than a video, so the composer can show it before anything
   * is uploaded. Informational: null when the provider cannot say.
   */
  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>(
    "/clients/:id/instagram-limit",
    async (request, reply) => {
      const client = await clientOf(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      const account = client.socialAccounts.find(
        (a) => a.platform === "instagram" && (!request.query.accountId || a.id === request.query.accountId),
      );
      const zernio = providerFor(request);
      if (!zernio || !account?.providerAccountId) return { limit: null };
      const limit = await zernio.instagramPublishingLimit(account.providerAccountId).catch(() => null);
      return { limit, accountId: account.id };
    },
  );
}
