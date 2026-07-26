import type { FastifyInstance } from "fastify";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { getPrisma } from "@toreroflow/db";
import { ZernioProvider } from "@toreroflow/publishers";
import { buildMergedPosts } from "../analytics/mergedPosts";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import {
  buildReportData,
  type ReportAccount,
  type ReportPost,
} from "../reports/buildReportData";
import { findBrowser, renderReportPdf } from "../reports/renderPdf";

const NOT_FOUND = { error: "client not found" } as const;

/** First and last moment of the calendar month containing `d`. */
function monthBounds(d: Date): { start: Date; end: Date } {
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}

/** The month that just ended, which is what a month-end report covers. */
export function lastCompletedMonth(now = new Date()): { start: Date; end: Date } {
  return monthBounds(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const zernio =
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
      ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
      : null;

  const templatePath = nodePath.join(env.REPO_ROOT, "assets", "report-template.html");

  /**
   * Everything the adapter needs for one client, shaped for it.
   *
   * Posts come from the same merged source the Analytics screen uses, so a
   * report can never disagree with what the operator saw on screen.
   */
  const gatherInputs = async (clientId: string) => {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          include: { metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
        },
      },
    });
    if (!client) return null;

    const accounts: ReportAccount[] = client.socialAccounts.map((a) => ({
      platform: a.platform,
      handle: a.handle,
      displayName: a.displayName,
      followers: a.metricSnapshots[0]?.followers ?? null,
    }));

    // Same merged source the Analytics screen reads, so a report and the
    // screen can never show different numbers for the same period. The
    // agency comes off the client record so the month-end job, which has no
    // request context, works the same way.
    const merged = await buildMergedPosts(
      { prisma: prisma as never, zernio, log: app.log },
      clientId,
      client.agencyId,
    );
    const posts: ReportPost[] = (merged ?? []).map((p) => ({
      title: p.title,
      publishedAt: p.publishedAt,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      avgWatchSec: p.avgWatchSec,
      platforms: p.platforms,
      byPlatform: p.byPlatform,
    }));

    return { client, accounts, posts };
  };

  /** Build, render, and store a report for one month. */
  const generate = async (clientId: string, period: { start: Date; end: Date }) => {
    const inputs = await gatherInputs(clientId);
    if (!inputs) return null;

    const data = buildReportData({
      clientName: inputs.client.name,
      accounts: inputs.accounts,
      posts: inputs.posts,
      periodStart: period.start,
      periodEnd: period.end,
    });

    const template = await fsp.readFile(templatePath, "utf8");
    const pdf = await renderReportPdf(template, data);

    const stamp = `${period.start.getFullYear()}-${String(period.start.getMonth() + 1).padStart(2, "0")}`;
    const storageKey = `${clientId}/reports/toreroflow-report-${stamp}.pdf`;
    const absPath = nodePath.join(env.STORAGE_DIR, storageKey);
    await fsp.mkdir(nodePath.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, pdf);

    // Regenerating a month replaces it rather than stacking duplicates.
    return await prisma.clientReport.upsert({
      where: { clientId_periodStart: { clientId, periodStart: period.start } },
      create: {
        clientId,
        periodStart: period.start,
        periodEnd: period.end,
        storageKey,
        data: data as never,
      },
      update: {
        periodEnd: period.end,
        storageKey,
        data: data as never,
        generatedAt: new Date(),
        seenAt: null,
      },
    });
  };

  const view = (r: {
    id: string;
    clientId: string;
    periodStart: Date;
    periodEnd: Date;
    storageKey: string;
    generatedAt: Date;
    seenAt: Date | null;
  }) => ({
    id: r.id,
    clientId: r.clientId,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    label: r.periodStart.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    url: `/files/${r.storageKey}`,
    generatedAt: r.generatedAt,
    seen: r.seenAt !== null,
  });

  /** Is PDF rendering possible on this machine at all? */
  app.get("/reports/capability", async () => {
    const browser = await findBrowser();
    return { canRender: browser !== null, browser };
  });

  /** Every report across all of the agency's clients, newest first. */
  app.get("/reports", async (request) => {
    const reports = await prisma.clientReport.findMany({
      where: { client: { agencyId: request.user.agencyId, deletedAt: null } },
      orderBy: { periodStart: "desc" },
      include: { client: { select: { name: true } } },
    });
    return reports.map((r) => ({ ...view(r), clientName: r.client.name }));
  });

  /**
   * Unseen month-end reports, which is what the bell badge counts.
   * Only reports for a completed month qualify, so an ad-hoc mid-month
   * generation never triggers the notification.
   */
  app.get("/reports/unseen", async (request) => {
    const { start } = lastCompletedMonth();
    const reports = await prisma.clientReport.findMany({
      where: {
        seenAt: null,
        periodStart: { lte: start },
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
      orderBy: { periodStart: "desc" },
      include: { client: { select: { name: true } } },
    });
    return {
      count: reports.length,
      message: reports.length
        ? reports.length === 1
          ? `Report ready for ${reports[0]!.periodStart.toLocaleDateString("en-US", { month: "long" })}`
          : `${reports.length} reports ready`
        : null,
      reports: reports.map((r) => ({ ...view(r), clientName: r.client.name })),
    };
  });

  app.post<{ Params: { id: string } }>("/reports/:id/seen", async (request, reply) => {
    const report = await prisma.clientReport.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
    });
    if (!report) return reply.status(404).send({ error: "report not found" });
    const updated = await prisma.clientReport.update({
      where: { id: report.id },
      data: { seenAt: new Date() },
    });
    return view(updated);
  });

  app.get<{ Params: { id: string } }>("/clients/:id/reports", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);
    const reports = await prisma.clientReport.findMany({
      where: { clientId: client.id },
      orderBy: { periodStart: "desc" },
    });
    return reports.map(view);
  });

  /**
   * Generate on demand. Defaults to the month that just ended, which is the
   * month a client is actually being reported on; `?month=YYYY-MM` overrides.
   */
  app.post<{ Params: { id: string }; Querystring: { month?: string } }>(
    "/clients/:id/reports",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      let period = lastCompletedMonth();
      const raw = request.query.month;
      if (raw) {
        const m = /^(\d{4})-(\d{2})$/.exec(raw);
        if (!m) return reply.status(400).send({ error: "month must be YYYY-MM" });
        period = monthBounds(new Date(Number(m[1]), Number(m[2]) - 1, 1));
      }

      try {
        const report = await generate(client.id, period);
        if (!report) return reply.status(404).send(NOT_FOUND);
        return reply.status(201).send(view(report));
      } catch (error) {
        request.log.error({ err: error }, "report generation failed");
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "report generation failed",
        });
      }
    },
  );

  /**
   * Month-end generation.
   *
   * Rather than firing at midnight on the 1st, this checks hourly that every
   * active client has a report for the last completed month and fills in
   * whatever is missing. That makes it idempotent and, more importantly,
   * self-healing: if the machine was off over the month boundary the report
   * still appears the next time the API runs, instead of being skipped.
   */
  const ensureMonthEndReports = async (): Promise<void> => {
    if (!(await findBrowser())) return;
    const period = lastCompletedMonth();
    const clients = await prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });
    for (const client of clients) {
      const existing = await prisma.clientReport.findUnique({
        where: { clientId_periodStart: { clientId: client.id, periodStart: period.start } },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await generate(client.id, period);
        app.log.info(
          `[reports] month-end report generated for ${client.name} (${period.start.toISOString().slice(0, 7)})`,
        );
      } catch (error) {
        app.log.error({ err: error }, `month-end report failed for ${client.name}`);
      }
    }
  };

  const HOUR_MS = 60 * 60 * 1000;
  const timer = setInterval(() => void ensureMonthEndReports(), HOUR_MS);
  // Don't hold the process open on shutdown.
  timer.unref();
  // One check shortly after boot, late enough not to slow startup.
  const boot = setTimeout(() => void ensureMonthEndReports(), 30_000);
  boot.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearTimeout(boot);
  });
}
