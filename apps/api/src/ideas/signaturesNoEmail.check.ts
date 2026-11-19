/*
 * The same server with NO Gmail token: a contract still goes out.
 *
 * This is the branch signatures.check.ts cannot reach, because it sets
 * GMAIL_REFRESH_TOKEN at the top so gmailMailer() always answers. Sending used
 * to 503 here, which sounded cautious and was in fact the harshest possible
 * failure: a document that cannot leave draft, and a draft's signing links are
 * deliberately 404, so the whole feature was unreachable on a server with no
 * mail. Now the send succeeds, says plainly that nothing was emailed, and the
 * owner carries the links.
 *
 * fetch throws, so a regression that tries to send mail anyway fails loudly
 * here rather than silently reaching the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "signoemail-"));
process.env.STORAGE_DIR = storageDir;
process.env.JWT_SECRET = "sig-noemail-secret";
// The point of this file: the token is absent, so gmailMailer() returns null.
process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "csecret";
delete process.env.GMAIL_REFRESH_TOKEN;
delete process.env.BOT_FULL_ACCESS;
// Signing links live on the app's own address, both emailed and copied.
process.env.APP_DOMAIN = "app.example.com";

globalThis.fetch = (async (url: string | URL) => {
  throw new Error(`nothing should reach the network in this check: ${String(url)}`);
}) as typeof fetch;

const { SignatureRequestSchema } = await import("@toreroflow/contracts");
const { gmailMailer } = await import("../mail/mailer");
const { signerToken, signatureRoutes, publicSignatureRoutes } = await import("../routes/signatures");
const { installSignatureMock } = await import("./signatureMock");
const { testApp } = await import("./testApp");

assert.equal(gmailMailer(), null, "the premise: no mailer on this server");

const { requests, signers, fields, events } = await installSignatureMock();
const ops = await testApp(signatureRoutes);
const pub = await testApp(publicSignatureRoutes);

// ---- a draft with two signers in order, each with a box to fill ----
const expiresAt = new Date(Date.now() + 14 * 86_400_000);
requests.push({
  id: "req1",
  agencyId: "A",
  title: "Editor Agreement",
  message: "",
  clientId: null,
  status: "draft",
  pageCount: 2,
  sourceFileKey: "signatures/req1/source.pdf",
  sourceSha256: "a".repeat(64),
  signedFileKey: null,
  signedSha256: null,
  expiresAt,
  sentAt: null,
  completedAt: null,
  voidedAt: null,
  voidReason: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});
for (const [i, email] of ["first@example.com", "second@example.com"].entries()) {
  signers.push({
    id: `sgn${i + 1}`,
    requestId: "req1",
    email,
    name: "",
    order: i + 1,
    status: "pending",
    consentAt: null,
    viewedAt: null,
    signedAt: null,
    declinedAt: null,
    declineReason: "",
    signedIp: "",
    signedUserAgent: "",
    createdAt: i,
  });
  fields.push({
    id: `fld${i + 1}`,
    requestId: "req1",
    signerId: `sgn${i + 1}`,
    type: "signature",
    page: 0,
    x: 0.1,
    y: 0.1 + i * 0.2,
    width: 0.25,
    height: 0.06,
    required: true,
    value: null,
    filledAt: null,
    createdAt: new Date(),
  });
}

const send = () => ops.app.inject({ method: "POST", url: "/signature-requests/req1/send", headers: ops.operator });
const remind = () => ops.app.inject({ method: "POST", url: "/signature-requests/req1/remind", headers: ops.operator });

// ---- sending works, and is honest about the email ----
let res = await send();
assert.equal(res.statusCode, 200, `sending must not 503 without a mailer: ${res.body}`);
let body = res.json();
assert.equal(body.status, "sent", "the document actually went out");
assert.equal(body.emailed, false, "and says plainly that no email was sent");
assert.equal(body.emailConnected, false, "and that this server cannot email at all, which every later open shows");
for (const signer of body.signers) {
  assert.match(signer.signingUrl, /^https:\/\/app\.example\.com\/s\//, "a copied link opens on the app's own address");
}
assert.deepEqual(body.emailedTo, [], "nobody was written to");

/*
 * The field has to survive the contract schema. SignatureRequestSchema is a
 * plain z.object, which STRIPS unknown keys, so had `emailed` not been declared
 * there it would vanish on parse and every caller would read undefined, which
 * is indistinguishable from "an email went out".
 */
const parsed = SignatureRequestSchema.parse(body);
assert.equal(parsed.emailed, false, "emailed survives the contract schema rather than being stripped");

// ---- the skip is on the record, naming who should have been written to ----
const skipped = events.filter((e) => e.type === "email_skipped");
assert.equal(skipped.length, 1, "one email_skipped event, not one per signer");
assert.deepEqual(skipped[0]!.detail.to, ["first@example.com"], "only the signer whose turn it is");
assert.equal(
  events.some((e) => e.type === "emailed"),
  false,
  "and no 'emailed' event, so nothing claims mail was sent",
);
assert.ok(
  events.some((e) => e.type === "sent"),
  "the send itself is still recorded",
);

// ---- the whole point: that signer's link now works ----
const token = signerToken("sgn1", expiresAt);
res = await pub.app.inject({ method: "GET", url: `/s/${token}`, headers: { accept: "application/json" } });
assert.equal(res.statusCode, 200, "the first signer can open the document the owner sent by hand");
assert.equal(res.json().yourTurn, true, "and it is their turn");

// The second signer is out of turn, exactly as with email.
res = await pub.app.inject({
  method: "GET",
  url: `/s/${signerToken("sgn2", expiresAt)}`,
  headers: { accept: "application/json" },
});
assert.equal(res.statusCode, 200);
assert.equal(res.json().yourTurn, false, "order is still enforced without email");

// ---- remind: 200 and honest, NOT a 409 claiming nobody is waiting ----
res = await remind();
assert.equal(res.statusCode, 200, `remind must not 503 or 409 while someone is waiting: ${res.body}`);
body = res.json();
assert.equal(body.emailed, false, "the reminder emailed nobody");
assert.deepEqual(body.emailedTo, []);
assert.equal(
  events.filter((e) => e.type === "reminded").length,
  0,
  "and writes no 'reminded' event, because nobody was reminded",
);

// ---- a second send is still refused: it is no longer a draft ----
res = await send();
assert.equal(res.statusCode, 409, "sending twice is still a conflict");

// ---- 409 only when there is genuinely nobody left to chase ----
for (const s of signers) s.status = "signed";
res = await remind();
assert.equal(res.statusCode, 409, "with everyone signed there is nobody waiting");
assert.match(res.json().error, /nobody waiting/, res.body);

await fs.rm(storageDir, { recursive: true, force: true });
console.log("signaturesNoEmail.check: ok");
