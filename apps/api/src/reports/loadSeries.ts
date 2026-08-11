import type { DayPoint } from "@toreroflow/core";

/**
 * A client's captured daily history, keyed "platform:platformPostId".
 *
 * That key is the same one buildMergedPosts puts on every post, so a report
 * card finds its own series by identity rather than by matching titles or
 * dates. One query per report rather than one per card.
 *
 * ExternalVideoMetric has been accumulating a row per video per UTC day since
 * it shipped and this is its first reader.
 */
export async function loadSeries(
  prisma: {
    externalVideoMetric: { findMany(args: unknown): Promise<unknown[]> };
  },
  clientId: string,
): Promise<Map<string, DayPoint[]>> {
  const rows = (await prisma.externalVideoMetric.findMany({
    where: { externalVideo: { socialAccount: { clientId, deletedAt: null } } },
    select: {
      views: true,
      capturedOn: true,
      externalVideo: { select: { platform: true, platformVideoId: true } },
    },
    orderBy: { capturedOn: "asc" },
  })) as Array<{
    views: number;
    capturedOn: Date;
    externalVideo: { platform: string; platformVideoId: string };
  }>;

  const series = new Map<string, DayPoint[]>();
  for (const r of rows) {
    const key = `${r.externalVideo.platform}:${r.externalVideo.platformVideoId}`;
    const list = series.get(key) ?? [];
    list.push({ capturedOn: r.capturedOn.toISOString().slice(0, 10), views: r.views });
    series.set(key, list);
  }
  return series;
}
