import type { PrismaClient } from "@toreroflow/db";
import { buildReportSlug, clientSlug, REPORT_SLUG_SUFFIX } from "@toreroflow/core";

/** Prisma's code for "a unique constraint rejected this write". */
const UNIQUE_VIOLATION = "P2002";

export interface SluggableClient {
  id: string;
  name: string;
  reportSlug: string | null;
}

/**
 * The client's permanent report path, assigning one the first time it is
 * needed.
 *
 * Assigned once and deliberately never regenerated when a client is renamed.
 * The link may already be sitting in that client's inbox, and a report that
 * 404s is worse than one whose path spells a former name.
 *
 * Two clients can legitimately share a name, so a taken slug is disambiguated
 * with a counter in the same shape the backfill migration used. The insert is
 * allowed to lose the race and retry rather than being guarded by a read,
 * because a read-then-write cannot be made safe against a concurrent publish.
 */
export async function ensureReportSlug(
  prisma: PrismaClient,
  client: SluggableClient,
): Promise<string> {
  if (client.reportSlug) return client.reportSlug;

  const base = clientSlug(client.name);
  for (let n = 1; n <= 50; n++) {
    const candidate =
      n === 1 ? buildReportSlug(client.name) : `${base}-${n}-${REPORT_SLUG_SUFFIX}`;
    try {
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: { reportSlug: candidate },
        select: { reportSlug: true },
      });
      return updated.reportSlug!;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code: unknown }).code
          : null;
      if (code !== UNIQUE_VIOLATION) throw error;
      // Another client already holds this path; try the next counter.
    }
  }
  throw new Error(`could not find a free report path for "${client.name}"`);
}
