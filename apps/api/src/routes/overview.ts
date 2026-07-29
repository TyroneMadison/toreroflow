import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Account Overview: which client needs attention today.
 *
 * Deliberately not a fourth scoreboard. Follower counts and view totals live
 * on Analytics and in the client-facing reports, and repeating them here
 * would make this the fourth place to read the same numbers and the only one
 * you cannot act on. This answers a different question: what is behind, what
 * has gone quiet, and what has not been sent.
 *
 * One endpoint for the whole screen rather than a request per client, because
 * the screen is a list and N requests to render a list is how a list gets
 * slow as clients are added.
 *
 * Everything here reads local tables. Nothing calls the publishing provider
 * or a platform API, so the screen stays fast enough to be the first thing
 * opened in the morning.
 */

/**
 * Days between two instants, floored and never negative. Null in, null out.
 *
 * A scheduled post can carry a publishedAt slightly ahead of the server clock,
 * which would otherwise report a client as having gone quiet for minus one
 * days and sort them oddly.
 */
function daysSince(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}

/** The month that just ended, which is what a month-end report covers. */
function lastCompletedMonth(now: Date): { start: Date; key: string; label: string } {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    start,
    key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

export async function overviewRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get("/overview", async (request) => {
    const now = new Date();
    const month = lastCompletedMonth(now);

    const clients = await prisma.client.findMany({
      where: { agencyId: request.user.agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        avatarSeed: true,
        quotaShort: true,
        quotaLong: true,
        quotaResetAt: true,
        adjustShort: true,
        adjustLong: true,
        reportUrl: true,
        reportPublishedMonth: true,
        socialAccounts: {
          where: { deletedAt: null },
          select: { id: true, platform: true, handle: true, status: true, avatarUrl: true },
        },
        insight: {
          select: { status: true, storageKey: true, completedAt: true },
        },
      },
    });

    const rows = await Promise.all(
      clients.map(async (c) => {
        const since = c.quotaResetAt ?? new Date(0);
        const inPeriod = { clientId: c.id, createdAt: { gte: since }, isRevision: false };

        // Two sources for "when did they last go out": what Toreroflow
        // published, and what the platform reports. A client posting outside
        // the app would otherwise look silent when they are not.
        const [shortUploads, longUploads, lastPublished, lastExternal, reportForMonth] =
          await Promise.all([
            prisma.mediaAsset.count({
              where: { ...inPeriod, format: { in: ["short_form"] } },
            }),
            prisma.mediaAsset.count({ where: { ...inPeriod, format: "long_form" } }),
            prisma.postTarget.findFirst({
              where: { post: { clientId: c.id }, publishedAt: { not: null } },
              orderBy: { publishedAt: "desc" },
              select: { publishedAt: true },
            }),
            prisma.externalVideo.findFirst({
              where: { socialAccount: { clientId: c.id } },
              orderBy: { publishedAt: "desc" },
              select: { publishedAt: true },
            }),
            prisma.clientReport.findUnique({
              where: { clientId_periodStart: { clientId: c.id, periodStart: month.start } },
              select: { id: true, generatedAt: true, seenAt: true },
            }),
          ]);

        const lastPostAt = [lastPublished?.publishedAt ?? null, lastExternal?.publishedAt ?? null]
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

        const shortDelivered = Math.max(0, shortUploads + c.adjustShort);
        const longDelivered = Math.max(0, longUploads + c.adjustLong);
        const shortShort = c.quotaShort != null ? Math.max(0, c.quotaShort - shortDelivered) : 0;
        const longShort = c.quotaLong != null ? Math.max(0, c.quotaLong - longDelivered) : 0;
        const behindBy = shortShort + longShort;
        const tracked = c.quotaShort != null || c.quotaLong != null;

        const quiet = daysSince(lastPostAt, now);

        return {
          id: c.id,
          name: c.name,
          avatarSeed: c.avatarSeed,
          avatarUrl: c.socialAccounts.find((a) => a.avatarUrl)?.avatarUrl ?? null,
          platforms: c.socialAccounts.map((a) => ({
            platform: a.platform,
            handle: a.handle,
            status: a.status,
          })),
          /** Null target means the client is not on a quota, which is not a fault. */
          delivery: tracked
            ? {
                short: { delivered: shortDelivered, target: c.quotaShort },
                long: { delivered: longDelivered, target: c.quotaLong },
                behindBy,
              }
            : null,
          /** Null when nothing has ever been published, which reads differently to "quiet". */
          lastPostAt,
          daysQuiet: quiet,
          report: {
            month: month.key,
            label: month.label,
            built: reportForMonth !== null,
            opened: reportForMonth?.seenAt != null,
            /** What the live page currently leads with, null if never published. */
            publishedMonth: c.reportPublishedMonth,
            url: c.reportUrl,
            /** The page exists but is showing a month that is no longer current. */
            stale: c.reportUrl !== null && c.reportPublishedMonth !== month.key,
          },
          needsReconnect: c.socialAccounts.some((a) => a.status === "needs_reconnect"),
          /**
           * The latest "what to do next" run, null when never generated.
           *
           * Here so the row can say a plan is waiting without the operator
           * opening every modal to find out, and so the screen knows whether
           * anything is still being worked on.
           */
          insight: c.insight
            ? {
                status: c.insight.status,
                url: c.insight.storageKey ? `/files/${c.insight.storageKey}` : null,
                completedAt: c.insight.completedAt,
              }
            : null,
        };
      }),
    );

    /**
     * Sorted by how much they need you, not alphabetically.
     *
     * A broken connection outranks everything because nothing else works
     * while it is broken. Then being behind on delivery, then having gone
     * quiet, then an unsent report. A client with nothing wrong sinks to the
     * bottom, which is where a to-do list should put finished work.
     */
    const score = (r: (typeof rows)[number]) =>
      (r.needsReconnect ? 1000 : 0) +
      (r.delivery ? r.delivery.behindBy * 10 : 0) +
      Math.min(r.daysQuiet ?? 0, 60) +
      (r.report.stale ? 25 : 0) +
      (r.report.built && !r.report.opened ? 5 : 0);

    const sorted = [...rows].sort((a, b) => score(b) - score(a));

    return {
      month: { key: month.key, label: month.label },
      clients: sorted.map((r) => ({ ...r, attention: score(r) })),
    };
  });
}
