import type { FastifyReply, FastifyRequest } from "fastify";
import { isViewer } from "../auth/actingUser";

/**
 * Marking read (F7) is the one change a viewer may make: it only clears the
 * team's unread counts and sends nobody anything (the one-thread route skips
 * Instagram's "Seen" for a viewer). Still scoped like every DM route: the
 * handlers only find brands and threads of the caller's own agency.
 */
export const VIEWER_MAY = new Set(["/clients/:id/dm/threads/:threadId/read", "/clients/:id/dm/threads/read-all"]);

/**
 * Who may change anything in DMs: an operator, and nobody else.
 *
 * Viewers read threads and contacts and never send, tag or pause (they may
 * mark read, VIEWER_MAY): a reply goes to a real person as the client, and
 * "viewer" means exactly not that. A viewer token from before F2 carries no role, so isViewer() checks
 * the user row for those. Bots are read-only here too, Polly included, whatever their access
 * elsewhere (docs/bot-api.md): an automation that can message strangers as a
 * client is the blast radius the bot whitelist exists to bound.
 *
 * An onRequest hook on the whole DM plugin rather than a line in each handler,
 * so a route added later is guarded without anyone remembering to.
 * dm/dm.check.ts walks every non-GET route these plugins register and fails
 * if one answers a viewer with anything but 403.
 */
export async function dmWriteGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || reply.sent) return;
  const role = (request.user as { role?: string } | undefined)?.role;
  if (role === "bot") {
    await reply.status(403).send({ error: "bot tokens can read DMs but cannot send or change them", reason: "bot_read_only" });
  } else if (!VIEWER_MAY.has(request.routeOptions.url ?? "") && (await isViewer(request))) {
    await reply.status(403).send({ error: "viewers can read DMs but cannot send or change them", reason: "viewer_read_only" });
  }
}
