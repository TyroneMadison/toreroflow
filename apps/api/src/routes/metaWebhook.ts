import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { enqueue, getPrisma, secretsMatch } from "@toreroflow/db";
import { parseSignedRequest, verifyHubSignature } from "@toreroflow/publishers";
import { env, missingMetaConfig } from "../env";

/**
 * Meta's doors into this API: the webhook and the two account callbacks.
 *
 * Public by necessity (Meta has no token of ours), so each request proves
 * itself instead: the handshake with META_VERIFY_TOKEN, deliveries with an
 * HMAC of the raw body, the callbacks with signed_request. Nothing here is
 * behind requireAuth and nothing here reads or returns agency data.
 *
 * Dark launch: until every native Instagram setting is on the server, every
 * route here answers 503 with a machine-readable reason and the inbox keeps
 * reading through Zernio. The reason is generic on purpose: a stranger
 * probing this URL learns that it is off, not which setting is missing.
 */

const OFF = {
  error: "Instagram DMs are not set up on this server yet",
  reason: "instagram_not_configured",
} as const;

const secrets = () => [env.META_IG_APP_SECRET, env.META_APP_SECRET].filter(Boolean);

function off(reply: FastifyReply): FastifyReply | null {
  return missingMetaConfig().length ? reply.status(503).send(OFF) : null;
}

export async function metaWebhookRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  /*
   * Raw bytes for this plugin only. The HMAC is over exactly what Meta sent,
   * and a parse-then-stringify round trip changes bytes (escaped emoji), which
   * fails every signature that carries one. Encapsulated: the rest of the API
   * keeps its JSON parser.
   */
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  /** The handshake Meta runs when the callback URL is saved in its dashboard. */
  app.get<{ Querystring: Record<string, string | undefined> }>("/webhooks/meta", async (request, reply) => {
    if (off(reply)) return reply;
    const q = request.query;
    const ok =
      q["hub.mode"] === "subscribe" &&
      typeof q["hub.verify_token"] === "string" &&
      secretsMatch(q["hub.verify_token"], env.META_VERIFY_TOKEN);
    if (!ok) return reply.status(403).send({ error: "verification failed" });
    return reply.type("text/plain").send(String(q["hub.challenge"] ?? ""));
  });

  /**
   * A delivery. Stored first, processed by the worker, answered at once.
   *
   * Meta retries anything that is not a fast 200 and disables a webhook that
   * keeps failing, so the only work here is one insert and one enqueue. A bad
   * signature is refused and recorded without its body: that is what a wrong
   * app secret looks like, and /dm/status says so instead of the inbox going
   * quiet.
   */
  app.post("/webhooks/meta", async (request, reply) => {
    if (off(reply)) return reply;
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers["x-hub-signature-256"];
    const valid = verifyHubSignature(raw, typeof signature === "string" ? signature : undefined, secrets());
    if (!valid) {
      request.log.warn({ bytes: raw.length }, "meta webhook: bad or missing signature");
      await prisma.dmWebhookEvent.create({ data: { signatureOk: false, error: "bad or missing signature" } });
      return reply.status(403).send({ error: "invalid signature" });
    }
    let payload: { object?: unknown };
    try {
      payload = JSON.parse(raw.toString("utf8")) as { object?: unknown };
    } catch {
      return reply.status(400).send({ error: "body is not JSON" });
    }
    const event = await prisma.dmWebhookEvent.create({
      data: {
        object: typeof payload.object === "string" ? payload.object : null,
        payload: payload as object,
        signatureOk: true,
      },
      select: { id: true },
    });
    // Stored is safe: if the queue is down, the worker's 5-minute sweep picks
    // the event up, so this still answers 200 and Meta does not retry.
    await enqueue("dm", { kind: "ingest", eventId: event.id }, { key: `ingest:${event.id}`, retryLimit: 5, retryDelaySeconds: 30, retryBackoff: true }).catch(
      (err: unknown) => request.log.error({ err: err instanceof Error ? err.message : err }, "meta webhook: enqueue failed, left for the sweep"),
    );
    return { ok: true };
  });

  /**
   * The account owner removed the app in Instagram. The token is dead, so it
   * is dropped and the inbox says "Reconnect" rather than failing every send.
   */
  app.post<{ Body: { signed_request?: string } }>("/webhooks/meta/deauthorize", async (request, reply) => {
    if (off(reply)) return reply;
    const who = parseSignedRequest(request.body?.signed_request, secrets());
    if (!who) return reply.status(403).send({ error: "invalid signed_request" });
    await prisma.dmAccount.updateMany({
      where: { platform: "instagram", externalId: who.userId, transport: "native" },
      data: { status: "revoked", accessTokenEnc: null, error: "The account removed Torerone's app in Instagram." },
    });
    return { ok: true };
  });

  /**
   * Meta's data deletion callback: the account asked for its data to go.
   * Everything stored for that Instagram account (token, contacts, threads,
   * messages) is deleted now; the account falls back to the Zernio inbox.
   */
  app.post<{ Body: { signed_request?: string } }>("/webhooks/meta/data-deletion", async (request, reply) => {
    if (off(reply)) return reply;
    const who = parseSignedRequest(request.body?.signed_request, secrets());
    if (!who) return reply.status(403).send({ error: "invalid signed_request" });
    await prisma.dmAccount.deleteMany({ where: { platform: "instagram", externalId: who.userId } });
    const code = randomUUID();
    return {
      url: `${env.OAUTH_REDIRECT_BASE}/webhooks/meta/data-deletion?code=${code}`,
      confirmation_code: code,
    };
  });

  /** Where Meta's confirmation link points. Deletion is immediate, so it only ever says done. */
  app.get("/webhooks/meta/data-deletion", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send("Torerone has deleted the Instagram DM data for this request. Nothing else is kept."),
  );
}
