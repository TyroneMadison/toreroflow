import type { FastifyReply, FastifyRequest } from "fastify";
import { botAllowed } from "../auth/botAccess";

/**
 * onRequest hook: rejects requests without a valid operator JWT, and holds
 * bot tokens to the botAccess whitelist.
 *
 * Enforced here rather than per-route because this hook is the one door every
 * authenticated route already walks through: a new route is bot-closed by
 * default, and there is no second place to forget.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.status(401).send({ error: "unauthorized" });
    return;
  }
  if (request.user.role === "bot" && !botAllowed(request.method, request.url)) {
    await reply.status(403).send({
      error: "bot tokens can upload, write copy and schedule; this route needs the operator",
    });
  }
}
