import type { FastifyInstance } from "fastify";
import { getPrisma, setPriority, uploadPriority } from "@toreroflow/db";
import {
  QueuePriorityRequestSchema,
  QueueReorderRequestSchema,
  type QueueItem,
} from "@toreroflow/contracts";
import { principalOf, requireAuth } from "../plugins/requireAuth";

/**
 * W3 upload queue: the posts still waiting to upload, in upload order.
 * Client rush jumps ahead and reorder persists position. Upload order is the
 * only thing that changes: the calendar, every scheduled time and the daily
 * counter read PostTarget.scheduledAt, which nothing here writes. The order
 * reaches the worker as the publish job's pg-boss priority (uploadPriority).
 */
export interface QueueRoutesOptions {
  /** The pg-boss priority write; swapped in tests. */
  setPriority?: typeof setPriority;
}

const WAITING = ["scheduled", "publishing"] as const;

export async function queueRoutes(app: FastifyInstance, opts: QueueRoutesOptions = {}): Promise<void> {
  const prisma = getPrisma();
  const setJobPriority = opts.setPriority ?? setPriority;
  app.addHook("onRequest", requireAuth);

  const waiting = (agencyId: string) =>
    prisma.post.findMany({
      where: {
        deletedAt: null,
        client: { agencyId },
        targets: { some: { status: { in: [...WAITING] } } },
      },
      select: {
        id: true,
        queuePriority: true,
        queuePosition: true,
        targets: { select: { id: true, status: true, scheduledAt: true } },
      },
    });
  type Row = Awaited<ReturnType<typeof waiting>>[number];

  const firstSlot = (p: Row) =>
    Math.min(...p.targets.map((t) => t.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY));

  /** Rush first, then position (unpositioned last), then the earliest slot. */
  const ordered = (rows: Row[]) =>
    [...rows].sort(
      (a, b) =>
        Number(b.queuePriority === "rush") - Number(a.queuePriority === "rush") ||
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
        firstSlot(a) - firstSlot(b),
    );

  const items = (rows: Row[]): QueueItem[] =>
    ordered(rows).map((p, i) => ({
      id: p.id,
      draftId: p.id,
      priority: p.queuePriority,
      position: i,
      state: p.targets.some((t) => t.status === "publishing") ? "uploading" : "queued",
    }));

  /** Re-rank the post's queued publish jobs. Priority only; startAfter is never sent. */
  const rerank = async (p: { queuePriority: "rush" | "normal"; queuePosition: number | null; targets: { id: string; status: string }[] }) => {
    const priority = uploadPriority(p.queuePriority, p.queuePosition);
    for (const t of p.targets) if (t.status === "scheduled") await setJobPriority("publish", t.id, priority);
  };

  const canWrite = (request: Parameters<typeof principalOf>[0]) => principalOf(request).role !== "viewer";

  app.get("/queue", async (request) => ({ items: items(await waiting(request.user.agencyId)) }));

  app.patch("/queue/reorder", async (request, reply) => {
    if (!canWrite(request)) return reply.status(403).send({ error: "viewers cannot reorder the queue" });
    const parsed = QueueReorderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "ids: a non-empty list of unique queue ids" });
    const rows = await waiting(request.user.agencyId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const unknown = parsed.data.ids.filter((id) => !byId.has(id));
    if (unknown.length) return reply.status(404).send({ error: `not in the queue: ${unknown.join(", ")}` });
    await prisma.$transaction(
      parsed.data.ids.map((id, i) => prisma.post.update({ where: { id }, data: { queuePosition: i } })),
    );
    parsed.data.ids.forEach((id, i) => (byId.get(id)!.queuePosition = i));
    for (const id of parsed.data.ids) await rerank(byId.get(id)!);
    return { items: items(rows) };
  });

  app.patch<{ Params: { id: string } }>("/queue/:id/priority", async (request, reply) => {
    if (!canWrite(request)) return reply.status(403).send({ error: "viewers cannot change upload order" });
    const parsed = QueuePriorityRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'priority: "rush" or "normal"' });
    const rows = await waiting(request.user.agencyId);
    const row = rows.find((r) => r.id === request.params.id);
    if (!row) return reply.status(404).send({ error: "not in the queue" });
    await prisma.post.update({ where: { id: row.id }, data: { queuePriority: parsed.data.priority } });
    row.queuePriority = parsed.data.priority;
    await rerank(row);
    return { items: items(rows) };
  });
}
