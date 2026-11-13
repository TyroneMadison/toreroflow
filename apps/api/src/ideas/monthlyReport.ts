import type { FastifyBaseLogger } from "fastify";
import { getPrisma } from "@toreroflow/db";
import {
  DEFAULT_REPORT_JOB_CONFIG,
  ReportJobConfigSchema,
  type MonthlyReport,
  type ReportJobConfig,
} from "@toreroflow/contracts";
import type { Mailer } from "../mail/mailer";
import { readSetting } from "./settings";

/**
 * The monthly client report: built on the 1st (ET) for the month that just
 * ended, one per brand, and emailed from Toreronee@gmail.com to every email
 * on the brand's profile. Sending only happens with the kill switch ON
 * (ReportJobConfig.killSwitch, default false); OFF builds and stores a
 * preview and never touches the mailer.
 */

export const REPORT_JOB_SETTING = "report_job";

export function readReportJobConfig(agencyId: string): Promise<ReportJobConfig> {
  return readSetting(agencyId, REPORT_JOB_SETTING, ReportJobConfigSchema, DEFAULT_REPORT_JOB_CONFIG);
}

/** "2026-11-01" for this instant in New York. */
export function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * ET midnight on the 1st, as an instant. Midnight on a 1st is never inside a
 * DST change (those are the 2nd Sunday of March and 1st Sunday of November at
 * 2am), so April to November 1st are EDT (UTC-4) and the rest EST (UTC-5).
 */
function etMonthStart(year: number, month: number): Date {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12 + 12) % 12 + 1;
  return new Date(Date.UTC(y, m - 1, 1, m >= 4 && m <= 11 ? 4 : 5));
}

export function monthBounds(month: string): { start: Date; end: Date; nextEnd: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: etMonthStart(y, m), end: etMonthStart(y, m + 1), nextEnd: etMonthStart(y, m + 2) };
}

/** The month to report on when the job runs at `now`: the previous one, on the 1st only. */
export function reportMonthFor(now: Date): string | null {
  const [y, m, d] = etDate(now).split("-").map(Number) as [number, number, number];
  if (d !== 1) return null;
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}`;
}

/** Every address in a profile's email field ("a@x.com, b@y.com"). */
export function profileEmails(field: string | null | undefined): string[] {
  const all = (field ?? "").split(/[\s,;]+/).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return [...new Set(all.map((e) => e.toLowerCase()))];
}

export interface MonthInput {
  /** Posted targets in the month, with their latest view count. */
  posted: { postId: string; views: number | null }[];
  /** Follower snapshots before the month ended, any order. */
  snapshots: { socialAccountId: string; capturedAt: Date; followers: number | null }[];
  /** Targets scheduled for next month. */
  upcoming: { platform: string; scheduledAt: Date; caption: string | null }[];
  start: Date;
}

/** The report's numbers, pure so it is checked without a database. */
export function summarizeMonth(input: MonthInput) {
  const byPost = new Map<string, number>();
  for (const t of input.posted) byPost.set(t.postId, (byPost.get(t.postId) ?? 0) + (t.views ?? 0));
  let topPostId: string | null = null;
  for (const [id, v] of byPost) if (topPostId === null || v > byPost.get(topPostId)!) topPostId = id;

  // Followers gained: per account, the last count in the month minus the last
  // count before it (or the first in the month when there is none before).
  const accounts = new Map<string, { before?: number; first?: number; last?: number }>();
  const sorted = [...input.snapshots].filter((s) => s.followers != null).sort((a, b) => +a.capturedAt - +b.capturedAt);
  for (const s of sorted) {
    const a = accounts.get(s.socialAccountId) ?? {};
    if (s.capturedAt < input.start) a.before = s.followers!;
    else {
      a.first ??= s.followers!;
      a.last = s.followers!;
    }
    accounts.set(s.socialAccountId, a);
  }
  let followersGained = 0;
  for (const a of accounts.values()) if (a.last != null) followersGained += a.last - (a.before ?? a.first!);

  const nextMonthPlan = [...input.upcoming]
    .sort((a, b) => +a.scheduledAt - +b.scheduledAt)
    .map((u) => {
      const day = u.scheduledAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const line = (u.caption ?? "").split("\n")[0]!.trim().slice(0, 80);
      return `${day}, ${u.platform}${line ? `: ${line}` : ""}`;
    });

  return {
    views: [...byPost.values()].reduce((a, b) => a + b, 0),
    followersGained,
    posts: byPost.size,
    topPostId,
    nextMonthPlan,
  };
}

/** Build one brand's report for a month from the database. Read-only. */
export async function buildMonthlyReport(clientId: string, month: string): Promise<MonthlyReport> {
  const prisma = getPrisma();
  const { start, end, nextEnd } = monthBounds(month);
  const [posted, accounts, upcoming, run] = await Promise.all([
    prisma.postTarget.findMany({
      where: { post: { clientId, deletedAt: null }, status: "posted", publishedAt: { gte: start, lt: end } },
      select: { postId: true, postMetrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true } } },
    }),
    prisma.socialAccount.findMany({ where: { clientId, deletedAt: null }, select: { id: true } }),
    prisma.postTarget.findMany({
      where: { post: { clientId, deletedAt: null }, status: "scheduled", scheduledAt: { gte: end, lt: nextEnd } },
      select: { platform: true, scheduledAt: true, caption: true },
    }),
    prisma.monthlyReportRun.findUnique({ where: { clientId_month: { clientId, month } } }),
  ]);
  const snapshots = accounts.length
    ? await prisma.metricSnapshot.findMany({
        where: { socialAccountId: { in: accounts.map((a) => a.id) }, capturedAt: { lt: end } },
        select: { socialAccountId: true, capturedAt: true, followers: true },
      })
    : [];
  const summary = summarizeMonth({
    posted: posted.map((t) => ({ postId: t.postId, views: t.postMetrics[0]?.views ?? null })),
    snapshots,
    upcoming: upcoming.map((u) => ({ ...u, scheduledAt: u.scheduledAt! })),
    start,
  });
  return {
    id: run?.id ?? `${clientId}:${month}`,
    brandId: clientId,
    month,
    ...summary,
    sentAt: run?.sentAt?.toISOString() ?? null,
  };
}

export function reportEmail(brandName: string, monthLabel: string, r: MonthlyReport): { subject: string; text: string } {
  const plan = r.nextMonthPlan.length ? r.nextMonthPlan.map((p) => `- ${p}`).join("\n") : "- To be scheduled";
  return {
    subject: `${brandName}: your ${monthLabel} report`,
    text: [
      `Here is how ${brandName} did in ${monthLabel}.`,
      "",
      `Views: ${r.views.toLocaleString("en-US")}`,
      `Followers gained: ${r.followersGained.toLocaleString("en-US")}`,
      `Posts: ${r.posts}`,
      "",
      "Coming up next month:",
      plan,
      "",
      "Torerone",
    ].join("\n"),
  };
}

export interface RunResult {
  clientId: string;
  status: "preview" | "sent" | "skipped" | "failed" | "already_sent";
}

/**
 * Build (and, with the kill switch ON, send) every brand's report for one
 * month. Safe to run again: a brand already sent for that month is skipped,
 * so a restart on the 1st never emails a client twice.
 *
 * ponytail: the "already sent" check is read-then-write, fine for the one API
 * process; two servers running this at the same minute would need a claim row.
 */
export async function runMonthlyReports(month: string, mailer: Mailer | null): Promise<RunResult[]> {
  const prisma = getPrisma();
  const results: RunResult[] = [];
  const monthLabel = new Date(monthBounds(month).start.getTime() + 864e5).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    year: "numeric",
  });
  const agencies = await prisma.agency.findMany({ select: { id: true } });
  for (const agency of agencies) {
    const config = await readReportJobConfig(agency.id);
    const clients = await prisma.client.findMany({
      where: { agencyId: agency.id, deletedAt: null },
      select: { id: true, name: true, contactEmail: true },
    });
    for (const client of clients) {
      const key = { clientId_month: { clientId: client.id, month } };
      const prior = await prisma.monthlyReportRun.findUnique({ where: key });
      if (prior?.status === "sent") {
        results.push({ clientId: client.id, status: "already_sent" });
        continue;
      }
      const report = await buildMonthlyReport(client.id, month);
      const recipients = profileEmails(client.contactEmail);
      let status: RunResult["status"] = "preview";
      let error: string | null = null;
      if (config.killSwitch) {
        if (!recipients.length) {
          status = "skipped";
          error = "no email on the client profile";
        } else if (!mailer) {
          status = "failed";
          error = "the Toreronee@gmail.com sender is not connected (GMAIL_REFRESH_TOKEN)";
        } else {
          const mail = reportEmail(client.name, monthLabel, report);
          try {
            for (const to of recipients) await mailer.send({ to, ...mail });
            status = "sent";
          } catch (e) {
            status = "failed";
            error = e instanceof Error ? e.message : String(e);
          }
        }
      }
      const data = { ...report, sentAt: undefined };
      const row = {
        data,
        recipients,
        status,
        error,
        sentAt: status === "sent" ? new Date() : null,
      };
      await prisma.monthlyReportRun.upsert({ where: key, create: { clientId: client.id, month, ...row }, update: row });
      results.push({ clientId: client.id, status });
    }
  }
  return results;
}

/**
 * The in-app schedule: checks hourly and runs on the 1st of the month (ET),
 * the equivalent of cron "0 * 1 * *" in New York. Hourly rather than once so
 * a server that was down at midnight still runs that day; the per-brand
 * "already sent" check makes the repeats harmless.
 */
export function startMonthlyReportJob(log: FastifyBaseLogger, mailer: Mailer | null): () => void {
  const tick = async () => {
    const month = reportMonthFor(new Date());
    if (!month) return;
    try {
      const results = await runMonthlyReports(month, mailer);
      const sent = results.filter((r) => r.status === "sent").length;
      if (sent) log.info(`[reports] monthly report ${month}: sent ${sent}`);
    } catch (err) {
      log.error({ err }, "monthly report job failed");
    }
  };
  const timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();
  const boot = setTimeout(() => void tick(), 60_000);
  boot.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(boot);
  };
}
