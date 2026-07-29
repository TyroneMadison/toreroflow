import type { FastifyInstance } from "fastify";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getPrisma } from "@toreroflow/db";
import { YouTubeProvider, ZernioProvider } from "@toreroflow/publishers";
import {
  ALERT_KINDS,
  clearAlert,
  clientAlertKey,
  describeFailure,
  listAlerts,
  raiseAlert,
} from "../alerts/alerts";
import { buildMergedPosts } from "../analytics/mergedPosts";
import { syncYouTubeCatalogue } from "../analytics/youtubeSync";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import {
  buildReportData,
  type ReportAccount,
  type ReportPost,
} from "../reports/buildReportData";
import {
  buildWebReport,
  withDocumentTitle,
  type WebReportPeriod,
} from "../reports/buildWebReport";
import { embedThumbnails } from "../reports/embedThumbnails";
import { NetlifyError, NetlifyPublisher } from "../reports/netlify";
import { findBrowser, renderReportPdf } from "@toreroflow/media";
import { ensureReportSlug } from "../reports/slug";

const NOT_FOUND = { error: "client not found" } as const;

/** "2026-06" for the month a period starts in. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "June 2026", for text an operator reads. */
function monthName(d: Date | null): string {
  if (!d) return "an earlier month";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** First of the month a "2026-06" key names, or null if there isn't one. */
function monthStart(key: string | null): Date | null {
  const m = key ? /^(\d{4})-(\d{2})$/.exec(key) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
}

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
  const youtube = env.YOUTUBE_API_KEY ? new YouTubeProvider(env.YOUTUBE_API_KEY) : null;
  const analyticsQueue = new Queue("analytics", {
    connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }),
  });
  app.addHook("onClose", async () => {
    await analyticsQueue.close();
  });

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
      url: p.url,
      thumbnailUrl: p.thumbnailUrl,
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

    // Chrome takes the document title as the PDF's metadata title, which is
    // what a client's PDF reader shows in its window bar.
    const template = withDocumentTitle(
      await fsp.readFile(templatePath, "utf8"),
      `${inputs.client.name} · Performance Report · ${period.start.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
    );
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

  /**
   * The shareable web version: one self-contained file carrying the last
   * three months so the client can move between them.
   *
   * Written into storage next to the PDFs. Publishing it to a host is a
   * separate step, so this stays useful even before that is wired up.
   */
  const generateWeb = async (clientId: string, upTo: { start: Date; end: Date }) => {
    const inputs = await gatherInputs(clientId);
    if (!inputs) return null;

    const periods: WebReportPeriod[] = [];
    for (let back = 0; back < 3; back++) {
      const start = new Date(upTo.start.getFullYear(), upTo.start.getMonth() - back, 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      periods.push({
        label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
        data: buildReportData({
          clientName: inputs.client.name,
          accounts: inputs.accounts,
          posts: inputs.posts,
          periodStart: start,
          periodEnd: end,
        }),
      });
    }

    // Inline the thumbnails before publishing. Instagram's CDN links expire
    // within days, so a permanent report page has to carry its own images.
    await embedThumbnails(
      periods.map((p) => p.data as Record<string, unknown>),
      (m) => app.log.info(m),
    );

    // The page carries three months at once, so no single month belongs in
    // the title the client bookmarks.
    const template = withDocumentTitle(
      await fsp.readFile(templatePath, "utf8"),
      `${inputs.client.name} · Performance Report`,
    );
    const html = buildWebReport(template, periods);

    const stamp = monthKey(upTo.start);
    const storageKey = `${clientId}/reports/web-${stamp}.html`;
    const absPath = nodePath.join(env.STORAGE_DIR, storageKey);
    await fsp.mkdir(nodePath.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, html, "utf8");
    return {
      html,
      storageKey,
      url: `/files/${storageKey}`,
      periods: periods.map((p) => p.label),
    };
  };

  /* ---- Bringing a report's numbers up to date ---- */

  /**
   * Runs the worker's analytics ingest and waits for it, within reason.
   *
   * Post metrics are read live from the provider when the page is built, but
   * follower counts come from snapshots the worker writes, so rebuilding
   * without waiting would carry last cycle's follower numbers into a report
   * the operator just asked to update.
   *
   * The wait is bounded and never fatal: if the worker is not running, the
   * page is still rebuilt with everything else current instead of the request
   * hanging. The job is kept until observed, because a job removed on
   * completion reports no state to wait on.
   */
  const runAnalyticsIngest = async (
    timeoutMs = 30_000,
  ): Promise<"completed" | "failed" | "timed out"> => {
    const job = await analyticsQueue.add(
      "ingest",
      {},
      { removeOnComplete: false, removeOnFail: false },
    );
    const started = Date.now();
    try {
      while (Date.now() - started < timeoutMs) {
        const state = await job.getState();
        if (state === "completed") return "completed";
        if (state === "failed") return "failed";
        await new Promise((r) => setTimeout(r, 400));
      }
      return "timed out";
    } finally {
      // Kept only long enough to observe; leaving it would grow the queue.
      await job.remove().catch(() => undefined);
    }
  };

  /**
   * Pulls fresh numbers for one client and rebuilds their report page.
   *
   * This is what the operator's "Update report" means: the lifetime YouTube
   * catalogue is re-pulled because the report reads those rows through
   * buildMergedPosts, follower snapshots are refreshed, and only then is the
   * page rebuilt. Publishing stays a separate, deliberate step, so an update
   * never changes what a client can already see.
   */
  const refreshFor = async (clientId: string, period: { start: Date; end: Date }) => {
    const channels = await prisma.socialAccount.findMany({
      where: { clientId, deletedAt: null, platform: "youtube" },
      select: { id: true, handle: true },
    });
    const youtubeResults = await syncYouTubeCatalogue(
      { prisma, youtube, logError: (err, msg) => app.log.error({ err }, msg) },
      channels,
    );

    const ingest = await runAnalyticsIngest();
    if (ingest !== "completed") {
      app.log.warn(`[reports] analytics ingest ${ingest} during report refresh`);
    }

    const built = await generateWeb(clientId, period);
    if (!built) return null;
    return {
      refreshedAt: new Date().toISOString(),
      periods: built.periods,
      youtube: youtubeResults,
      /** False when the worker was unreachable; followers may lag one cycle. */
      followersRefreshed: ingest === "completed",
    };
  };

  app.post<{ Params: { id: string }; Querystring: { month?: string } }>(
    "/clients/:id/reports/refresh",
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
        const result = await refreshFor(client.id, period);
        if (!result) return reply.status(404).send(NOT_FOUND);
        return reply.status(200).send(result);
      } catch (error) {
        request.log.error({ err: error }, "report refresh failed");
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "report refresh failed",
        });
      }
    },
  );

  /* ---- Publishing to the public web ---- */

  const publisher =
    env.NETLIFY_AUTH_TOKEN && env.NETLIFY_SITE_ID
      ? new NetlifyPublisher(env.NETLIFY_AUTH_TOKEN)
      : null;

  /**
   * Builds the client's report page and pushes it to its permanent path.
   *
   * The path never changes once assigned, so a link sent in January still
   * shows July's numbers. Netlify serves `/<slug>/index.html` at `/<slug>`,
   * which is why the page is written as a directory index rather than a bare
   * `.html` file.
   */
  const publishFor = async (
    client: { id: string; name: string; reportSlug: string | null },
    period: { start: Date; end: Date },
  ) => {
    if (!publisher) throw new Error("publishing is not configured");
    const slug = await ensureReportSlug(prisma, client);
    const built = await generateWeb(client.id, period);
    if (!built) return null;

    const result = await publisher.publish(env.NETLIFY_SITE_ID, {
      [`/${slug}/index.html`]: built.html,
    });

    // The deploy URL is per-deploy; the permanent link is the site's own
    // address plus the slug, which is what actually gets sent to a client.
    const siteUrl = (await publisher.siteUrl(env.NETLIFY_SITE_ID)).replace(/\/+$/, "");
    const url = `${siteUrl}/${slug}`;

    await prisma.client.update({
      where: { id: client.id },
      data: {
        reportUrl: url,
        reportPublishedAt: new Date(),
        reportPublishedMonth: monthKey(period.start),
      },
    });

    return {
      url,
      slug,
      month: monthKey(period.start),
      periods: built.periods,
      deploy: { id: result.deployId, state: result.state, uploaded: result.uploaded, preserved: result.preserved },
    };
  };

  /**
   * Whether publishing is switched on, and where every client currently
   * stands. One call so the Reports screen can render its links without a
   * request per client.
   */
  app.get("/reports/publishing", async (request) => {
    const clients = await prisma.client.findMany({
      where: { agencyId: request.user.agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        reportSlug: true,
        reportUrl: true,
        reportPublishedAt: true,
        reportPublishedMonth: true,
      },
    });
    return {
      configured: publisher !== null,
      reason: publisher
        ? null
        : "Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in the repo root .env, then restart the API.",
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        // Shown before the first publish so the operator knows the link they
        // are about to create.
        slug: c.reportSlug,
        url: c.reportUrl,
        publishedAt: c.reportPublishedAt,
        publishedMonth: c.reportPublishedMonth,
      })),
    };
  });

  app.post<{ Params: { id: string }; Querystring: { month?: string } }>(
    "/clients/:id/reports/publish",
    async (request, reply) => {
      if (!publisher) {
        return reply.status(503).send({
          error:
            "publishing is not configured; set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in .env and restart the API",
        });
      }

      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true, name: true, reportSlug: true },
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
        const published = await publishFor(client, period);
        if (!published) return reply.status(404).send(NOT_FOUND);
        return reply.status(201).send(published);
      } catch (error) {
        request.log.error({ err: error }, "report publish failed");
        return reply.status(502).send({
          error: error instanceof Error ? error.message : "report publish failed",
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { month?: string } }>(
    "/clients/:id/reports/web",
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
        const built = await generateWeb(client.id, period);
        if (!built) return reply.status(404).send(NOT_FOUND);
        // The page itself is megabytes of inlined thumbnails; the caller wants
        // where it landed, not its contents.
        const { html: _html, ...meta } = built;
        return reply.status(201).send(meta);
      } catch (error) {
        request.log.error({ err: error }, "web report build failed");
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "web report build failed",
        });
      }
    },
  );

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

  /* ---- Background failures the operator needs to know about ---- */

  /**
   * What is currently broken. Polled by the app, which is the only way a
   * failure that happened while it was closed ever reaches the operator.
   */
  app.get("/alerts", async (request) => {
    const alerts = await listAlerts(prisma, request.user.agencyId);
    return {
      count: alerts.filter((a) => a.dismissedAt === null).length,
      alerts: alerts.map((a) => ({
        id: a.id,
        kind: a.kind,
        severity: a.severity,
        clientId: a.clientId,
        clientName: a.client?.name ?? null,
        message: a.message,
        detail: a.detail,
        count: a.count,
        firstSeenAt: a.firstSeenAt,
        lastSeenAt: a.lastSeenAt,
        dismissed: a.dismissedAt !== null,
      })),
    };
  });

  /**
   * Acknowledge one. It stays in the table so a recurrence can un-dismiss it
   * rather than arriving as a brand new problem with no history.
   */
  app.post<{ Params: { id: string } }>("/alerts/:id/dismiss", async (request, reply) => {
    const alert = await prisma.systemAlert.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!alert) return reply.status(404).send({ error: "alert not found" });
    await prisma.systemAlert.update({
      where: { id: alert.id },
      data: { dismissedAt: new Date() },
    });
    return { ok: true };
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

  /**
   * Acknowledge every waiting report at once.
   *
   * The bell points at the Reports screen, so arriving there is the
   * acknowledgement. Without this the badge would have nothing left to clear
   * it, since the per-report list it used to be cleared from is gone.
   */
  app.post("/reports/seen", async (request) => {
    const { count } = await prisma.clientReport.updateMany({
      where: {
        seenAt: null,
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
      data: { seenAt: new Date() },
    });
    return { seen: count };
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
   * Confirms the publishing credential still works, hourly.
   *
   * Netlify tokens expire. Without this the first sign would be a month-end
   * republish silently failing, by which point every client is holding a link
   * to a stale page and nobody knows. A cheap authenticated read turns a
   * ninety-day cliff into an alert the hour it happens.
   *
   * Returns whether publishing is usable, so the sweep can skip work that
   * would only fail.
   */
  const checkPublishingCredential = async (agencyId: string | null): Promise<boolean> => {
    if (!publisher || !agencyId) return false;
    const key = ALERT_KINDS.publishAuth;
    try {
      await publisher.siteUrl(env.NETLIFY_SITE_ID);
      await clearAlert(prisma, agencyId, key);
      return true;
    } catch (error) {
      const status = error instanceof NetlifyError ? error.status : 0;
      // 401/403 is the token; anything else is Netlify being unreachable,
      // which is worth saying differently because the operator cannot fix it.
      const isAuth = status === 401 || status === 403;
      app.log.error({ err: error }, "netlify credential check failed");
      await raiseAlert(prisma, {
        agencyId,
        key,
        kind: ALERT_KINDS.publishAuth,
        severity: isAuth ? "error" : "warning",
        message: isAuth
          ? "Netlify rejected the publishing token, so no client report page can be updated. Create a new token and put it in NETLIFY_AUTH_TOKEN, then restart the API."
          : "Netlify could not be reached, so report pages may not be updating. This usually clears on its own.",
        detail: describeFailure(error),
      });
      return false;
    }
  };

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
    const period = lastCompletedMonth();
    const stamp = monthKey(period.start);
    // Only the PDF needs a browser. Publishing is plain HTML over HTTP, so a
    // machine without Chrome still keeps client pages up to date.
    const canRenderPdf = (await findBrowser()) !== null;

    const clients = await prisma.client.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        agencyId: true,
        reportSlug: true,
        reportUrl: true,
        reportPublishedAt: true,
        reportPublishedMonth: true,
      },
    });

    // Checked once per sweep rather than per client, so an expired token
    // reports itself as one problem instead of one per brand.
    const publishingHealthy = await checkPublishingCredential(clients[0]?.agencyId ?? null);

    for (const client of clients) {
      if (canRenderPdf) {
        const existing = await prisma.clientReport.findUnique({
          where: { clientId_periodStart: { clientId: client.id, periodStart: period.start } },
          select: { id: true },
        });
        if (!existing) {
          const key = clientAlertKey(ALERT_KINDS.reportBuild, client.id);
          try {
            await generate(client.id, period);
            app.log.info(`[reports] month-end report generated for ${client.name} (${stamp})`);
            await clearAlert(prisma, client.agencyId, key);
          } catch (error) {
            app.log.error({ err: error }, `month-end report failed for ${client.name}`);
            await raiseAlert(prisma, {
              agencyId: client.agencyId,
              key,
              kind: ALERT_KINDS.reportBuild,
              clientId: client.id,
              severity: "warning",
              message: `${client.name}'s ${monthName(period.start)} PDF could not be built. Try Update report on the Reports screen.`,
              detail: describeFailure(error),
            });
          }
        }
      }

      // Refresh the published page so a link sent months ago now leads with
      // the month that just ended.
      //
      // Only for clients already published at least once: putting a client's
      // numbers on the public web is a decision the operator makes explicitly,
      // never something a background timer does on its own.
      if (!publisher || !client.reportPublishedAt) continue;
      if (client.reportPublishedMonth === stamp) continue;

      const key = clientAlertKey(ALERT_KINDS.reportPublish, client.id);
      // A rejected credential fails every client identically. Reporting that
      // once as a credential problem beats one confusing alert per brand.
      if (!publishingHealthy) continue;

      try {
        const published = await publishFor(client, period);
        if (published) {
          app.log.info(`[reports] republished ${client.name} at ${published.url} (${stamp})`);
          await clearAlert(prisma, client.agencyId, key);
        }
      } catch (error) {
        app.log.error({ err: error }, `month-end republish failed for ${client.name}`);
        await raiseAlert(prisma, {
          agencyId: client.agencyId,
          key,
          kind: ALERT_KINDS.reportPublish,
          clientId: client.id,
          message: `${client.name}'s report page is still showing ${monthName(monthStart(client.reportPublishedMonth))} and could not be updated. The link you have sent them is out of date.`,
          detail: describeFailure(error),
        });
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
