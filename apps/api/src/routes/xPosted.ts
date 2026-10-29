import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The calendar's "posted to X" ticks: a hand-kept record of which days the
 * operator posted to X themselves. A row means ticked. Nothing here talks to X.
 */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export async function xPostedRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownBrand = (agencyId: string, id: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true } });

  app.get<{ Params: { brandId: string }; Querystring: { from?: string; to?: string } }>(
    "/brands/:brandId/x-posted",
    async (request, reply) => {
      const { from, to } = request.query;
      if (!from || !to || !DAY.test(from) || !DAY.test(to)) return reply.status(400).send({ error: "from and to must be YYYY-MM-DD" });
      if (!(await ownBrand(request.user.agencyId, request.params.brandId))) return reply.status(404).send({ error: "brand not found" });
      const rows = await prisma.xPostedDay.findMany({
        where: { clientId: request.params.brandId, date: { gte: from, lte: to } },
        select: { date: true },
        orderBy: { date: "asc" },
      });
      return { dates: rows.map((r) => r.date) };
    },
  );

  app.put<{ Params: { brandId: string; date: string }; Body: { posted?: unknown } }>(
    "/brands/:brandId/x-posted/:date",
    async (request, reply) => {
      const { brandId, date } = request.params;
      const posted = request.body?.posted;
      if (!DAY.test(date) || typeof posted !== "boolean") return reply.status(400).send({ error: "date must be YYYY-MM-DD and posted a boolean" });
      if ((request.user as { role?: string }).role === "viewer") return reply.status(403).send({ error: "viewers cannot change this" });
      if (!(await ownBrand(request.user.agencyId, brandId))) return reply.status(404).send({ error: "brand not found" });
      const key = { clientId_date: { clientId: brandId, date } };
      if (posted) await prisma.xPostedDay.upsert({ where: key, create: { clientId: brandId, date }, update: {} });
      else await prisma.xPostedDay.deleteMany({ where: { clientId: brandId, date } });
      return { date, posted };
    },
  );
}
