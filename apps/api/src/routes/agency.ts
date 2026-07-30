import type { FastifyInstance } from "fastify";
import { businessSchema } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The business behind the brand.
 *
 * "Torerone" is what a client sees on a report; "Torerone LLC" is what belongs
 * on an invoice their accountant keeps and on the year-end export a CPA works
 * from. These fields have been read by both documents since the Financials
 * module shipped and written by nothing, so invoices carried the workspace name
 * and the export printed "EIN not recorded".
 */

export async function agencyRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  const shape = {
    id: true,
    name: true,
    legalName: true,
    ein: true,
    businessAddress: true,
    businessCode: true,
    accountingMethod: true,
  } as const;

  app.get("/agency", async (request, reply) => {
    const agency = await prisma.agency.findUnique({
      where: { id: request.user.agencyId },
      select: shape,
    });
    if (!agency) return reply.status(404).send({ error: "workspace not found" });
    return agency;
  });

  /**
   * Only the fields sent are changed.
   *
   * Saving one field must never blank the rest: the form saves on blur, so a
   * whole-object write would let a half-loaded screen wipe an EIN nobody was
   * editing.
   */
  app.patch("/agency", async (request, reply) => {
    const parsed = businessSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply.status(400).send({
        error: "that business detail could not be saved",
        detail: first?.message ?? "Check the values and try again.",
      });
    }

    const agency = await prisma.agency.update({
      where: { id: request.user.agencyId },
      data: parsed.data,
      select: shape,
    });
    return agency;
  });
}
