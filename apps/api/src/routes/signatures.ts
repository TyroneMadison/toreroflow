import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Prisma, getPrisma } from "@toreroflow/db";
import {
  SignatureRequestCreateSchema,
  SignatureVoidSchema,
  SignConsentSchema,
  SignDeclineSchema,
  SignSubmitSchema,
} from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { gmailMailer } from "../mail/mailer";
import { requireAuth } from "../plugins/requireAuth";
import { clientIp, rateLimiter } from "../ideas/rateLimit";
import { MAX_DOCUMENT_UPLOAD_BYTES } from "../uploadLimits";
import { appendCertificate, readPdf, sha256, stampFields, type StampField } from "../signatures/pdf";
import { signingPage } from "../signatures/page";

/**
 * Document signing: a contract goes out by email, each person signs it in a
 * browser, and the trail of who did what is kept well enough to stand up if it
 * is ever disputed.
 *
 * Two surfaces. The owner's, behind the usual JWT, uploads the file and places
 * the fields. The signer's, /s/:token, needs no login and never can: the people
 * signing are outside the business and have no account here. The token is
 * "<signer id>.<HMAC of the id and the request's expiry>", exactly as approval
 * links work, so it cannot be forged, cannot be stretched past the expiry, and
 * is never stored.
 *
 * The uploaded file is never modified. Signatures are drawn onto a copy, and
 * the original's hash goes on the certificate, so the signed copy can always be
 * checked against what was actually sent.
 */

export function signerToken(id: string, expiresAt: Date, secret = env.JWT_SECRET): string {
  const sig = createHmac("sha256", secret).update(`sign|${id}|${expiresAt.getTime()}`).digest("base64url");
  return `${id}.${sig}`;
}

const key = (requestId: string, name: string) => `signatures/${requestId}/${name}`;
const storagePath = (storageKey: string) => path.join(env.STORAGE_DIR, storageKey);

/** Absolute, because this goes in an email to someone outside the app. */
function publicBase(request: FastifyRequest): string {
  return (env.OAUTH_REDIRECT_BASE || `${request.protocol}://${request.hostname}`).replace(/\/+$/, "");
}

type SignerRow = {
  id: string;
  email: string;
  name: string;
  order: number;
  status: string;
  consentAt: Date | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string;
  signedIp: string;
  signedUserAgent: string;
};
type FieldRow = {
  id: string;
  signerId: string | null;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  value: string | null;
  filledAt: Date | null;
};
type RequestRow = {
  id: string;
  title: string;
  message: string;
  clientId: string | null;
  status: string;
  pageCount: number;
  sourceFileKey: string;
  sourceSha256: string;
  signedFileKey: string | null;
  signedSha256: string | null;
  expiresAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string;
  createdAt: Date;
  signers: SignerRow[];
  fields: FieldRow[];
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

const fieldView = (f: FieldRow) => ({
  id: f.id,
  signerId: f.signerId,
  type: f.type,
  page: f.page,
  x: f.x,
  y: f.y,
  width: f.width,
  height: f.height,
  required: f.required,
  value: f.value,
  filledAt: iso(f.filledAt),
});

/** The owner's view. Carries each signing link, which no signer ever sees. */
const ownerView = (r: RequestRow) => ({
  id: r.id,
  title: r.title,
  message: r.message,
  clientId: r.clientId,
  status: r.status,
  pageCount: r.pageCount,
  sourceSha256: r.sourceSha256,
  signedSha256: r.signedSha256,
  documentUrl: fileLink(r.sourceFileKey),
  signedUrl: r.signedFileKey ? fileLink(r.signedFileKey) : null,
  expiresAt: r.expiresAt.toISOString(),
  sentAt: iso(r.sentAt),
  completedAt: iso(r.completedAt),
  voidedAt: iso(r.voidedAt),
  voidReason: r.voidReason,
  createdAt: r.createdAt.toISOString(),
  // Already ordered by the query; see `include`.
  signers: r.signers.map((s) => ({
    id: s.id,
    email: s.email,
    name: s.name,
    order: s.order,
    status: s.status,
    consentAt: iso(s.consentAt),
    viewedAt: iso(s.viewedAt),
    signedAt: iso(s.signedAt),
    declinedAt: iso(s.declinedAt),
    declineReason: s.declineReason,
    signingUrl: `/s/${signerToken(s.id, r.expiresAt)}`,
  })),
  fields: r.fields.map(fieldView),
});

/**
 * Signers always come back in signing order, so no view has to sort them and
 * none can forget to. `satisfies` rather than `as const`: a readonly orderBy
 * array is not assignable to Prisma's input type.
 */
const include = {
  signers: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
  fields: true,
} satisfies Prisma.SignatureRequestInclude;

/**
 * Whether this signer may sign yet. Everyone with a strictly lower order has to
 * be done first; equal orders sign in parallel.
 */
const isTurn = (signers: SignerRow[], signer: SignerRow) =>
  signers.every((s) => s.order >= signer.order || s.status === "signed");

/* ------------------------------------------------------------------ owner */

export async function signatureRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";

  const own = (agencyId: string, id: string) =>
    prisma.signatureRequest.findFirst({ where: { id, agencyId }, include });

  const audit = (requestId: string, type: string, extra: Record<string, unknown> = {}) =>
    prisma.signatureAuditEvent.create({ data: { requestId, type, ...extra } });

  /**
   * Upload the PDF. Creates a draft: the signers and the field boxes arrive
   * next, from the placement UI, once it can see the pages.
   */
  app.post("/signature-requests", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot send documents" });
    const file = await request.file({ limits: { fileSize: MAX_DOCUMENT_UPLOAD_BYTES } });
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    if (file.mimetype !== "application/pdf") {
      file.file.resume();
      return reply.status(400).send({ error: "the document has to be a PDF" });
    }
    const bytes = await file.toBuffer();
    if (file.file.truncated) return reply.status(413).send({ error: "the document is over 25 MB" });

    // Parse before storing: a file that pdf-lib cannot open would be a request
    // that can never be stamped, and finding that out at signing time is worse.
    let pageCount: number;
    try {
      ({ pageCount } = await readPdf(bytes));
    } catch {
      return reply.status(400).send({ error: "that PDF could not be read. Try re-exporting it." });
    }
    if (pageCount < 1) return reply.status(400).send({ error: "that PDF has no pages" });

    const created = await prisma.signatureRequest.create({
      data: {
        agencyId: request.user.agencyId,
        createdById: request.user.bot ? `bot:${request.user.bot}` : request.user.sub,
        title: (file.filename || "Document").replace(/\.pdf$/i, "").slice(0, 200) || "Document",
        sourceFileKey: "",
        sourceSha256: sha256(bytes),
        pageCount,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const storageKey = key(created.id, "source.pdf");
    await fs.mkdir(path.dirname(storagePath(storageKey)), { recursive: true });
    await fs.writeFile(storagePath(storageKey), bytes);
    await prisma.signatureRequest.update({ where: { id: created.id }, data: { sourceFileKey: storageKey } });
    await audit(created.id, "created", { ip: clientIp(request) });

    return reply.status(201).send(ownerView((await own(request.user.agencyId, created.id))!));
  });

  /** Set the title, signers and field boxes. Draft only: a sent document is fixed. */
  app.patch<{ Params: { id: string } }>("/signature-requests/:id", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change documents" });
    const existing = await own(request.user.agencyId, request.params.id);
    if (!existing) return reply.status(404).send({ error: "document not found" });
    if (existing.status !== "draft") {
      return reply.status(409).send({ error: "this document has already gone out, so it cannot be changed" });
    }
    const body = SignatureRequestCreateSchema.parse(request.body);
    if (body.fields.some((f) => f.signerIndex >= body.signers.length)) {
      return reply.status(400).send({ error: "a field is assigned to a signer that is not in the list" });
    }
    if (body.fields.some((f) => f.page >= existing.pageCount)) {
      return reply.status(400).send({ error: `a field is placed past page ${existing.pageCount} of the document` });
    }
    const emails = body.signers.map((s) => s.email.trim().toLowerCase());
    if (new Set(emails).size !== emails.length) {
      return reply.status(400).send({ error: "the same email is listed twice" });
    }
    if (body.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: body.clientId, agencyId: request.user.agencyId },
        select: { id: true },
      });
      if (!client) return reply.status(404).send({ error: "client not found" });
    }

    // Replace rather than reconcile: the whole draft arrives at once from the
    // builder, and a field whose signer was deleted must not survive.
    await prisma.$transaction(async (tx) => {
      await tx.signatureField.deleteMany({ where: { requestId: existing.id } });
      await tx.signatureSigner.deleteMany({ where: { requestId: existing.id } });
      const signerIds: string[] = [];
      for (const [i, s] of body.signers.entries()) {
        const row = await tx.signatureSigner.create({
          data: { requestId: existing.id, email: emails[i]!, name: s.name.slice(0, 200), order: s.order },
        });
        signerIds.push(row.id);
      }
      if (body.fields.length) {
        await tx.signatureField.createMany({
          data: body.fields.map((f) => ({
            requestId: existing.id,
            signerId: signerIds[f.signerIndex]!,
            type: f.type,
            page: f.page,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            required: f.required,
          })),
        });
      }
      await tx.signatureRequest.update({
        where: { id: existing.id },
        data: {
          title: body.title,
          message: body.message,
          clientId: body.clientId,
          expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
        },
      });
    });

    return ownerView((await own(request.user.agencyId, existing.id))!);
  });

  app.get<{ Querystring: { status?: string; clientId?: string } }>("/signature-requests", async (request) => {
    const requests = await prisma.signatureRequest.findMany({
      where: {
        agencyId: request.user.agencyId,
        ...(request.query.status ? { status: request.query.status as never } : {}),
        ...(request.query.clientId ? { clientId: request.query.clientId } : {}),
      },
      include,
      orderBy: { createdAt: "desc" },
    });
    return { requests: requests.map(ownerView) };
  });

  /** The Overview tab's card: four counts and the latest handful. */
  app.get("/signature-requests/summary", async (request) => {
    const rows = await prisma.signatureRequest.findMany({
      where: { agencyId: request.user.agencyId },
      include: { signers: { select: { status: true } } },
      orderBy: { updatedAt: "desc" },
    });
    const soon = Date.now() + 3 * 86_400_000;
    return {
      awaitingOthers: rows.filter((r) => r.status === "sent").length,
      completed: rows.filter((r) => r.status === "completed").length,
      drafts: rows.filter((r) => r.status === "draft").length,
      expiringSoon: rows.filter((r) => r.status === "sent" && r.expiresAt.getTime() < soon).length,
      recent: rows.slice(0, 6).map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        signedCount: r.signers.filter((s) => s.status === "signed").length,
        signerCount: r.signers.length,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/signature-requests/:id", async (request, reply) => {
    const found = await own(request.user.agencyId, request.params.id);
    return found ? ownerView(found) : reply.status(404).send({ error: "document not found" });
  });

  /** Send it: the first signers get their link by email. */
  app.post<{ Params: { id: string } }>("/signature-requests/:id/send", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot send documents" });
    const found = await own(request.user.agencyId, request.params.id);
    if (!found) return reply.status(404).send({ error: "document not found" });
    if (found.status !== "draft") return reply.status(409).send({ error: "this document has already gone out" });
    if (!found.signers.length) return reply.status(400).send({ error: "add at least one signer first" });
    if (!found.fields.length) return reply.status(400).send({ error: "place at least one signature field first" });
    // Every signer must have something to do, or they are sent a document they
    // cannot act on and the request can never complete.
    const idle = found.signers.filter((s) => !found.fields.some((f) => f.signerId === s.id));
    if (idle.length) {
      return reply.status(400).send({ error: `${idle.map((s) => s.email).join(", ")} has no fields to fill` });
    }
    if (found.expiresAt <= new Date()) return reply.status(400).send({ error: "the expiry is in the past" });

    const mailer = gmailMailer();
    if (!mailer) {
      return reply.status(503).send({
        error: "email is not connected on this server, so the signing links cannot be sent. Connect the Gmail account first.",
      });
    }

    const sent = await prisma.signatureRequest.update({
      where: { id: found.id },
      data: { status: "sent", sentAt: new Date() },
      include,
    });
    await audit(found.id, "sent", { ip: clientIp(request) });
    await notifyTurn(sent as RequestRow, publicBase(request));

    return ownerView((await own(request.user.agencyId, found.id))!);
  });

  /** Cancel it. Open links stop working; the trail stays. */
  app.post<{ Params: { id: string } }>("/signature-requests/:id/void", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot cancel documents" });
    const found = await own(request.user.agencyId, request.params.id);
    if (!found) return reply.status(404).send({ error: "document not found" });
    if (found.status === "completed") {
      return reply.status(409).send({ error: "this document is already signed, so it cannot be cancelled" });
    }
    const { reason } = SignatureVoidSchema.parse(request.body ?? {});
    await prisma.signatureRequest.update({
      where: { id: found.id },
      data: { status: "voided", voidedAt: new Date(), voidReason: reason },
    });
    await audit(found.id, "voided", { ip: clientIp(request), detail: { reason } });
    return ownerView((await own(request.user.agencyId, found.id))!);
  });
}

/**
 * Emails the signing link to everyone whose turn it now is and who has not been
 * emailed yet.
 *
 * "Not emailed yet" comes from the audit trail rather than a column on the
 * signer: the trail is already append-only and is the thing a dispute reads, so
 * the record of what was sent to whom belongs there and nowhere else.
 */
async function notifyTurn(req: RequestRow, base: string): Promise<string[]> {
  const prisma = getPrisma();
  const mailer = gmailMailer();
  if (!mailer) return [];

  const already = new Set(
    (
      await prisma.signatureAuditEvent.findMany({
        where: { requestId: req.id, type: "emailed" },
        select: { signerId: true },
      })
    ).map((e) => e.signerId),
  );
  // "viewed" counts as still to sign: a signer who opened the link early, out
  // of turn, has to be written to when their turn actually comes.
  const due = req.signers.filter(
    (s) => (s.status === "pending" || s.status === "viewed") && isTurn(req.signers, s) && !already.has(s.id),
  );

  const sentTo: string[] = [];
  for (const s of due) {
    const url = `${base}/s/${signerToken(s.id, req.expiresAt)}`;
    const text = [
      `${s.name ? s.name.split(" ")[0] + "," : "Hi,"}`,
      "",
      `You have a document to sign: ${req.title}`,
      ...(req.message ? ["", req.message] : []),
      "",
      "Open it here to read and sign:",
      url,
      "",
      `This link is yours alone and stops working on ${req.expiresAt.toISOString().slice(0, 10)}.`,
      "",
      "Torerone",
    ].join("\n");
    try {
      await mailer.send({ to: s.email, subject: `Please sign: ${req.title}`, text });
      await prisma.signatureAuditEvent.create({
        data: { requestId: req.id, signerId: s.id, type: "emailed", detail: { to: s.email } },
      });
      sentTo.push(s.email);
    } catch (err) {
      // One bad address must not stop the rest, and must not be silent: no
      // "emailed" event is written, so a retry picks this signer up again.
      await prisma.signatureAuditEvent.create({
        data: {
          requestId: req.id,
          signerId: s.id,
          type: "email_failed",
          detail: { to: s.email, error: String(err instanceof Error ? err.message : err).slice(0, 300) },
        },
      });
    }
  }
  return sentTo;
}

/**
 * Builds the signed copy once the last signature lands, and emails it to
 * everyone involved.
 */
async function complete(req: RequestRow, base: string): Promise<void> {
  const prisma = getPrisma();
  const completedAt = new Date();
  const source = await fs.readFile(storagePath(req.sourceFileKey));

  const stamped = await stampFields(
    source,
    req.fields.map<StampField>((f) => ({
      type: f.type as StampField["type"],
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      value: f.value,
    })),
  );
  const events = await prisma.signatureAuditEvent.findMany({
    where: { requestId: req.id },
    orderBy: { at: "asc" },
  });
  const emailOf = new Map(req.signers.map((s) => [s.id, s.email]));
  const final = await appendCertificate(stamped, {
    requestId: req.id,
    title: req.title,
    sourceSha256: req.sourceSha256,
    createdAt: req.createdAt,
    completedAt,
    signers: req.signers.map((s) => ({
      name: s.name,
      email: s.email,
      status: s.status,
      consentAt: s.consentAt,
      viewedAt: s.viewedAt,
      signedAt: s.signedAt,
      signedIp: s.signedIp,
      signedUserAgent: s.signedUserAgent,
    })),
    events: events.map((e) => ({
      type: e.type,
      at: e.at,
      ip: e.ip,
      signerEmail: e.signerId ? emailOf.get(e.signerId) ?? null : null,
    })),
  });

  const signedKey = key(req.id, "signed.pdf");
  await fs.mkdir(path.dirname(storagePath(signedKey)), { recursive: true });
  await fs.writeFile(storagePath(signedKey), final);
  await prisma.signatureRequest.update({
    where: { id: req.id },
    data: { status: "completed", completedAt, signedFileKey: signedKey, signedSha256: sha256(final) },
  });
  await prisma.signatureAuditEvent.create({ data: { requestId: req.id, type: "completed" } });

  const mailer = gmailMailer();
  if (!mailer) return;
  const link = `${base}${fileLink(signedKey)}`;
  for (const s of req.signers) {
    try {
      await mailer.send({
        to: s.email,
        subject: `Signed: ${req.title}`,
        text: [
          `${s.name ? s.name.split(" ")[0] + "," : "Hi,"}`,
          "",
          `${req.title} has been signed by everyone. Your copy, with the certificate of completion, is here:`,
          link,
          "",
          "Save a copy for your records; this link expires.",
          "",
          "Torerone",
        ].join("\n"),
      });
    } catch {
      // The document is signed and stored either way. A failed copy email is
      // not a reason to leave it looking unfinished.
    }
  }
}

/* ----------------------------------------------------------------- signer */

/** The signer's side: no login, 120 requests a minute per IP. */
export async function publicSignatureRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const allow = rateLimiter("sign", 60_000, 120);

  /** The signer a token names, with their request, or the reply already sent. */
  async function open(token: string, ip: string, reply: FastifyReply) {
    if (!(await allow(ip)).allowed) return void reply.status(429).send({ error: "too many requests, slow down" });
    const dot = token.lastIndexOf(".");
    const id = dot > 0 ? token.slice(0, dot) : "";
    const signer = id
      ? await prisma.signatureSigner.findUnique({ where: { id }, include: { request: { include } } })
      : null;
    const expected = signer ? Buffer.from(signerToken(signer.id, signer.request.expiresAt)) : null;
    const given = Buffer.from(token);
    // 404 for anything that is not a real token: a guess learns nothing.
    if (!signer || !expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return void reply.status(404).send({ error: "not found" });
    }
    const req = signer.request as RequestRow & { status: string };
    if (req.status === "draft") return void reply.status(404).send({ error: "not found" });
    if (req.status === "voided") {
      return void reply.status(410).send({ error: "this document was cancelled by the sender" });
    }
    if (req.expiresAt <= new Date()) {
      return void reply.status(410).send({ error: "this document has expired, ask the sender for a new link" });
    }
    return { signer, request: req };
  }

  async function page(signerId: string) {
    const s = await prisma.signatureSigner.findUniqueOrThrow({
      where: { id: signerId },
      include: { request: { include } },
    });
    const req = s.request as RequestRow;
    return {
      requestTitle: req.title,
      message: req.message,
      senderName: "Torerone",
      status: req.status,
      pageCount: req.pageCount,
      // The signed copy once it exists, so the last signer is not sent back to
      // the unsigned original on the page they just finished.
      documentUrl: fileLink(req.signedFileKey ?? req.sourceFileKey),
      expiresAt: req.expiresAt.toISOString(),
      signer: {
        name: s.name,
        email: s.email,
        status: s.status,
        consentAt: iso(s.consentAt),
      },
      // Only this signer's own boxes: another signer's fields are none of their
      // business, and neither is who the other signers are.
      fields: req.fields.filter((f) => f.signerId === s.id).map(fieldView),
      yourTurn: isTurn(req.signers, s as SignerRow),
    };
  }

  /**
   * A browser gets the signing page; anything asking for JSON gets the data.
   *
   * One URL for both because the email can only carry one, and the person
   * opening it has a browser. The desktop app and the checks ask for JSON.
   */
  app.get<{ Params: { token: string } }>("/s/:token", async (request, reply) => {
    const found = await open(request.params.token, clientIp(request), reply);
    if (!found) return reply;
    if (!found.signer.viewedAt) {
      await prisma.signatureSigner.update({ where: { id: found.signer.id }, data: { viewedAt: new Date(), ...(found.signer.status === "pending" ? { status: "viewed" } : {}) } });
      await prisma.signatureAuditEvent.create({
        data: {
          requestId: found.request.id,
          signerId: found.signer.id,
          type: "viewed",
          ip: clientIp(request),
          userAgent: String(request.headers["user-agent"] ?? "").slice(0, 400),
        },
      });
    }
    const data = await page(found.signer.id);
    const accept = String(request.headers.accept ?? "");
    if (accept.includes("application/json") || !accept.includes("html")) return data;
    return reply
      .type("text/html; charset=utf-8")
      // The page holds the contract and is reachable only with the token. It
      // must not sit in a shared cache, and must not be framed by anyone.
      .header("Cache-Control", "no-store")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .send(signingPage({ ...data, title: data.requestTitle, token: request.params.token }));
  });

  /**
   * ESIGN consent, recorded before any signature counts. Without the signer
   * agreeing to transact electronically, what they draw afterwards is not an
   * electronic signature; it is a picture.
   */
  app.post<{ Params: { token: string } }>("/s/:token/consent", async (request, reply) => {
    const found = await open(request.params.token, clientIp(request), reply);
    if (!found) return reply;
    SignConsentSchema.parse(request.body);
    if (!found.signer.consentAt) {
      await prisma.signatureSigner.update({ where: { id: found.signer.id }, data: { consentAt: new Date() } });
      await prisma.signatureAuditEvent.create({
        data: {
          requestId: found.request.id,
          signerId: found.signer.id,
          type: "consented",
          ip: clientIp(request),
          userAgent: String(request.headers["user-agent"] ?? "").slice(0, 400),
        },
      });
    }
    return page(found.signer.id);
  });

  app.post<{ Params: { token: string } }>("/s/:token/sign", async (request, reply) => {
    const found = await open(request.params.token, clientIp(request), reply);
    if (!found) return reply;
    const { signer, request: req } = found;
    if (signer.status === "signed") return reply.status(409).send({ error: "you have already signed this" });
    if (signer.status === "declined") return reply.status(409).send({ error: "you declined this document" });
    if (req.status === "declined") {
      return reply.status(409).send({ error: "someone else declined this document, so it is closed" });
    }
    if (!signer.consentAt) {
      return reply.status(409).send({ error: "agree to sign electronically first" });
    }
    if (!isTurn(req.signers, signer as SignerRow)) {
      return reply.status(409).send({ error: "it is not your turn yet; you will be emailed when it is" });
    }

    const body = SignSubmitSchema.parse(request.body);
    const mine = req.fields.filter((f) => f.signerId === signer.id);
    const unknown = Object.keys(body.values).filter((id) => !mine.some((f) => f.id === id));
    if (unknown.length) return reply.status(400).send({ error: "those fields are not yours to fill" });

    const filled = mine.map((f) => ({ field: f, value: body.values[f.id] ?? null }));
    const missing = filled.filter((x) => x.field.required && !x.value);
    if (missing.length) {
      return reply.status(400).send({ error: `${missing.length} required field${missing.length === 1 ? "" : "s"} still to fill` });
    }
    const tooBig = filled.find((x) => (x.value?.length ?? 0) > 400_000);
    if (tooBig) return reply.status(413).send({ error: "that signature image is too large" });

    const ip = clientIp(request);
    const userAgent = String(request.headers["user-agent"] ?? "").slice(0, 400);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const { field, value } of filled) {
        if (value === null) continue;
        await tx.signatureField.update({ where: { id: field.id }, data: { value, filledAt: now } });
      }
      await tx.signatureSigner.update({
        where: { id: signer.id },
        data: { status: "signed", signedAt: now, signedIp: ip, signedUserAgent: userAgent },
      });
      await tx.signatureAuditEvent.create({
        data: {
          requestId: req.id,
          signerId: signer.id,
          type: "signed",
          ip,
          userAgent,
          detail: { fields: filled.filter((x) => x.value !== null).length },
        },
      });
    });

    // Re-read: another signer may have landed between the checks above and now.
    const after = (await prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id }, include })) as RequestRow;
    if (after.signers.every((s) => s.status === "signed")) {
      await complete(after, publicBase(request));
    } else {
      await notifyTurn(after, publicBase(request));
    }
    return page(signer.id);
  });

  app.post<{ Params: { token: string } }>("/s/:token/decline", async (request, reply) => {
    const found = await open(request.params.token, clientIp(request), reply);
    if (!found) return reply;
    const { signer, request: req } = found;
    if (signer.status === "signed") return reply.status(409).send({ error: "you have already signed this" });
    const { reason } = SignDeclineSchema.parse(request.body ?? {});
    const ip = clientIp(request);
    await prisma.$transaction(async (tx) => {
      await tx.signatureSigner.update({
        where: { id: signer.id },
        data: { status: "declined", declinedAt: new Date(), declineReason: reason },
      });
      // One refusal closes the document: the remaining signers are agreeing to
      // something that will never be in force, so they are not asked to.
      await tx.signatureRequest.update({ where: { id: req.id }, data: { status: "declined" } });
      await tx.signatureAuditEvent.create({
        data: {
          requestId: req.id,
          signerId: signer.id,
          type: "declined",
          ip,
          userAgent: String(request.headers["user-agent"] ?? "").slice(0, 400),
          detail: { reason },
        },
      });
    });
    return page(signer.id);
  });
}
