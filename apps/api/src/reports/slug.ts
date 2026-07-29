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

  const owner = await prisma.client.findUnique({
    where: { id: client.id },
    select: { agencyId: true },
  });

  /**
   * Frees a path still held by an offboarded client of the same agency.
   *
   * Offboarding takes their page off the web, so nobody can be holding that
   * link any more and keeping the path reserved forever serves nobody. A
   * client who leaves and comes back should get their own address again
   * rather than a "-2" that exists only because of a row nothing points at.
   *
   * Scoped to one agency, because the path is globally unique and releasing
   * one belonging to somebody else would be reaching across a tenant
   * boundary. A live client's path is never touched.
   */
  const reclaim = async (candidate: string): Promise<boolean> => {
    if (!owner) return false;
    const held = await prisma.client.findFirst({
      where: { reportSlug: candidate, deletedAt: { not: null }, agencyId: owner.agencyId },
      select: { id: true },
    });
    if (!held) return false;
    await prisma.client.update({ where: { id: held.id }, data: { reportSlug: null } });
    return true;
  };

  const base = clientSlug(client.name);
  for (let n = 1; n <= 50; n++) {
    const candidate =
      n === 1 ? buildReportSlug(client.name) : `${base}-${n}-${REPORT_SLUG_SUFFIX}`;
    // Two attempts: the second only happens if the first lost to an
    // offboarded client and freeing it opened the path up.
    for (let attempt = 0; attempt < 2; attempt++) {
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
        // Held by someone. If they are gone, take it back and retry once;
        // otherwise move on to the next counter.
        if (attempt === 1 || !(await reclaim(candidate))) break;
      }
    }
  }
  throw new Error(`could not find a free report path for "${client.name}"`);
}
