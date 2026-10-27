import type { FastifyInstance, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPrisma } from "@toreroflow/db";
import {
  ApprovalCommentCreateSchema,
  ApprovalDecisionSchema,
  ApprovalLinkCreateSchema,
} from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { rateLimiter } from "../ideas/rateLimit";

/**
 * Client approval links: one per video version, signed, expiring, revocable.
 *
 * The token is "<link id>.<HMAC of the id and the expiry>", so it cannot be
 * forged, cannot be stretched past its expiry, and is never stored. The
 * public page /a/:token needs no login and is rate limited.
 */

export function approvalToken(id: string, expiresAt: Date, secret = env.JWT_SECRET): string {
  const sig = createHmac("sha256", secret).update(`approval|${id}|${expiresAt.getTime()}`).digest("base64url");
  return `${id}.${sig}`;
}

type Link = { id: string; mediaAssetId: string; expiresAt: Date; revokedAt: Date | null; status: string };
const linkView = (l: Link) => ({
  id: l.id,
  versionId: l.mediaAssetId,
  token: approvalToken(l.id, l.expiresAt),
  url: `/a/${approvalToken(l.id, l.expiresAt)}`,
  expiresAt: l.expiresAt.toISOString(),
  revokedAt: l.revokedAt?.toISOString() ?? null,
  status: l.status,
});

export async function approvalLinkRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";

  app.post("/approval-links", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot share videos" });
    const body = ApprovalLinkCreateSchema.parse(request.body);
    const version = await prisma.mediaAsset.findFirst({
      where: { id: body.versionId, kind: "video", client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!version) return reply.status(404).send({ error: "video version not found" });
    const link = await prisma.approvalLink.create({
      data: {
        mediaAssetId: version.id,
        createdById: request.user.bot ? `bot:${request.user.bot}` : request.user.sub,
        expiresAt: new Date(Date.now() + body.expiresInHours * 3600_000),
      },
    });
    return reply.status(201).send(linkView(link));
  });

  app.get<{ Querystring: { versionId?: string } }>("/approval-links", async (request) => {
    const links = await prisma.approvalLink.findMany({
      where: {
        mediaAsset: { client: { agencyId: request.user.agencyId } },
        ...(request.query.versionId ? { mediaAssetId: request.query.versionId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return { links: links.map(linkView) };
  });

  app.delete<{ Params: { id: string } }>("/approval-links/:id", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change links" });
    const link = await prisma.approvalLink.findFirst({
      where: { id: request.params.id, mediaAsset: { client: { agencyId: request.user.agencyId } } },
      select: { id: true, revokedAt: true },
    });
    if (!link) return reply.status(404).send({ error: "link not found" });
    if (!link.revokedAt) await prisma.approvalLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    return { ok: true };
  });
}

/** The client's side: no login, 60 requests a minute per IP. */
export async function publicApprovalRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const allow = rateLimiter(60_000, 60);

  /** The link a token names, or the reply that was already sent. */
  async function open(token: string, ip: string, reply: FastifyReply) {
    if (!allow(ip)) return void reply.status(429).send({ error: "too many requests, slow down" });
    const dot = token.lastIndexOf(".");
    const id = dot > 0 ? token.slice(0, dot) : "";
    const link = id
      ? await prisma.approvalLink.findUnique({
          where: { id },
          include: { mediaAsset: { select: { originalName: true, storageKey: true, durationSec: true } } },
        })
      : null;
    const expected = link ? Buffer.from(approvalToken(link.id, link.expiresAt)) : null;
    const given = Buffer.from(token);
    // 404 for anything that is not a real token: a guess learns nothing.
    if (!link || !expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return void reply.status(404).send({ error: "not found" });
    }
    if (link.revokedAt) return void reply.status(410).send({ error: "this link was turned off, ask for a new one" });
    if (link.expiresAt <= new Date()) return void reply.status(410).send({ error: "this link has expired, ask for a new one" });
    return link;
  }

  async function page(linkId: string) {
    const link = await prisma.approvalLink.findUniqueOrThrow({
      where: { id: linkId },
      include: {
        mediaAsset: { select: { originalName: true, storageKey: true, durationSec: true } },
        comments: { orderBy: [{ atMs: "asc" }, { createdAt: "asc" }] },
      },
    });
    return {
      status: link.status,
      expiresAt: link.expiresAt.toISOString(),
      video: { name: link.mediaAsset.originalName, url: fileLink(link.mediaAsset.storageKey), durationSec: link.mediaAsset.durationSec },
      comments: link.comments.map((c) => ({ id: c.id, atMs: c.atMs, body: c.body, createdAt: c.createdAt.toISOString() })),
    };
  }

  app.get<{ Params: { token: string } }>("/a/:token", async (request, reply) => {
    const link = await open(request.params.token, request.ip, reply);
    return link ? page(link.id) : reply;
  });

  app.post<{ Params: { token: string } }>("/a/:token/comments", async (request, reply) => {
    const link = await open(request.params.token, request.ip, reply);
    if (!link) return reply;
    const body = ApprovalCommentCreateSchema.parse(request.body);
    const durationMs = link.mediaAsset.durationSec != null ? Math.ceil(link.mediaAsset.durationSec * 1000) : null;
    if (body.atMs != null && durationMs != null && body.atMs > durationMs) {
      return reply.status(400).send({ error: "that moment is past the end of the video" });
    }
    const c = await prisma.approvalComment.create({ data: { linkId: link.id, atMs: body.atMs ?? null, body: body.body } });
    return reply.status(201).send({ id: c.id, atMs: c.atMs, body: c.body, createdAt: c.createdAt.toISOString() });
  });

  /** Approve or Request changes. The latest answer stands until the link expires. */
  app.post<{ Params: { token: string } }>("/a/:token/decision", async (request, reply) => {
    const link = await open(request.params.token, request.ip, reply);
    if (!link) return reply;
    const { decision } = ApprovalDecisionSchema.parse(request.body);
    await prisma.approvalLink.update({ where: { id: link.id }, data: { status: decision, decidedAt: new Date() } });
    return page(link.id);
  });
}
