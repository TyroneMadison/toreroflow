import type { FastifyReply, FastifyRequest } from "fastify";

/** onRequest hook: rejects requests without a valid operator JWT. */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.status(401).send({ error: "unauthorized" });
  }
}
