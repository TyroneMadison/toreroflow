import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { DEFAULT_TIME_ZONE, planResume } from "@toreroflow/core";
import { requireAuth } from "../plugins/requireAuth";
import { publishQueue } from "../posts/requeue";

/**
 * Calendar "Pause uploads / Continue uploads", per brand.
 *
 * Pausing only stamps Client.pausedAt: the worker holds every scheduled post
 * of a paused brand at publish time, so nothing is deleted or moved. Resuming
 * moves the held posts with planResume (see @toreroflow/core pauseShift) and
 * clears the stamp in one transaction, then re-queues every held post, since
 * a job that fired while paused was consumed without publishing.
 */
// ponytail: no per-brand time zone is stored yet, so every brand uses the default.
const TIME_ZONE = DEFAULT_TIME_ZONE;

export async function pauseRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownBrand = (agencyId: string, id: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true, pausedAt: true } });
  const isViewer = (user: unknown) => (user as { role?: string }).role === "viewer";
  const heldWhere = (clientId: string) => ({
    status: "scheduled" as const,
    scheduledAt: { not: null },
    post: { clientId, deletedAt: null, status: { not: "draft" as const } },
  });

  app.get<{ Params: { brandId: string } }>("/brands/:brandId/pause", async (request, reply) => {
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    return { paused: brand.pausedAt !== null, pausedAt: brand.pausedAt };
  });

  app.post<{ Params: { brandId: string } }>("/brands/:brandId/pause", async (request, reply) => {
    if (isViewer(request.user)) return reply.status(403).send({ error: "viewers cannot change this" });
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    if (brand.pausedAt) return { paused: true, pausedAt: brand.pausedAt };
    const pausedAt = new Date();
    await prisma.client.update({ where: { id: brand.id }, data: { pausedAt } });
    const held = await prisma.postTarget.count({ where: heldWhere(brand.id) });
    return { paused: true, pausedAt, held };
  });

  app.post<{ Params: { brandId: string } }>("/brands/:brandId/resume", async (request, reply) => {
    if (isViewer(request.user)) return reply.status(403).send({ error: "viewers cannot change this" });
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    if (!brand.pausedAt) return { paused: false, moved: 0, held: 0, delta: 0, from: null, to: null };

    const now = new Date();
    const plan = await prisma.$transaction(async (tx) => {
      const held = await tx.postTarget.findMany({
        where: heldWhere(brand.id),
        select: { id: true, scheduledAt: true },
      });
      const result = planResume(
        held.map((t) => ({ id: t.id, scheduledAt: t.scheduledAt! })),
        now,
        TIME_ZONE,
      );
      for (const p of result.posts) {
        if (p.moved) await tx.postTarget.update({ where: { id: p.id }, data: { scheduledAt: p.scheduledAt } });
      }
      await tx.client.update({ where: { id: brand.id }, data: { pausedAt: null } });
      return result;
    });

    for (const p of plan.posts) await publishQueue.reschedule("publish", { targetId: p.id }, p.id, p.scheduledAt);
    const times = plan.posts.map((p) => p.scheduledAt.getTime());
    return {
      paused: false,
      moved: plan.posts.filter((p) => p.moved).length,
      held: plan.posts.length,
      delta: plan.delta,
      from: times.length ? new Date(Math.min(...times)) : null,
      to: times.length ? new Date(Math.max(...times)) : null,
    };
  });
}
