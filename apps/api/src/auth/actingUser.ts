import type { FastifyRequest } from "fastify";
import { getPrisma } from "@toreroflow/db";

/**
 * The real user a request acts as.
 *
 * A token's `sub` is normally a user id. A bot token minted from a server
 * script carries a placeholder `sub` instead ("deploy-script"), and anything
 * that records who did something (a post's creator is a foreign key) fails
 * on it. So a bot whose `sub` is not a user of its agency acts as that
 * agency's first owner: the person who issued it. A human token with an
 * unknown `sub` gets null and is refused by the caller, as before.
 */
export async function actingUserId(request: FastifyRequest): Promise<string | null> {
  const prisma = getPrisma();
  const { sub, agencyId, role } = request.user;
  const own = await prisma.user.findFirst({ where: { id: sub, agencyId }, select: { id: true } });
  if (own) return own.id;
  if (role !== "bot") return null;
  const owner = await prisma.user.findFirst({
    where: { agencyId, role: "owner" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return owner?.id ?? null;
}
