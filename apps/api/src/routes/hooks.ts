import type { FastifyInstance } from "fastify";
import { FUNNEL_STAGES, HOOK_SOURCES, cleanVideoFormat } from "@toreroflow/core";
import { getPrisma, type Prisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";
import { mineHooks } from "../hooks/mine";

/**
 * The hook library (v0.3.34): list with filters, a manual Refresh that runs
 * the same on-demand miner a generate press runs, and "Use this hook", which
 * banks the hook as a saved idea.
 */
export async function hooksRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownedClient = (clientId: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id: clientId, agencyId, deletedAt: null }, select: { id: true, nicheProfile: true } });

  app.get<{ Params: { clientId: string }; Querystring: { source?: string; stage?: string; format?: string; q?: string } }>(
    "/clients/:clientId/hooks",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const { source, stage, format, q } = request.query;
      const where: Prisma.HookWhereInput = { clientId: client.id };
      if (source && (HOOK_SOURCES as readonly string[]).includes(source)) where.sourceType = source as (typeof HOOK_SOURCES)[number];
      if (stage && (FUNNEL_STAGES as readonly string[]).includes(stage)) where.funnelStage = stage as (typeof FUNNEL_STAGES)[number];
      const f = cleanVideoFormat(format);
      if (f) where.format = f;
      if (q?.trim()) {
        where.OR = [
          { text: { contains: q.trim(), mode: "insensitive" } },
          { reworded: { contains: q.trim(), mode: "insensitive" } },
        ];
      }
      const [hooks, total] = await Promise.all([
        prisma.hook.findMany({ where, orderBy: [{ nicheScore: "desc" }, { createdAt: "desc" }], take: 200 }),
        prisma.hook.count({ where: { clientId: client.id } }),
      ]);
      return { hooks, total };
    },
  );

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/hooks/refresh", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    return mineHooks(client.id, request.log);
  });

  app.post<{ Params: { id: string } }>("/hooks/:id/use", async (request, reply) => {
    const hook = await prisma.hook.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { client: { select: { nicheProfile: true } } },
    });
    if (!hook) return reply.status(404).send({ error: "hook not found" });
    const line = (hook.reworded || hook.text).slice(0, 500);
    const [idea] = await prisma.$transaction([
      prisma.contentIdea.create({
        data: {
          clientId: hook.clientId,
          text: line,
          hook: line,
          formatName: hook.format,
          funnelStage: hook.funnelStage,
          niche: String((hook.client.nicheProfile as { niche?: string } | null)?.niche ?? "").slice(0, 200),
          creator: hook.sourceAccount?.slice(0, 120) ?? null,
          source: "custom",
        },
      }),
      prisma.hook.update({ where: { id: hook.id }, data: { usedCount: { increment: 1 } } }),
    ]);
    return reply.status(201).send(idea);
  });
}
