import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { ContentRequestFormSchema, RequestFormLinkCreateSchema, TrelloIntakeConfigSchema } from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { pushRequestToTrello, readIntakeConfig, TRELLO_INTAKE_SETTING } from "../ideas/trelloIntake";
import { writeSetting } from "../ideas/settings";
import { clientIp, rateLimiter } from "../ideas/rateLimit";

/**
 * The public request form: no login, but only through a brand's signed link
 * (/r/:token), which an operator can rotate or revoke. Every submission is
 * checked in this order: 5 per IP per 10 minutes and 100 per link per day
 * (counted in the database), a live link, the honeypot ("website", hidden in
 * the form, bots fill it), the fields (strict, size capped), Turnstile when
 * TURNSTILE_SECRET_KEY is set (off by default), and an optional reference
 * file whose type is read from its bytes. Each outcome goes to the audit log.
 * The request is stored before Trello is called, so a Trello outage loses
 * nothing.
 */

export const REQUEST_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const REQUEST_JSON_MAX_BYTES = 32 * 1024;
const IP_MAX = 5;
const LINK_MAX = 100;
const FILE_TYPES = ["png", "jpg", "webp", "pdf"] as const;
type FileType = (typeof FILE_TYPES)[number];

/** A file's real type from its first bytes. The name and Content-Type a browser sends are not trusted. */
export function sniffFileType(b: Buffer): FileType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  return null;
}

/** "<link id>.<HMAC of the id>": cannot be forged, never stored, dead once the row is revoked. */
export function requestFormToken(id: string, secret = env.JWT_SECRET): string {
  return `${id}.${createHmac("sha256", secret).update(`request-form|${id}`).digest("base64url")}`;
}

/** Cloudflare's verdict on a Turnstile token. Any network or parse failure is a no. */
export async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    return res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

class Rejected extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fields and the optional file, from JSON or multipart. Empty strings count as not given. */
async function readSubmission(request: FastifyRequest): Promise<{ fields: Record<string, unknown>; file: Buffer | null }> {
  const fields: Record<string, unknown> = {};
  let file: Buffer | null = null;
  if (request.isMultipart()) {
    try {
      const parts = request.parts({ limits: { fileSize: REQUEST_FILE_MAX_BYTES, files: 1, fields: 10, fieldSize: 8 * 1024, parts: 11 } });
      for await (const part of parts) {
        if (part.type === "file") {
          if (part.fieldname !== "file") throw new Rejected(400, "the file field must be named file");
          file = await part.toBuffer();
        } else fields[part.fieldname] = part.value;
      }
    } catch (e) {
      if (e instanceof Rejected) throw e;
      const tooBig = (e as { statusCode?: number }).statusCode === 413;
      throw new Rejected(tooBig ? 413 : 400, tooBig ? "the file is over 10 MB, or the form has too many fields" : "could not read the form");
    }
  } else if (request.body && typeof request.body === "object") Object.assign(fields, request.body);
  // The Turnstile widget names its hidden input this inside a plain HTML form.
  if ("cf-turnstile-response" in fields) {
    fields.turnstileToken ??= fields["cf-turnstile-response"];
    delete fields["cf-turnstile-response"];
  }
  for (const [k, v] of Object.entries(fields)) if (v === "") delete fields[k];
  return { fields, file };
}

export async function publicContentRequestRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const perIp = rateLimiter("request-form-ip", 10 * 60 * 1000, IP_MAX);
  const perLink = rateLimiter("request-form-link", 24 * 3600 * 1000, LINK_MAX);
  const views = rateLimiter("request-form-view", 60 * 1000, 60);
  const audit = (data: { action: string; ip: string; clientId?: string; linkId?: string; detail?: string }) =>
    prisma.requestFormAudit
      .create({ data: { actor: "public", ...data } })
      .catch((err: unknown) => app.log.error({ err }, "request form audit write failed"));

  /** The live link a token names, or the reply that was already sent. */
  async function openLink(token: string, ip: string, reply: FastifyReply) {
    const dot = token.lastIndexOf(".");
    const id = dot > 0 ? token.slice(0, dot) : "";
    const link = id
      ? await prisma.requestFormLink.findUnique({
          where: { id },
          include: { client: { select: { name: true, deletedAt: true } } },
        })
      : null;
    const expected = link ? Buffer.from(requestFormToken(link.id)) : null;
    const given = Buffer.from(token);
    // 404 for anything that is not a real token: a guess learns nothing.
    if (!link || !expected || expected.length !== given.length || !timingSafeEqual(expected, given) || link.client.deletedAt) {
      await audit({ action: "bad_token", ip });
      return void reply.status(404).send({ error: "not found" });
    }
    if (link.revokedAt) {
      await audit({ action: "rejected", ip, clientId: link.clientId, linkId: link.id, detail: "revoked link" });
      return void reply.status(410).send({ error: "this form link was turned off, ask for a new one" });
    }
    return link;
  }

  /** What the form needs to render: the brand, and the Turnstile site key when the captcha is on. */
  app.get<{ Params: { token: string } }>("/r/:token", async (request, reply) => {
    const ip = clientIp(request);
    if (!(await views(ip)).allowed) return reply.status(429).send({ error: "too many requests, slow down" });
    const link = await openLink(request.params.token, ip, reply);
    if (!link) return reply;
    return {
      brandName: link.client.name,
      turnstileSiteKey: env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY || null : null,
      maxFileBytes: REQUEST_FILE_MAX_BYTES,
      fileTypes: [...FILE_TYPES],
    };
  });

  app.post<{ Params: { token: string } }>("/r/:token", { bodyLimit: REQUEST_JSON_MAX_BYTES }, async (request, reply) => {
    const ip = clientIp(request);
    const byIp = await perIp(ip);
    if (!byIp.allowed) {
      // Logged once per window, so a flood cannot flood the audit log too.
      if (byIp.count === IP_MAX + 1) await audit({ action: "rate_limited", ip, detail: "per IP" });
      return reply.status(429).send({ error: "too many requests, try again in a few minutes" });
    }
    const link = await openLink(request.params.token, ip, reply);
    if (!link) return reply;
    const who = { ip, clientId: link.clientId, linkId: link.id };
    const byLink = await perLink(link.id);
    if (!byLink.allowed) {
      if (byLink.count === LINK_MAX + 1) await audit({ action: "rate_limited", ...who, detail: "per link" });
      return reply.status(429).send({ error: "this form has had too many requests today, try again tomorrow" });
    }

    let submission;
    try {
      submission = await readSubmission(request);
    } catch (e) {
      const r = e instanceof Rejected ? e : new Rejected(400, "could not read the form");
      await audit({ action: "rejected", ...who, detail: r.message });
      return reply.status(r.status).send({ error: r.message });
    }
    const { fields, file } = submission;

    // A filled honeypot gets the same answer as a real request and is dropped.
    if (typeof fields.website === "string" && fields.website.trim()) {
      await audit({ action: "rejected", ...who, detail: "honeypot" });
      return reply.status(201).send({ ok: true });
    }
    const parsed = ContentRequestFormSchema.safeParse(fields);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const error = `${issue.path.join(".") || "form"}: ${issue.message}`;
      await audit({ action: "rejected", ...who, detail: error.slice(0, 500) });
      return reply.status(400).send({ error });
    }
    const body = parsed.data;
    if (env.TURNSTILE_SECRET_KEY && !(body.turnstileToken && (await verifyTurnstile(body.turnstileToken, ip)))) {
      await audit({ action: "captcha_failed", ...who });
      return reply.status(403).send({ error: "the captcha check failed, reload the page and try again" });
    }
    const type = file ? sniffFileType(file) : null;
    if (file && !type) {
      await audit({ action: "rejected", ...who, detail: "file type" });
      return reply.status(415).send({ error: "the file must be a PNG, JPEG, WebP or PDF" });
    }

    const saved = await prisma.contentRequest.create({
      data: {
        clientId: link.clientId,
        linkId: link.id,
        what: body.what,
        dueDate: body.dueDate ?? null,
        footageUrl: body.footageUrl ?? null,
        notes: body.notes ?? null,
      },
    });
    if (file && type) {
      const key = `${link.clientId}/requests/${saved.id}.${type}`;
      await fs.mkdir(path.dirname(path.join(env.STORAGE_DIR, key)), { recursive: true });
      await fs.writeFile(path.join(env.STORAGE_DIR, key), file);
      await prisma.contentRequest.update({ where: { id: saved.id }, data: { attachmentKey: key } });
    }
    await audit({ action: "submitted", ...who, detail: saved.id });
    await pushRequestToTrello(saved.id);
    return reply.status(201).send({ ok: true });
  });
}

type FormLink = { id: string; clientId: string; revokedAt: Date | null; createdAt: Date };
const formLinkView = (l: FormLink) => ({
  id: l.id,
  brandId: l.clientId,
  token: requestFormToken(l.id),
  url: `/r/${requestFormToken(l.id)}`,
  revokedAt: l.revokedAt?.toISOString() ?? null,
  createdAt: l.createdAt.toISOString(),
});

/** Operator side: the request list with card status, Retry, the intake config, and the form links. */
export async function contentRequestRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";
  const actor = (request: { user: { sub: string; bot?: string } }) => (request.user.bot ? `bot:${request.user.bot}` : request.user.sub);
  const ownLink = (agencyId: string, id: string) => prisma.requestFormLink.findFirst({ where: { id, client: { agencyId } } });

  app.get<{ Querystring: { brandId?: string } }>("/requests", async (request) => {
    const requests = await prisma.contentRequest.findMany({
      where: { client: { agencyId: request.user.agencyId }, ...(request.query.brandId ? { clientId: request.query.brandId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { requests: requests.map((r) => ({ ...r, attachmentUrl: r.attachmentKey ? fileLink(r.attachmentKey) : null })) };
  });

  app.post<{ Params: { id: string } }>("/requests/:id/retry", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const req = await prisma.contentRequest.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!req) return reply.status(404).send({ error: "request not found" });
    return pushRequestToTrello(req.id);
  });

  app.get<{ Querystring: { brandId?: string } }>("/request-links", async (request) => {
    const links = await prisma.requestFormLink.findMany({
      where: { client: { agencyId: request.user.agencyId }, ...(request.query.brandId ? { clientId: request.query.brandId } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return { links: links.map(formLinkView) };
  });

  /** A new link for a brand. Older links keep working until rotated or revoked. */
  app.post("/request-links", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change form links" });
    const { brandId } = RequestFormLinkCreateSchema.parse(request.body);
    const brand = await prisma.client.findFirst({
      where: { id: brandId, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    const link = await prisma.requestFormLink.create({ data: { clientId: brand.id, createdById: actor(request) } });
    await prisma.requestFormAudit.create({ data: { action: "link_created", actor: actor(request), clientId: brand.id, linkId: link.id } });
    return reply.status(201).send(formLinkView(link));
  });

  /** Turn this link off and hand back its replacement, in one step. */
  app.post<{ Params: { id: string } }>("/request-links/:id/rotate", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change form links" });
    const old = await ownLink(request.user.agencyId, request.params.id);
    if (!old) return reply.status(404).send({ error: "link not found" });
    const link = await prisma.$transaction(async (tx) => {
      if (!old.revokedAt) await tx.requestFormLink.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      const next = await tx.requestFormLink.create({ data: { clientId: old.clientId, createdById: actor(request) } });
      await tx.requestFormAudit.create({
        data: { action: "link_rotated", actor: actor(request), clientId: old.clientId, linkId: next.id, detail: `replaces ${old.id}` },
      });
      return next;
    });
    return reply.status(201).send(formLinkView(link));
  });

  app.delete<{ Params: { id: string } }>("/request-links/:id", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change form links" });
    const link = await ownLink(request.user.agencyId, request.params.id);
    if (!link) return reply.status(404).send({ error: "link not found" });
    if (!link.revokedAt) {
      await prisma.requestFormLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
      await prisma.requestFormAudit.create({ data: { action: "link_revoked", actor: actor(request), clientId: link.clientId, linkId: link.id } });
    }
    return { ok: true };
  });

  /** The latest 200 audit entries for this agency's brands. */
  app.get<{ Querystring: { brandId?: string } }>("/request-links/audit", async (request) => {
    const brands = await prisma.client.findMany({ where: { agencyId: request.user.agencyId }, select: { id: true } });
    const ids = brands.map((b) => b.id).filter((id) => !request.query.brandId || id === request.query.brandId);
    const entries = await prisma.requestFormAudit.findMany({
      where: { clientId: { in: ids } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { entries };
  });

  app.get("/trello/intake-config", async (request) => readIntakeConfig(request.user.agencyId));

  /** labelByBrand: brandId to Trello label id. Null ids make the next card look the board up again. */
  app.put("/trello/intake-config", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const config = TrelloIntakeConfigSchema.extend({
      labelByBrand: z.record(z.string(), z.string().regex(/^[a-f0-9]{24}$/, "a Trello label id")),
    }).parse(request.body);
    await writeSetting(request.user.agencyId, TRELLO_INTAKE_SETTING, config);
    return config;
  });
}
