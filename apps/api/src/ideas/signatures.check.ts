// Document signing end to end: upload, place fields, send, two signers in
// order, the consent gate, the signed copy and its certificate. Plus the things
// that would actually hurt: a forged token, another agency's document, signing
// out of turn, and filling someone else's field.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigcheck-"));
process.env.STORAGE_DIR = storageDir;
process.env.JWT_SECRET = "sig-check-secret";
// Non-empty so gmailMailer() returns a sender; nothing leaves the process
// because fetch is stubbed below.
process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "csecret";
process.env.GMAIL_REFRESH_TOKEN = "rtoken";
delete process.env.BOT_FULL_ACCESS;

const { PDFDocument } = await import("pdf-lib");
const { getPrisma } = await import("@toreroflow/db");
const { PublicSigningSchema, SignatureRequestSchema, SignatureSummarySchema } = await import("@toreroflow/contracts");
const { signerToken, signatureRoutes, publicSignatureRoutes } = await import("../routes/signatures");
const { readPdf, sha256 } = await import("../signatures/pdf");
const { testApp, mockRateLimits } = await import("./testApp");

// ---- a real two page PDF to upload ----
const blank = await PDFDocument.create();
blank.addPage([612, 792]);
blank.addPage([612, 792]);
const pdf = Buffer.from(await blank.save());
const pdfSha = sha256(pdf);

// ---- captured email ----
type Sent = { to: string; subject: string; body: string };
const sent: Sent[] = [];
let failNextSend = false;
globalThis.fetch = (async (url: string | URL | Request, init?: { body?: unknown }) => {
  const href = String(url);
  if (href.includes("oauth2.googleapis.com")) {
    return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
  }
  if (href.includes("gmail.googleapis.com")) {
    if (failNextSend) {
      failNextSend = false;
      return new Response("nope", { status: 400 });
    }
    const raw = JSON.parse(String(init?.body)).raw as string;
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const to = /^To: (.*)$/m.exec(text)?.[1] ?? "";
    const subj64 = /^Subject: =\?UTF-8\?B\?(.*)\?=$/m.exec(text)?.[1] ?? "";
    const body = Buffer.from(text.split("\r\n\r\n").slice(1).join("\r\n\r\n"), "base64").toString("utf8");
    sent.push({ to, subject: Buffer.from(subj64, "base64").toString("utf8"), body });
    return new Response("{}", { status: 200 });
  }
  throw new Error(`unexpected fetch ${href}`);
}) as typeof fetch;

// ---- in-memory database ----
type Row = Record<string, any>;
const requests: Row[] = [];
const signers: Row[] = [];
const fields: Row[] = [];
const events: Row[] = [];
const clients: Row[] = [{ id: "c1", agencyId: "A" }];

const prisma = getPrisma();
const mock = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value, configurable: true });
await mockRateLimits();

let seq = 0;
const id = (p: string) => `${p}${++seq}`;
const hydrate = (r: Row, include?: Row) => {
  if (!include) return r;
  const mine = signers.filter((s) => s.requestId === r.id).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return {
    ...r,
    ...(include.signers ? { signers: include.signers.select ? mine.map((s) => ({ status: s.status })) : mine } : {}),
    ...(include.fields ? { fields: fields.filter((f) => f.requestId === r.id) } : {}),
  };
};

mock("$transaction", async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
mock("client", { findFirst: async ({ where }: Row) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null });
mock("signatureRequest", {
  create: async ({ data }: Row) => {
    const r = {
      id: id("req"),
      status: "draft",
      message: "",
      clientId: null,
      signedFileKey: null,
      signedSha256: null,
      sentAt: null,
      completedAt: null,
      voidedAt: null,
      voidReason: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    requests.push(r);
    return r;
  },
  findFirst: async ({ where, include }: Row) => {
    const r = requests.find((x) => x.id === where.id && x.agencyId === where.agencyId);
    return r ? hydrate(r, include) : null;
  },
  findMany: async ({ where, include }: Row) =>
    requests
      .filter(
        (r) =>
          r.agencyId === where.agencyId &&
          (!where.status || r.status === where.status) &&
          (!where.clientId || r.clientId === where.clientId),
      )
      .map((r) => hydrate(r, include))
      .reverse(),
  findUniqueOrThrow: async ({ where, include }: Row) => hydrate(requests.find((r) => r.id === where.id)!, include),
  update: async ({ where, data, include }: Row) => {
    const r = Object.assign(requests.find((x) => x.id === where.id)!, data, { updatedAt: new Date() });
    return hydrate(r, include);
  },
  // Conditional update, which is how the real code claims a document
  // exclusively: it only matches rows that still satisfy `where`, so a second
  // caller that arrives after the first has flipped the column gets count 0.
  updateMany: async ({ where, data }: Row) => {
    const matches = requests.filter((r) => {
      if (r.id !== where.id) return false;
      for (const [field, want] of Object.entries(where)) {
        if (field === "id") continue;
        if (want !== null && typeof want === "object" && "not" in (want as Row)) {
          if (r[field] === (want as Row).not) return false;
        } else if (r[field] !== want) return false;
      }
      return true;
    });
    for (const r of matches) Object.assign(r, data);
    return { count: matches.length };
  },
});
mock("signatureSigner", {
  create: async ({ data }: Row) => {
    const s = {
      id: id("sgn"),
      status: "pending",
      name: "",
      order: 1,
      consentAt: null,
      viewedAt: null,
      signedAt: null,
      declinedAt: null,
      declineReason: "",
      signedIp: "",
      signedUserAgent: "",
      createdAt: seq,
      ...data,
    };
    signers.push(s);
    return s;
  },
  deleteMany: async ({ where }: Row) => {
    for (let i = signers.length - 1; i >= 0; i--) if (signers[i]!.requestId === where.requestId) signers.splice(i, 1);
    return { count: 0 };
  },
  findUnique: async ({ where, include }: Row) => {
    const s = signers.find((x) => x.id === where.id);
    return s ? { ...s, ...(include?.request ? { request: hydrate(requests.find((r) => r.id === s.requestId)!, include.request.include) } : {}) } : null;
  },
  findUniqueOrThrow: async ({ where, include }: Row) => {
    const s = signers.find((x) => x.id === where.id)!;
    return { ...s, ...(include?.request ? { request: hydrate(requests.find((r) => r.id === s.requestId)!, include.request.include) } : {}) };
  },
  update: async ({ where, data }: Row) => Object.assign(signers.find((s) => s.id === where.id)!, data),
});
mock("signatureField", {
  createMany: async ({ data }: Row) => {
    for (const f of data) fields.push({ id: id("fld"), value: null, filledAt: null, createdAt: new Date(), ...f });
    return { count: data.length };
  },
  deleteMany: async ({ where }: Row) => {
    for (let i = fields.length - 1; i >= 0; i--) if (fields[i]!.requestId === where.requestId) fields.splice(i, 1);
    return { count: 0 };
  },
  update: async ({ where, data }: Row) => Object.assign(fields.find((f) => f.id === where.id)!, data),
});
mock("signatureAuditEvent", {
  create: async ({ data }: Row) => {
    const e = { id: id("evt"), signerId: null, ip: "", userAgent: "", detail: null, at: new Date(Date.now() + seq), ...data };
    events.push(e);
    return e;
  },
  findMany: async ({ where }: Row) =>
    events.filter((e) => e.requestId === where.requestId && (!where.type || e.type === where.type)),
});

const ops = await testApp(signatureRoutes);
const pub = await testApp(publicSignatureRoutes);
const sign = (token: string, body: object, ip = "9.9.9.9") =>
  pub.app.inject({ method: "POST", url: `/s/${token}/sign`, payload: body, remoteAddress: ip });

// ---- upload ----
/** One upload() per request: each call mints its own multipart boundary. */
const post = (name: string, type: string, data: Buffer, headers = ops.operator) => {
  const u = ops.upload(name, type, data);
  return ops.app.inject({ method: "POST", url: "/signature-requests", headers: { ...headers, ...u.headers }, payload: u.payload });
};

let res = await post("Service Agreement.pdf", "text/plain", pdf);
assert.equal(res.statusCode, 400, "only PDFs");
res = await post("x.pdf", "application/pdf", Buffer.from("not a pdf"));
assert.equal(res.statusCode, 400, "an unreadable PDF is caught at upload, not at signing");

res = await post("Service Agreement.pdf", "application/pdf", pdf);
assert.equal(res.statusCode, 201, res.body);
const doc = SignatureRequestSchema.parse(res.json());
assert.equal(doc.title, "Service Agreement", "the extension is not part of the title");
assert.equal(doc.pageCount, 2);
assert.equal(doc.sourceSha256, pdfSha, "hashed before anything is stamped");
assert.equal(doc.status, "draft");
assert.equal(doc.signedUrl, null);
assert.equal(requests[0]!.agencyId, "A", "scoped to the agency, not to the client");

// ---- place signers and fields ----
const draft = {
  title: "Service Agreement",
  message: "Standard terms, 12 months.",
  clientId: "c1",
  expiresInDays: 14,
  signers: [
    { email: "Owner@Example.com", name: "Dana Owner", order: 1 },
    { email: "second@example.com", name: "Sam Second", order: 2 },
  ],
  fields: [
    { signerIndex: 0, type: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.06, required: true },
    { signerIndex: 0, type: "date", page: 0, x: 0.5, y: 0.8, width: 0.2, height: 0.04, required: true },
    { signerIndex: 1, type: "signature", page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06, required: true },
  ],
};
const patch = (body: object, headers = ops.operator, reqId = doc.id) =>
  ops.app.inject({ method: "PATCH", url: `/signature-requests/${reqId}`, headers, payload: body });

assert.equal((await patch(draft, ops.otherAgency)).statusCode, 404, "another agency cannot see it");
assert.equal((await patch({ ...draft, fields: [{ ...draft.fields[0], page: 2 }] })).statusCode, 400, "page past the end");
assert.equal((await patch({ ...draft, fields: [{ ...draft.fields[0], signerIndex: 5 }] })).statusCode, 400, "no such signer");
assert.equal(
  (await patch({ ...draft, signers: [draft.signers[0], { ...draft.signers[1], email: "OWNER@example.com" }] })).statusCode,
  400,
  "the same person listed twice",
);
assert.equal((await patch({ ...draft, clientId: "c9" })).statusCode, 404, "client must be the agency's");

res = await patch(draft);
assert.equal(res.statusCode, 200, res.body);
let view = SignatureRequestSchema.parse(res.json());
assert.deepEqual(view.signers.map((s) => s.email), ["owner@example.com", "second@example.com"], "lower-cased, in order");
assert.equal(view.fields.length, 3);
assert.ok(Math.abs(Date.parse(view.expiresAt) - Date.now() - 14 * 86_400_000) < 5000);

// A second PATCH replaces, rather than piling fields up.
res = await patch(draft);
assert.equal(SignatureRequestSchema.parse(res.json()).fields.length, 3, "replaced, not appended");

// ---- send ----
assert.equal((await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/send`, headers: ops.nova })).statusCode, 403);
res = await patch({ ...draft, signers: [...draft.signers, { email: "idle@example.com", name: "", order: 3 }] });
assert.equal(res.statusCode, 200);
res = await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/send`, headers: ops.operator });
assert.equal(res.statusCode, 400, "a signer with nothing to fill can never finish the document");
assert.match(res.json().error, /idle@example\.com/);
await patch(draft);

res = await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/send`, headers: ops.operator });
assert.equal(res.statusCode, 200, res.body);
view = SignatureRequestSchema.parse(res.json());
assert.equal(view.status, "sent");
assert.equal(sent.length, 1, "only the first in the order is emailed");
assert.equal(sent[0]!.to, "owner@example.com");
assert.match(sent[0]!.subject, /Please sign: Service Agreement/);
assert.match(sent[0]!.body, /Standard terms, 12 months\./);
assert.equal((await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/send`, headers: ops.operator })).statusCode, 409);
assert.equal((await patch(draft)).statusCode, 409, "a sent document cannot be edited");

const first = signers.find((s) => s.email === "owner@example.com")!;
const second = signers.find((s) => s.email === "second@example.com")!;
const tokenOf = (s: Row) => signerToken(s.id, requests[0]!.expiresAt);
assert.match(sent[0]!.body, new RegExp(`/s/${tokenOf(first).replace(/[.]/g, "\\.")}`), "the emailed link is this signer's token");
assert.equal(
  events.some((e) => e.type === "emailed" && e.signerId === second.id),
  false,
  "the second signer has not been written to as sent",
);

// ---- forged and foreign tokens ----
for (const bad of [`${first.id}.AAAA`, first.id, `nope.${tokenOf(first).split(".")[1]}`, `${tokenOf(first)}x`]) {
  res = await pub.app.inject({ method: "GET", url: `/s/${bad}` });
  assert.equal(res.statusCode, 404, bad);
}

// ---- the signer's page ----
res = await pub.app.inject({ method: "GET", url: `/s/${tokenOf(first)}`, headers: { "user-agent": "Safari/17" } });
assert.equal(res.statusCode, 200, res.body);
let page = PublicSigningSchema.parse(res.json());
assert.equal(page.signer.email, "owner@example.com");
assert.equal(page.yourTurn, true);
assert.equal(page.fields.length, 2, "only this signer's own boxes");
assert.match(page.documentUrl, /^\/files\/signatures\//);
assert.equal(JSON.stringify(page).includes("second@example.com"), false, "a signer is not shown the others");
assert.equal(first.status, "viewed");
assert.ok(events.some((e) => e.type === "viewed" && e.signerId === first.id && e.userAgent === "Safari/17"));

page = PublicSigningSchema.parse((await pub.app.inject({ method: "GET", url: `/s/${tokenOf(second)}` })).json());
assert.equal(page.yourTurn, false, "second in the order waits");

// One URL, two answers: a browser gets the page, the app gets the data. The
// email can only carry one link, and the person opening it has a browser.
res = await pub.app.inject({ method: "GET", url: `/s/${tokenOf(first)}`, headers: { accept: "text/html,*/*" } });
assert.equal(res.statusCode, 200);
assert.match(res.headers["content-type"] as string, /^text\/html/);
assert.match(res.body, /<form id="f"/, "the signing form, not JSON");
assert.equal(res.headers["cache-control"], "no-store", "a contract must not sit in a shared cache");
assert.equal(res.headers["x-frame-options"], "DENY");
assert.equal(res.body.includes("second@example.com"), false, "the page shows no other signer either");
res = await pub.app.inject({ method: "GET", url: `/s/${tokenOf(first)}`, headers: { accept: "application/json" } });
assert.match(res.headers["content-type"] as string, /^application\/json/);

// ---- consent is the gate ----
const firstFields = fields.filter((f) => f.signerId === first.id);
/** A 1x1 opaque PNG: enough for pdf-lib to embed, which is what stamping needs. */
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
/** A 1x1 FULLY TRANSPARENT PNG: what an untouched signature pad submits. */
const blankPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const firstValues = {
  [firstFields.find((f) => f.type === "signature")!.id]: png,
  [firstFields.find((f) => f.type === "date")!.id]: "2026-11-18",
};

res = await sign(tokenOf(first), { values: firstValues, intent: true });
assert.equal(res.statusCode, 409);
assert.match(res.json().error, /electronically/);

res = await pub.app.inject({ method: "POST", url: `/s/${tokenOf(first)}/consent`, payload: { agreed: false } });
assert.equal(res.statusCode, 400, "consent cannot be declined into existence");
res = await pub.app.inject({ method: "POST", url: `/s/${tokenOf(first)}/consent`, payload: { agreed: true }, remoteAddress: "9.9.9.9" });
assert.equal(res.statusCode, 200, res.body);
assert.ok(PublicSigningSchema.parse(res.json()).signer.consentAt);
await pub.app.inject({ method: "POST", url: `/s/${tokenOf(second)}/consent`, payload: { agreed: true } });

// ---- out of turn, and other people's fields ----
res = await sign(tokenOf(second), { values: { [fields.find((f) => f.signerId === second.id)!.id]: png }, intent: true });
assert.equal(res.statusCode, 409);
assert.match(res.json().error, /not your turn/);
res = await sign(tokenOf(first), { values: { [fields.find((f) => f.signerId === second.id)!.id]: png }, intent: true });
assert.equal(res.statusCode, 400);
assert.match(res.json().error, /not yours/);
res = await sign(tokenOf(first), { values: { [firstFields[0]!.id]: png }, intent: true });
assert.equal(res.statusCode, 400, "a required field left empty");
res = await sign(tokenOf(first), { values: firstValues });
assert.equal(res.statusCode, 400, "intent is not optional");

// A blank pad is a valid PNG and stamps without complaint, so the server has
// to be the one that refuses it. Otherwise the contract comes back marked
// signed with an empty signature box and nothing in the record to show it.
res = await sign(tokenOf(first), { values: { ...firstValues, [firstFields.find((f) => f.type === "signature")!.id]: blankPng }, intent: true });
assert.equal(res.statusCode, 400, "a fully transparent signature is refused");
assert.match(res.json().error, /blank/);
assert.equal(first.status, "viewed", "and nothing was recorded");

// ---- first signature ----
res = await sign(tokenOf(first), { values: firstValues, intent: true }, "203.0.113.7");
assert.equal(res.statusCode, 200, res.body);
assert.equal(first.status, "signed");
assert.equal(first.signedIp, "203.0.113.7", "attribution evidence is kept");
assert.equal(requests[0]!.status, "sent", "not finished while someone is still to sign");
assert.equal(sent.length, 2, "the next signer is emailed as their turn opens");
assert.equal(sent[1]!.to, "second@example.com");
assert.equal((await sign(tokenOf(first), { values: firstValues, intent: true })).statusCode, 409, "no signing twice");
page = PublicSigningSchema.parse((await pub.app.inject({ method: "GET", url: `/s/${tokenOf(second)}` })).json());
assert.equal(page.yourTurn, true);

// ---- last signature completes it ----
res = await sign(tokenOf(second), { values: { [fields.find((f) => f.signerId === second.id)!.id]: png }, intent: true }, "198.51.100.4");
assert.equal(res.statusCode, 200, res.body);
assert.equal(requests[0]!.status, "completed");
assert.ok(requests[0]!.signedFileKey);
assert.equal(sent.length, 4, "both signers get the signed copy");
assert.deepEqual(sent.slice(2).map((s) => s.to).sort(), ["owner@example.com", "second@example.com"]);
assert.ok(sent[2]!.subject.startsWith("Signed:"));

// The original is untouched; the signed copy is a different file with the
// certificate appended.
const sourceOnDisk = await fs.readFile(path.join(storageDir, requests[0]!.sourceFileKey));
assert.equal(sha256(sourceOnDisk), pdfSha, "the uploaded file is never modified");
const signedOnDisk = await fs.readFile(path.join(storageDir, requests[0]!.signedFileKey));
assert.notEqual(sha256(signedOnDisk), pdfSha);
assert.equal(sha256(signedOnDisk), requests[0]!.signedSha256, "the stored hash matches the stored bytes");
assert.ok((await readPdf(signedOnDisk)).pageCount > 2, "the certificate was appended");

page = PublicSigningSchema.parse((await pub.app.inject({ method: "GET", url: `/s/${tokenOf(first)}` })).json());
assert.equal(page.status, "completed");
assert.match(page.documentUrl, /signed\.pdf/, "a signer who comes back sees the signed copy");

res = await ops.app.inject({ method: "GET", url: `/signature-requests/${doc.id}`, headers: ops.operator });
view = SignatureRequestSchema.parse(res.json());
assert.ok(view.signedUrl);
assert.equal(view.signers.filter((s) => s.status === "signed").length, 2);
assert.equal(
  (await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/void`, headers: ops.operator })).statusCode,
  409,
  "a signed document cannot be cancelled",
);

// ---- completion is claimed exclusively ----
// Two signers can share an order, so two requests can finish within
// milliseconds, both see "everyone has signed", and both start building. Each
// build makes different bytes (its own completedAt, a trail that has grown),
// so two runs could leave signedSha256 describing one copy and signed.pdf
// holding the other: the integrity check this feature exists for would then
// fail on a valid contract.
const completedEvents = () => events.filter((e) => e.requestId === requests[0]!.id && e.type === "completed").length;
assert.equal(completedEvents(), 1, "exactly one completion");
const sigBefore = requests[0]!.signedSha256;
// Re-entering complete() on a finished document must be a no-op, not a rebuild.
res = await ops.app.inject({ method: "POST", url: `/signature-requests/${doc.id}/complete`, headers: ops.operator });
assert.equal(res.statusCode, 400, "already finished");
assert.equal(completedEvents(), 1, "and no second completion was written");
assert.equal(requests[0]!.signedSha256, sigBefore, "the stored hash was not rewritten");

// ---- the Overview card ----
res = await ops.app.inject({ method: "GET", url: "/signature-requests/summary", headers: ops.operator });
assert.equal(res.statusCode, 200, res.body);
const summary = SignatureSummarySchema.parse(res.json());
assert.equal(summary.completed, 1);
assert.equal(summary.drafts, 0);
assert.equal(summary.recent[0]!.signedCount, 2);
assert.equal(summary.recent[0]!.signerCount, 2);
assert.equal(
  (await ops.app.inject({ method: "GET", url: "/signature-requests", headers: ops.otherAgency })).json().requests.length,
  0,
  "another agency sees none of it",
);

// ---- a second document: decline closes it, and a failed email is recorded ----
const two = SignatureRequestSchema.parse((await post("NDA.pdf", "application/pdf", pdf)).json());
await patch(
  {
    title: "NDA",
    message: "",
    clientId: null,
    expiresInDays: 7,
    signers: [{ email: "nope@example.com", name: "", order: 1 }],
    fields: [{ signerIndex: 0, type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: true }],
  },
  ops.operator,
  two.id,
);
failNextSend = true;
res = await ops.app.inject({ method: "POST", url: `/signature-requests/${two.id}/send`, headers: ops.operator });
assert.equal(res.statusCode, 200, "one bad address does not fail the send");
assert.ok(events.some((e) => e.type === "email_failed" && e.requestId === two.id));
assert.equal(
  events.some((e) => e.type === "emailed" && e.requestId === two.id),
  false,
  "no 'emailed' event, so a retry picks this signer up again",
);

const only = signers.find((s) => s.requestId === two.id)!;
const twoToken = signerToken(only.id, requests.find((r) => r.id === two.id)!.expiresAt);
res = await pub.app.inject({ method: "POST", url: `/s/${twoToken}/decline`, payload: { reason: "Wrong entity" } });
assert.equal(res.statusCode, 200, res.body);
assert.equal(PublicSigningSchema.parse(res.json()).status, "declined");
assert.equal(only.declineReason, "Wrong entity");
res = await pub.app.inject({ method: "POST", url: `/s/${twoToken}/sign`, payload: { values: {}, intent: true } });
assert.equal(res.statusCode, 409, "a declined signer cannot then sign");

// ---- a third: void, and expiry ----
const three = SignatureRequestSchema.parse((await post("Addendum.pdf", "application/pdf", pdf)).json());
await patch(
  {
    title: "Addendum",
    message: "",
    clientId: null,
    expiresInDays: 3,
    signers: [{ email: "later@example.com", name: "", order: 1 }],
    fields: [{ signerIndex: 0, type: "text", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: false }],
  },
  ops.operator,
  three.id,
);
const row3 = requests.find((r) => r.id === three.id)!;
const sgn3 = signers.find((s) => s.requestId === three.id)!;
res = await pub.app.inject({ method: "GET", url: `/s/${signerToken(sgn3.id, row3.expiresAt)}` });
assert.equal(res.statusCode, 404, "a draft is not reachable by token");

await ops.app.inject({ method: "POST", url: `/signature-requests/${three.id}/send`, headers: ops.operator });
const token3 = signerToken(sgn3.id, row3.expiresAt);
assert.equal((await pub.app.inject({ method: "GET", url: `/s/${token3}` })).statusCode, 200);

// Moving the expiry breaks the signature, exactly as it must.
const before = row3.expiresAt;
row3.expiresAt = new Date(Date.now() - 1000);
assert.equal((await pub.app.inject({ method: "GET", url: `/s/${token3}` })).statusCode, 404, "an edited expiry no longer matches");
res = await pub.app.inject({ method: "GET", url: `/s/${signerToken(sgn3.id, row3.expiresAt)}` });
assert.equal(res.statusCode, 410);
assert.match(res.json().error, /expired/);
row3.expiresAt = before;

await ops.app.inject({ method: "POST", url: `/signature-requests/${three.id}/void`, headers: ops.operator, payload: { reason: "Superseded" } });
res = await pub.app.inject({ method: "GET", url: `/s/${token3}` });
assert.equal(res.statusCode, 410);
assert.match(res.json().error, /cancelled/);

// ---- summary counts the rest ----
const s2 = SignatureSummarySchema.parse((await ops.app.inject({ method: "GET", url: "/signature-requests/summary", headers: ops.operator })).json());
assert.equal(s2.completed, 1);
assert.equal(s2.awaitingOthers, 0, "declined and voided are not waiting on anyone");
assert.equal(s2.expiringSoon, 0);

// ---- a signature that races the owner's cancel ----
// open() reads the status when the handler starts; the owner can void between
// that read and the write. Without an atomic guard the signature would land
// anyway and resurrect a cancelled contract as completed.
const four = SignatureRequestSchema.parse((await post("Lease.pdf", "application/pdf", pdf)).json());
const draft4 = {
  title: "Lease",
  message: "",
  clientId: null,
  expiresInDays: 10,
  signers: [{ email: "racer@example.com", name: "", order: 1 }],
  fields: [{ signerIndex: 0, type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: true }],
};
await patch(draft4, ops.operator, four.id);
await ops.app.inject({ method: "POST", url: `/signature-requests/${four.id}/send`, headers: ops.operator });
const row4 = requests.find((r) => r.id === four.id)!;
const sgn4 = signers.find((s) => s.requestId === four.id)!;
const token4 = signerToken(sgn4.id, row4.expiresAt);
await pub.app.inject({ method: "POST", url: `/s/${token4}/consent`, payload: { agreed: true } });
// The owner cancels after the signer has their page open.
await ops.app.inject({ method: "POST", url: `/signature-requests/${four.id}/void`, headers: ops.operator, payload: { reason: "" } });
res = await sign(token4, { values: { [fields.find((f) => f.requestId === four.id)!.id]: png }, intent: true });
assert.equal(res.statusCode, 410, "a cancelled document cannot be signed");
assert.equal(row4.status, "voided", "and it stays cancelled");
assert.notEqual(sgn4.status, "signed", "the signature was not recorded");

// ---- a completion that fails, and the owner's way out ----
// complete() runs after the signature is committed, so a failure in it would
// otherwise strand a fully signed contract: the signer cannot retry (409) and
// the only other action would be cancelling something already signed.
const five = SignatureRequestSchema.parse((await post("Addendum B.pdf", "application/pdf", pdf)).json());
await patch(
  {
    title: "Addendum B",
    message: "",
    clientId: null,
    expiresInDays: 10,
    signers: [{ email: "solo@example.com", name: "Solo", order: 1 }],
    fields: [{ signerIndex: 0, type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: true }],
  },
  ops.operator,
  five.id,
);
await ops.app.inject({ method: "POST", url: `/signature-requests/${five.id}/send`, headers: ops.operator });
const row5 = requests.find((r) => r.id === five.id)!;
const sgn5 = signers.find((s) => s.requestId === five.id)!;
const token5 = signerToken(sgn5.id, row5.expiresAt);
await pub.app.inject({ method: "POST", url: `/s/${token5}/consent`, payload: { agreed: true } });

// Make the build fail the way a lost or moved storage volume would.
const source5 = path.join(storageDir, row5.sourceFileKey);
const keep = await fs.readFile(source5);
await fs.rm(source5);
const sentBefore = sent.length;
res = await sign(token5, { values: { [fields.find((f) => f.requestId === five.id)!.id]: png }, intent: true });
assert.equal(res.statusCode, 200, "the signature still goes through");
assert.equal(sgn5.status, "signed", "and is recorded, because it happened");
assert.equal(row5.signedSha256, null, "but no signed copy exists");
assert.ok(events.some((e) => e.requestId === five.id && e.type === "finish_failed"), "the failure is on the record");
assert.equal(sent.length, sentBefore, "and nobody was told it was finished");
// The view must not offer a download of a file that was never written.
let v5 = SignatureRequestSchema.parse((await ops.app.inject({ method: "GET", url: `/signature-requests/${five.id}`, headers: ops.operator })).json());
assert.equal(v5.signedUrl, null, "no link to a signed copy that does not exist");
// Signing again is refused, which is exactly why the owner needs a way out.
assert.equal((await sign(token5, { values: {}, intent: true })).statusCode, 409);

await fs.writeFile(source5, keep);
assert.equal(
  (await ops.app.inject({ method: "POST", url: `/signature-requests/${five.id}/complete`, headers: ops.nova })).statusCode,
  403,
  "viewers cannot",
);
res = await ops.app.inject({ method: "POST", url: `/signature-requests/${five.id}/complete`, headers: ops.operator });
assert.equal(res.statusCode, 200, res.body);
v5 = SignatureRequestSchema.parse(res.json());
assert.ok(v5.signedUrl, "the signed copy is built on retry");
assert.ok(v5.signedSha256);
const onDisk5 = await fs.readFile(path.join(storageDir, row5.signedFileKey));
assert.equal(sha256(onDisk5), row5.signedSha256, "and its hash matches the bytes written");
assert.ok(sent.length > sentBefore, "and the signer finally gets their copy");

// ---- reminding whoever it is waiting on ----
const six = SignatureRequestSchema.parse((await post("MSA.pdf", "application/pdf", pdf)).json());
await patch(
  {
    title: "MSA",
    message: "",
    clientId: null,
    expiresInDays: 10,
    signers: [{ email: "slow@example.com", name: "", order: 1 }],
    fields: [{ signerIndex: 0, type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, required: true }],
  },
  ops.operator,
  six.id,
);
await ops.app.inject({ method: "POST", url: `/signature-requests/${six.id}/send`, headers: ops.operator });
const beforeRemind = sent.length;
// A reminder must reach someone who already got the first email: that is the
// whole point of the button, and the send path deliberately skips them.
res = await ops.app.inject({ method: "POST", url: `/signature-requests/${six.id}/remind`, headers: ops.operator });
assert.equal(res.statusCode, 200, res.body);
assert.equal(sent.length, beforeRemind + 1, "the signer is written to again");
assert.equal(sent[sent.length - 1]!.to, "slow@example.com");
assert.ok(events.some((e) => e.requestId === six.id && e.type === "reminded"));
// Not out for signature: nothing to remind anyone about.
await ops.app.inject({ method: "POST", url: `/signature-requests/${six.id}/void`, headers: ops.operator, payload: { reason: "" } });
assert.equal(
  (await ops.app.inject({ method: "POST", url: `/signature-requests/${six.id}/remind`, headers: ops.operator })).statusCode,
  409,
);

await ops.app.close();
await pub.app.close();
await fs.rm(storageDir, { recursive: true, force: true });
console.log("signatures.check: ok");
