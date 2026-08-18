import type { FastifyInstance } from "fastify";
import { dmCampaignSchema, inboxReplySchema, updateDmCampaignSchema } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { ZernioError, ZernioProvider } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Comment-to-DM campaigns.
 *
 * Zernio holds these, not us. A local mirror would be a second copy of
 * something the provider edits on its own (every trigger moves the counters),
 * and ClientPost already demonstrates what an unsynchronised mirror costs. The
 * one thing we do persist is the per-video totals, and only because a client
 * report is a static page that has to render months later with no provider to
 * ask; see syncDmStats in the worker.
 */
export async function dmCampaignRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const zernio =
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
      ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
      : null;

  app.addHook("onRequest", requireAuth);

  /** A refusal carrying the status to send it with. */
  type Fail = { error: string; status: number };
  type Context = Fail | { client: { id: string }; profileId: string; zernio: ZernioProvider };
  const failed = (v: Fail | object): v is Fail => "error" in v;

  /** The client, its Zernio profile, and the provider. All three or nothing. */
  const context = async (clientId: string, agencyId: string): Promise<Context> => {
    if (!zernio) return { error: "no publish provider configured", status: 400 };
    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
    });
    if (!client) return { error: "client not found", status: 404 };
    if (!client.providerProfileId) {
      return { error: "client has no connected accounts yet", status: 400 };
    }
    return { client, profileId: client.providerProfileId, zernio };
  };

  /**
   * Resolves one of our account ids to the provider's.
   *
   * Instagram and Facebook only. Meta is the only place both halves exist, the
   * comment webhook and the DM send, so a campaign anywhere else would be
   * created, look correct, and never fire once. Refusing here is the difference
   * between a feature that is unavailable and one that is silently broken.
   */
  const providerAccount = async (
    accountId: string,
    clientId: string,
  ): Promise<Fail | { providerAccountId: string }> => {
    const account = await prisma.socialAccount.findFirst({
      where: { id: accountId, clientId, deletedAt: null },
      select: { platform: true, providerAccountId: true },
    });
    if (!account) return { error: "account not found", status: 404 };
    if (account.platform !== "instagram" && account.platform !== "facebook") {
      return {
        error: "comment-to-DM works on Instagram and Facebook only",
        status: 400,
      };
    }
    if (!account.providerAccountId) {
      return { error: "account is not connected to the provider", status: 400 };
    }
    return { providerAccountId: account.providerAccountId };
  };

  app.get<{ Params: { id: string } }>(
    "/clients/:id/dm-campaigns",
    async (request, reply) => {
      const ctx = await context(request.params.id, request.user.agencyId);
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
      try {
        return { campaigns: await ctx.zernio.listCommentAutomations(ctx.profileId) };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/clients/:id/dm-campaigns",
    async (request, reply) => {
      const ctx = await context(request.params.id, request.user.agencyId);
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
      const body = dmCampaignSchema.parse(request.body);
      const resolved = await providerAccount(body.accountId, ctx.client.id);
      if (failed(resolved)) {
        return reply.status(resolved.status).send({ error: resolved.error });
      }
      try {
        const campaign = await ctx.zernio.createCommentAutomation({
          ...body,
          profileId: ctx.profileId,
          accountId: resolved.providerAccountId,
        });
        return reply.status(201).send(campaign);
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  /**
   * Editing and deleting are scoped under the client on purpose.
   *
   * The automation id alone is Zernio's, and Zernio would happily accept it
   * from anyone holding our API key. Checking that the id is in this client's
   * own list is what makes ownership a check rather than an assumption.
   */
  const ownedCampaign = async (
    clientId: string,
    agencyId: string,
    automationId: string,
  ): Promise<Context> => {
    const ctx = await context(clientId, agencyId);
    if (failed(ctx)) return ctx;
    const list = await ctx.zernio.listCommentAutomations(ctx.profileId);
    if (!list.some((c) => c.id === automationId)) {
      return { error: "campaign not found", status: 404 };
    }
    return ctx;
  };

  app.patch<{ Params: { id: string; campaignId: string } }>(
    "/clients/:id/dm-campaigns/:campaignId",
    async (request, reply) => {
      const ctx = await ownedCampaign(
        request.params.id,
        request.user.agencyId,
        request.params.campaignId,
      );
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
      const body = updateDmCampaignSchema.parse(request.body ?? {});
      try {
        return await ctx.zernio.updateCommentAutomation(request.params.campaignId, body);
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string; campaignId: string } }>(
    "/clients/:id/dm-campaigns/:campaignId",
    async (request, reply) => {
      const ctx = await ownedCampaign(
        request.params.id,
        request.user.agencyId,
        request.params.campaignId,
      );
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
      try {
        await ctx.zernio.deleteCommentAutomation(request.params.campaignId);
        return { ok: true };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  /** Who triggered it and whether their DM landed. This is the lead list. */
  app.get<{ Params: { id: string; campaignId: string }; Querystring: { limit?: string } }>(
    "/clients/:id/dm-campaigns/:campaignId/logs",
    async (request, reply) => {
      const ctx = await ownedCampaign(
        request.params.id,
        request.user.agencyId,
        request.params.campaignId,
      );
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
      const limit = Number(request.query.limit ?? 50);
      try {
        return {
          logs: await ctx.zernio.automationLogs(request.params.campaignId, {
            limit: Number.isFinite(limit) ? limit : 50,
          }),
        };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Inbox. Read-through: Zernio holds the threads and we never copy one down.
  // A local mirror would need a webhook to stay current, and a stale inbox is
  // worse than no inbox because it answers confidently and wrongly.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>(
    "/clients/:id/inbox",
    async (request, reply) => {
      const ctx = await context(request.params.id, request.user.agencyId);
      if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });

      /*
       * An accountId in the query is ours; Zernio wants its own. Filtering by
       * a raw id would silently return every thread on the profile, which on a
       * client with two Instagram accounts is the wrong client's conversations
       * under the right client's heading.
       */
      let providerAccountId: string | undefined;
      if (request.query.accountId) {
        const resolved = await providerAccount(request.query.accountId, ctx.client.id);
        if (failed(resolved)) {
          return reply.status(resolved.status).send({ error: resolved.error });
        }
        providerAccountId = resolved.providerAccountId;
      }
      try {
        return {
          conversations: await ctx.zernio.conversations(ctx.profileId, {
            accountId: providerAccountId,
          }),
        };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { id: string; conversationId: string };
    Querystring: { accountId?: string };
  }>("/clients/:id/inbox/:conversationId", async (request, reply) => {
    const ctx = await context(request.params.id, request.user.agencyId);
    if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
    if (!request.query.accountId) {
      return reply.status(400).send({ error: "accountId is required" });
    }
    const resolved = await providerAccount(request.query.accountId, ctx.client.id);
    if (failed(resolved)) return reply.status(resolved.status).send({ error: resolved.error });
    try {
      return {
        messages: await ctx.zernio.conversationMessages(
          request.params.conversationId,
          resolved.providerAccountId,
        ),
      };
    } catch (error) {
      if (error instanceof ZernioError) {
        return reply.status(502).send({ error: `Zernio: ${error.message}` });
      }
      throw error;
    }
  });

  /**
   * Reply in a thread, as the client's account.
   *
   * This posts on a real account to a real person, which is why it is a
   * deliberate action behind a typed message and never anything automatic.
   */
  app.post<{
    Params: { id: string; conversationId: string };
    Body: { accountId?: string; message?: string };
  }>("/clients/:id/inbox/:conversationId/reply", async (request, reply) => {
    const ctx = await context(request.params.id, request.user.agencyId);
    if (failed(ctx)) return reply.status(ctx.status).send({ error: ctx.error });
    const body = inboxReplySchema.parse(request.body ?? {});
    const resolved = await providerAccount(body.accountId, ctx.client.id);
    if (failed(resolved)) return reply.status(resolved.status).send({ error: resolved.error });
    try {
      await ctx.zernio.sendMessage(request.params.conversationId, {
        accountId: resolved.providerAccountId,
        message: body.message,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ZernioError) {
        return reply.status(502).send({ error: `Zernio: ${error.message}` });
      }
      throw error;
    }
  });
}
