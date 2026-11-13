import type { FastifyRequest } from "fastify";
import { getPrisma } from "@toreroflow/db";

/** Phase 8: a readable actor for the team activity feed ("tyrone", "bot:ops"). */
const names = new Map<string, string>();
export async function actorName(request: FastifyRequest): Promise<string> {
  const u = request.user;
  if (u.bot) return `bot:${u.bot}`;
  const hit = names.get(u.sub);
  if (hit) return hit;
  const user = await getPrisma().user.findUnique({ where: { id: u.sub }, select: { email: true } });
  const name = user?.email.split("@")[0] ?? "someone";
  names.set(u.sub, name);
  return name;
}

/** Fire-and-forget: an activity row must never fail the action it describes. */
export function logActivity(
  request: FastifyRequest,
  row: { clientId: string; action: string; candidateId?: string | null; jobId?: string | null; projectId?: string | null; detail?: string | null },
): void {
  void (async () => {
    const actor = await actorName(request);
    await getPrisma().clipActivity.create({ data: { ...row, actor, detail: row.detail?.slice(0, 200) ?? null } });
  })().catch((e: unknown) => request.log.warn({ err: e }, "activity log failed"));
}
