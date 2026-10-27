import type { FastifyReply, FastifyRequest } from "fastify";
import type { BotIdentity, Principal } from "@toreroflow/contracts";
import { botAllowed, resolveBotIdentity } from "../auth/botAccess";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth on bot tokens: the bot's resolved identity. */
    botIdentity?: BotIdentity;
  }
}

/**
 * onRequest hook: rejects requests without a valid operator JWT, and holds
 * bot tokens to the botAccess whitelist unless their identity has fullAccess.
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
  if (request.user.role !== "bot") return;
  request.botIdentity ??= await resolveBotIdentity(request.user.agencyId, request.user.bot);
  if (!request.botIdentity.fullAccess && !botAllowed(request.method, request.url)) {
    await reply.status(403).send({
      error: "bot tokens can upload, write copy, set covers and schedule; this route needs the operator",
    });
  }
}

/** Who is asking, for scope checks. Call after requireAuth. Viewers are not told apart here. */
export function principalOf(request: FastifyRequest): Principal {
  if (request.user.role !== "bot") return { role: "owner" };
  return { role: "bot", bot: request.botIdentity! };
}
