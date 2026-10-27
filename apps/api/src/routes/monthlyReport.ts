import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { ReportJobConfigSchema } from "@toreroflow/contracts";
import { requireAuth } from "../plugins/requireAuth";
import { buildMonthlyReport, readReportJobConfig, REPORT_JOB_SETTING } from "../ideas/monthlyReport";
import { writeSetting } from "../ideas/settings";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");

/** Monthly client report: preview one brand, and the job's kill switch. */
export async function monthlyReportRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get("/reports/job-config", async (request) => readReportJobConfig(request.user.agencyId));

  /** killSwitch true lets the 1st-of-month job send. Default false. */
  app.put("/reports/job-config", async (request) => {
    const config = ReportJobConfigSchema.parse(request.body);
    await writeSetting(request.user.agencyId, REPORT_JOB_SETTING, config);
    return config;
  });

  /** The report as it would go out. Builds only; this route never sends. */
  app.get<{ Params: { brandId: string; month: string } }>("/reports/monthly/:brandId/:month", async (request, reply) => {
    const month = Month.parse(request.params.month);
    const client = await prisma.client.findFirst({
      where: { id: request.params.brandId, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });
    return buildMonthlyReport(client.id, month);
  });
}
