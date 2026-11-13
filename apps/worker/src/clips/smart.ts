/**
 * Phase 9 worker side: the client's trend terms and judge tuning, and the
 * frames a clip's visual score reads. All from data already in Postgres or
 * on disk; no model, no web search.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Prisma, getPrisma } from "@toreroflow/db";
import {
  median,
  trendTermsFrom,
  tuneJudge,
  type ClipPerformance,
  type FaceTrack,
  type JudgeTuning,
  type TrendTerm,
} from "@toreroflow/core";
import { env } from "../env";
import { reframeStatusPath } from "../edit";

const prisma = getPrisma();
const DAY = 24 * 3600_000;

export interface ClientTrends {
  terms: TrendTerm[];
  at: string;
  /** Topics typed in the Smart AI card; kept across rebuilds. */
  manual?: string[];
  sources: { niche: boolean; keywords: number; topPosts: number; liked: number };
}

function keywordsOf(captionKeywords: unknown): string[] {
  if (!Array.isArray(captionKeywords)) return [];
  return captionKeywords.flatMap((k) => (k && Array.isArray((k as { keywords?: unknown }).keywords) ? ((k as { keywords: unknown[] }).keywords.filter((x) => typeof x === "string") as string[]) : []));
}

/** Rebuilds and saves one client's trend terms. */
export async function refreshClientTrends(clientId: string): Promise<ClientTrends | null> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { nicheProfile: true, captionKeywords: true, trends: true } });
  if (!client) return null;
  const manual = ((client.trends as ClientTrends | null)?.manual ?? []).filter((m) => typeof m === "string");
  const niche = (client.nicheProfile as { niche?: string } | null)?.niche ?? null;
  const keywords = [...manual, ...keywordsOf(client.captionKeywords)];
  const since = new Date(Date.now() - 60 * DAY);
  const targets = await prisma.postTarget.findMany({
    where: { post: { clientId, deletedAt: null }, caption: { not: null }, postMetrics: { some: { capturedAt: { gte: since } } } },
    select: { caption: true, postMetrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true } } },
    take: 400,
  });
  const posts = targets
    .map((t) => ({ text: t.caption ?? "", views: t.postMetrics[0]?.views ?? 0 }))
    .filter((p) => p.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);
  const liked = await prisma.clipCandidate.findMany({
    where: { job: { clientId }, feedback: { startsWith: "up" } },
    select: { text: true, title: true },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const terms = trendTermsFrom({ niche, keywords, topPosts: posts, liked: liked.map((l) => `${l.title} ${l.text ?? ""}`) });
  const out: ClientTrends = {
    terms,
    at: new Date().toISOString(),
    manual,
    sources: { niche: !!niche, keywords: keywords.length, topPosts: posts.length, liked: liked.length },
  };
  await prisma.client.update({ where: { id: clientId }, data: { trends: out as unknown as Prisma.InputJsonValue } });
  return out;
}

/** The saved terms when fresh (under a day old), else rebuilt. */
export async function clientTrends(clientId: string): Promise<ClientTrends | null> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { trends: true } });
  const t = c?.trends as ClientTrends | null;
  if (t?.at && Date.now() - Date.parse(t.at) < DAY) return t;
  return refreshClientTrends(clientId);
}

/** Daily: every client with clip jobs gets fresh terms. */
export async function refreshAllTrends(): Promise<number> {
  const clients = await prisma.clipJob.findMany({ distinct: ["clientId"], select: { clientId: true } });
  for (const c of clients) await refreshClientTrends(c.clientId).catch((e: unknown) => console.error("[trends]", c.clientId, e));
  return clients.length;
}

/** Rebuilds the client's judge tuning from feedback and posted-clip views. */
export async function refreshJudgeTuning(clientId: string): Promise<JudgeTuning> {
  const rows = await prisma.clipCandidate.findMany({
    where: { job: { clientId }, OR: [{ feedback: { not: null } }, { perf: { not: Prisma.DbNull } }], hook: { gt: 0 } },
    select: { hook: true, flow: true, value: true, trend: true, feedback: true, perf: true, title: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const views = rows.map((r) => (r.perf as ClipPerformance | null)?.views ?? null);
  const mid = median(views.filter((v): v is number => v != null && v > 0));
  const t = tuneJudge(
    rows.map((r, i) => ({
      sub: { hook: r.hook, flow: r.flow, value: r.value, trend: r.trend },
      feedback: r.feedback,
      perf: views[i] != null && mid > 0 ? views[i]! / mid : null,
      title: r.title,
    })),
  );
  const out = { ...t, at: new Date().toISOString() };
  await prisma.client.update({ where: { id: clientId }, data: { judgeTuning: out as unknown as Prisma.InputJsonValue } });
  return out;
}

/** Scene cuts and the sampled face frames the reframe pass left on disk. */
export async function sourceFrames(source: { storageKey: string; id: string }): Promise<{ cuts: number[]; track: FaceTrack | null }> {
  try {
    const st = JSON.parse(await fs.readFile(reframeStatusPath(source.storageKey, source.id), "utf8")) as {
      status: string;
      shots?: { start: number }[];
      facesKey?: string;
    };
    if (st.status !== "ready") return { cuts: [], track: null };
    const cuts = (st.shots ?? []).map((s) => s.start).filter((t) => t > 0);
    const track = st.facesKey
      ? (JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, st.facesKey), "utf8")) as FaceTrack)
      : null;
    return { cuts, track };
  } catch {
    return { cuts: [], track: null };
  }
}
