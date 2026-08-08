import type { FastifyInstance } from "fastify";
import { estimateCents, normalizeHandle, platformsFor, isResearchPlatform } from "@toreroflow/core";
import { getPrisma, enqueue } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Competitor research: the accounts a client said they want to be like, and
 * what those accounts are actually posting.
 *
 * The API only ever accepts the request and answers. Every outbound fetch
 * happens on the worker's `research` queue, because provider runs take
 * minutes and because each one spends real money from a prepaid wallet.
 */

const NOT_FOUND = { error: "client not found" } as const;

/** Kept in step with the worker's own figure. */
const CENTS_PER_CALL = 0.15;

export async function researchRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  const ownedClient = (id: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true } });

  /** The inspiration accounts, with the latest snapshot for each. */
  app.get<{ Params: { id: string } }>("/clients/:id/inspirations", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send(NOT_FOUND);

    const accounts = await prisma.inspirationAccount.findMany({
      where: { clientId: client.id },
      orderBy: [{ handle: "asc" }, { platform: "asc" }],
      include: { snapshots: { orderBy: { fetchedAt: "desc" }, take: 1 } },
    });

    const latestRun = await prisma.researchRun.findFirst({
      where: { clientId: client.id },
      orderBy: { requestedAt: "desc" },
    });

    const planned = accounts.map((a) => ({
      platform: a.platform as "instagram" | "tiktok",
      handle: a.handle,
      resolved: Boolean(a.externalId),
    }));

    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        displayName: a.displayName,
        resolved: Boolean(a.externalId),
        confirmedAt: a.confirmedAt,
        error: a.error,
        lastFetchedAt: a.snapshots[0]?.fetchedAt ?? null,
      })),
      /** What pressing the button would cost, so it is never a surprise. */
      quoteCents: estimateCents(planned, CENTS_PER_CALL),
      run: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,
            maxCents: latestRun.maxCents,
            spentCents: latestRun.spentCents,
            error: latestRun.error,
            requestedAt: latestRun.requestedAt,
            completedAt: latestRun.completedAt,
          }
        : null,
    };
  });

  /**
   * Add inspiration accounts by hand, or from a form submission.
   *
   * "both" becomes two rows rather than one with two ids: a snapshot has to
   * belong to one real account on one real app or its numbers mean nothing.
   */
  app.post<{
    Params: { id: string };
    Body: { accounts?: Array<{ handle?: string; displayName?: string; platform?: string }> };
  }>("/clients/:id/inspirations", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send(NOT_FOUND);

    const incoming = request.body?.accounts ?? [];
    let added = 0;
    for (const entry of incoming) {
      const handle = normalizeHandle(entry.handle ?? "");
      if (!handle) continue;
      for (const platform of platformsFor(entry.platform)) {
        // Upsert: the same handle arriving twice is one account, not two.
        await prisma.inspirationAccount.upsert({
          where: {
            clientId_platform_handle: { clientId: client.id, platform, handle },
          },
          create: {
            clientId: client.id,
            platform,
            handle,
            displayName: entry.displayName?.trim() || null,
          },
          update: entry.displayName?.trim() ? { displayName: entry.displayName.trim() } : {},
        });
        added += 1;
      }
    }
    return reply.status(201).send({ added });
  });

  app.delete<{ Params: { id: string } }>("/inspirations/:id", async (request, reply) => {
    const account = await prisma.inspirationAccount.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!account) return reply.status(404).send({ error: "account not found" });
    await prisma.inspirationAccount.delete({ where: { id: account.id } });
    return { ok: true };
  });

  /**
   * Start a run.
   *
   * Nothing schedules this and nothing retries it: an unattended loop against
   * a metered API is how a prepaid wallet empties overnight. A run already in
   * flight is returned rather than a second one started.
   */
  app.post<{ Params: { id: string }; Body: { maxCents?: number } }>(
    "/clients/:id/research",
    async (request, reply) => {
      const client = await ownedClient(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send(NOT_FOUND);

      const running = await prisma.researchRun.findFirst({
        where: { clientId: client.id, status: "running" },
        orderBy: { requestedAt: "desc" },
      });
      if (running) return reply.status(202).send(running);

      const accounts = await prisma.inspirationAccount.findMany({
        where: { clientId: client.id },
        select: { platform: true, handle: true, externalId: true },
      });
      const usable = accounts.filter((a) => isResearchPlatform(a.platform));
      if (!usable.length) {
        return reply.status(400).send({
          error: "nothing to research",
          detail: "Add at least one account this brand wants their content to be like.",
        });
      }

      const quoted = estimateCents(
        usable.map((a) => ({
          platform: a.platform as "instagram" | "tiktok",
          handle: a.handle,
          resolved: Boolean(a.externalId),
        })),
        CENTS_PER_CALL,
      );
      // A ceiling the caller did not set defaults to what the work actually
      // costs, so the default can never overspend on a surprise.
      const maxCents = Math.max(1, Math.floor(request.body?.maxCents ?? quoted));

      const run = await prisma.researchRun.create({
        data: { clientId: client.id, status: "running", maxCents },
      });
      await enqueue("research", { runId: run.id }, { key: run.id });
      return reply.status(202).send(run);
    },
  );

  /** Everything one inspiration account has had pulled, newest first. */
  app.get<{ Params: { id: string } }>("/inspirations/:id/snapshots", async (request, reply) => {
    const account = await prisma.inspirationAccount.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!account) return reply.status(404).send({ error: "account not found" });
    const snapshots = await prisma.competitorSnapshot.findMany({
      where: { accountId: account.id },
      orderBy: { fetchedAt: "desc" },
      take: 10,
    });
    return snapshots.map((s) => ({
      id: s.id,
      fetchedAt: s.fetchedAt,
      costCents: s.costCents,
      raw: s.raw,
    }));
  });
}
