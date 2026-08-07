import { knowledgeContext } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";

/**
 * What we know about one brand, as one block of plain text for a prompt.
 *
 * Every AI feature reads this same block, and that is the whole point of it
 * living in one place. Before this each feature grew its own hand-rolled join,
 * which is how the analyzer and the carousel writer ended up disagreeing about
 * what a brand does: one of them could see the niche profile and the dropped
 * files, the other only ever saw typed notes.
 *
 * Only files that finished extracting are worth sending. A row still
 * processing has nothing in it yet, and a failed one never will.
 *
 * Callers paste the result under a line of their own and skip that line
 * entirely when this returns "", which is why an empty brand has to give back
 * nothing at all rather than a page of empty headings.
 */
export async function groundingFor(clientId: string): Promise<string> {
  const prisma = getPrisma();
  const [notes, files, client, ideas] = await Promise.all([
    prisma.knowledgeNote.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { title: true, body: true },
    }),
    prisma.knowledgeFile.findMany({
      where: { clientId, status: "ready" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { name: true, extractedText: true },
    }),
    prisma.client.findUnique({ where: { id: clientId }, select: { nicheProfile: true } }),
    prisma.contentIdea.findMany({
      where: { clientId, status: { in: ["idea", "scripting", "ready"] } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { text: true, status: true },
    }),
  ]);
  return knowledgeContext({
    notes,
    files,
    nicheProfile: client?.nicheProfile ?? undefined,
    ideas,
  });
}
