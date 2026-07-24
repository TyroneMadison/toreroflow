import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import {
  connectAccountSchema,
  createClientSchema,
  platformSchema,
  PLATFORMS,
  type Platform,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { DryRunPublisher, ZernioError, ZernioProvider } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const NOT_FOUND = { error: "client not found" } as const;

/** Initials for the avatar tile, e.g. "Halo Fitness" -> "HF". */
function avatarSeed(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          category: {
            type: "string",
            enum: ["content", "timing", "platform", "growth", "setup"],
          },
        },
        required: ["title", "detail", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
} as const;

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const anthropic = env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    : null;
  const zernio =
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
      ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
      : null;

  /** Zernio profile backing this client, created on first use. */
  const ensureProviderProfile = async (client: {
    id: string;
    name: string;
    providerProfileId: string | null;
  }): Promise<string> => {
    if (client.providerProfileId) return client.providerProfileId;
    const profileId = await zernio!.createProfile(client.name);
    await prisma.client.update({
      where: { id: client.id },
      data: { providerProfileId: profileId },
    });
    return profileId;
  };

  app.addHook("onRequest", requireAuth);

  app.get("/clients", async (request) => {
    const clients = await prisma.client.findMany({
      where: { agencyId: request.user.agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          orderBy: { platform: "asc" },
        },
        _count: { select: { workflows: true } },
      },
    });
    return clients.map((c) => ({
      id: c.id,
      name: c.name,
      avatarSeed: c.avatarSeed,
      plan: c.plan,
      createdAt: c.createdAt,
      workflowCount: c._count.workflows,
      accounts: c.socialAccounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        status: a.status,
        connectedAt: a.connectedAt,
      })),
    }));
  });

  app.post("/clients", async (request, reply) => {
    const body = createClientSchema.parse(request.body);
    const client = await prisma.client.create({
      data: {
        agencyId: request.user.agencyId,
        name: body.name,
        plan: body.plan ?? "Starter plan",
        avatarSeed: avatarSeed(body.name),
      },
    });
    return reply.status(201).send(client);
  });

  app.delete<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    // Soft delete; tokens are purged immediately (spec Section 15: provide a
    // way to disconnect an account and delete its tokens).
    const now = new Date();
    await prisma.$transaction([
      prisma.socialAccount.updateMany({
        where: { clientId: client.id },
        data: { deletedAt: now, tokensEncrypted: null, status: "error" },
      }),
      prisma.client.update({
        where: { id: client.id },
        data: { deletedAt: now },
      }),
    ]);
    return { ok: true };
  });

  /**
   * Connect a platform account for a client. With PUBLISH_PROVIDER=dryrun this
   * simulates the provider OAuth round-trip instantly; when a real provider is
   * configured (M1 decision), the same adapter interface performs real OAuth.
   */
  app.post<{ Params: { id: string; platform: string } }>(
    "/clients/:id/accounts/:platform",
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      const body = connectAccountSchema.parse(request.body ?? {});

      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      // Real provider: hand back the hosted OAuth URL. The operator finishes
      // authorization in the browser, then the app imports via /accounts/sync.
      if (zernio) {
        try {
          const profileId = await ensureProviderProfile(client);
          const authUrl = await zernio.connectUrl(platform, profileId);
          return reply.send({ authUrl, platform });
        } catch (error) {
          if (error instanceof ZernioError) {
            return reply.status(502).send({ error: `Zernio: ${error.message}` });
          }
          throw error;
        }
      }

      const publisher = new DryRunPublisher(platform);
      const init = await publisher.handleCallback({ state: client.id });
      const handle = body.handle ?? init.handle;

      const existing = await prisma.socialAccount.findFirst({
        where: { clientId: client.id, platform, deletedAt: null },
      });
      const account = existing
        ? await prisma.socialAccount.update({
            where: { id: existing.id },
            data: {
              handle,
              status: "connected",
              tokensEncrypted: init.tokensEncrypted,
              providerAccountId: init.providerAccountId,
              connectedAt: new Date(),
            },
          })
        : await prisma.socialAccount.create({
            data: {
              clientId: client.id,
              platform,
              handle,
              status: "connected",
              tokensEncrypted: init.tokensEncrypted,
              providerAccountId: init.providerAccountId,
              scopes: init.scopes,
            },
          });

      return reply.status(existing ? 200 : 201).send({
        id: account.id,
        platform: account.platform,
        handle: account.handle,
        status: account.status,
        connectedAt: account.connectedAt,
      });
    },
  );

  /** Import accounts the operator connected on the provider's hosted page. */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/accounts/sync",
    async (request, reply) => {
      if (!zernio) {
        return reply.status(400).send({ error: "no publishing provider configured" });
      }
      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      try {
        const profileId = await ensureProviderProfile(client);
        const remote = await zernio.accountsForProfile(profileId);
        const valid = remote.filter((a) =>
          (PLATFORMS as readonly string[]).includes(a.platform),
        );
        for (const a of valid) {
          const platform = a.platform as Platform;
          const handle = a.username ?? a.displayName ?? a.name ?? a.platform;
          const existing = await prisma.socialAccount.findFirst({
            where: { clientId: client.id, platform, deletedAt: null },
          });
          if (existing) {
            await prisma.socialAccount.update({
              where: { id: existing.id },
              data: {
                handle,
                status: "connected",
                providerAccountId: a._id,
                connectedAt: new Date(),
              },
            });
          } else {
            await prisma.socialAccount.create({
              data: {
                clientId: client.id,
                platform,
                handle,
                status: "connected",
                providerAccountId: a._id,
                // Tokens stay with the provider; this marks custody, not a secret.
                tokensEncrypted: "provider:zernio",
              },
            });
          }
        }
        return { imported: valid.length };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  /** Disconnect: purge tokens and soft-delete the account row. */
  app.delete<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
    const account = await prisma.socialAccount.findFirst({
      where: {
        id: request.params.id,
        deletedAt: null,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!account) return reply.status(404).send({ error: "account not found" });

    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { deletedAt: new Date(), tokensEncrypted: null, status: "error" },
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/clients/:id/analytics", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          include: {
            metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 30 },
          },
        },
      },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    const accounts = client.socialAccounts.map((a) => {
      const latest = a.metricSnapshots[0] ?? null;
      return {
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        status: a.status,
        latest: latest
          ? {
              capturedAt: latest.capturedAt,
              views: latest.views,
              reach: latest.reach,
              followers: latest.followers,
              engagementRate: latest.engagementRate,
              avgWatchSec: latest.avgWatchSec,
            }
          : null,
        history: a.metricSnapshots.map((s) => ({
          capturedAt: s.capturedAt,
          views: s.views,
          followers: s.followers,
        })),
      };
    });

    const totals = accounts.reduce(
      (acc, a) => {
        acc.views += a.latest?.views ?? 0;
        acc.reach += a.latest?.reach ?? 0;
        acc.followers += a.latest?.followers ?? 0;
        return acc;
      },
      { views: 0, reach: 0, followers: 0 },
    );

    return {
      client: { id: client.id, name: client.name, plan: client.plan },
      accounts,
      totals,
      hasData: accounts.some((a) => a.latest !== null),
    };
  });

  /**
   * AI growth suggestions for a client. Uses the operator's ANTHROPIC_API_KEY;
   * without one the endpoint explains how to enable it instead of failing
   * silently. Daily metric ingestion arrives in M5 - until then suggestions
   * lean on the client profile and connection state.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/suggestions",
    async (request, reply) => {
      if (!anthropic) {
        return reply.status(503).send({
          error: "suggestions unavailable",
          detail:
            "Set ANTHROPIC_API_KEY in the repo root .env and restart the API to enable AI suggestions.",
        });
      }

      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
        include: {
          socialAccounts: {
            where: { deletedAt: null },
            include: {
              metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 14 },
            },
          },
          workflows: true,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      const accountSummary = client.socialAccounts.length
        ? client.socialAccounts
            .map((a) => {
              const latest = a.metricSnapshots[0];
              const metrics = latest
                ? `views=${latest.views ?? "?"} reach=${latest.reach ?? "?"} followers=${latest.followers ?? "?"} engagement=${latest.engagementRate ?? "?"}% avgWatch=${latest.avgWatchSec ?? "?"}s (captured ${latest.capturedAt.toISOString()})`
                : "no metrics captured yet";
              return `- ${a.platform} @${a.handle} [${a.status}]: ${metrics}`;
            })
            .join("\n")
        : "- no platforms connected yet";

      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SUGGESTIONS_SCHEMA },
        },
        system:
          "You are a short-form video growth strategist for a social media agency. " +
          "Give specific, actionable suggestions to improve a client's social analytics. " +
          "When there is no metrics history yet, focus on the highest-leverage setup and " +
          "early-growth moves for their connected platforms. 4 to 6 suggestions, each " +
          "concrete enough to act on this week. No fluff.",
        messages: [
          {
            role: "user",
            content:
              `Client: ${client.name} (plan: ${client.plan ?? "unknown"})\n` +
              `Connected accounts:\n${accountSummary}\n` +
              `Repost workflows configured: ${client.workflows.length}\n` +
              `Agency context: short-form video (Reels/TikTok/Shorts/Spotlight), operator manages posting and analytics via Toreroflow.`,
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        return reply.status(502).send({ error: "model declined the request" });
      }
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        return reply.status(502).send({ error: "empty model response" });
      }
      const parsed = JSON.parse(text.text) as {
        suggestions: Array<{ title: string; detail: string; category: string }>;
      };
      return { clientId: client.id, suggestions: parsed.suggestions };
    },
  );
}
