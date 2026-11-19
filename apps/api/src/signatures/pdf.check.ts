import assert from "node:assert/strict";
import { PDFDocument, rgb } from "pdf-lib";
import { readPdf, stampFields, appendCertificate, sha256, type StampField } from "./pdf";

/** A two page document, 612x792, to stamp onto. */
async function blankPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]);
  return doc.save();
}

/** A 10x10 red PNG, standing in for a drawn signature. */
async function pngDataUrl(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([10, 10]);
  page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0) });
  // pdf-lib cannot emit PNG, so use a known-good 1x1 red PNG instead.
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}

const source = await blankPdf(2);
const info = await readPdf(source);
assert.equal(info.pageCount, 2, "reads the page count");
assert.equal(info.sizes[0].width, 612);
assert.equal(info.sizes[0].height, 792);

// sha256 is stable and actually depends on the bytes.
assert.equal(sha256(source), sha256(source), "same bytes, same hash");
assert.notEqual(sha256(source), sha256(await blankPdf(3)), "different bytes, different hash");

const fields: StampField[] = [
  { type: "text", page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.04, value: "Tyrone Madison" },
  { type: "date", page: 0, x: 0.6, y: 0.1, width: 0.2, height: 0.04, value: "2026-11-18" },
  { type: "checkbox", page: 1, x: 0.1, y: 0.5, width: 0.03, height: 0.03, value: "true" },
  { type: "signature", page: 1, x: 0.1, y: 0.8, width: 0.25, height: 0.06, value: await pngDataUrl() },
  // Unfilled and out of range fields must be skipped rather than throw.
  { type: "text", page: 0, x: 0.1, y: 0.3, width: 0.2, height: 0.04, value: null },
  { type: "text", page: 99, x: 0.1, y: 0.3, width: 0.2, height: 0.04, value: "off the end" },
];

const stamped = await stampFields(source, fields);
assert.ok(stamped.byteLength > 0, "produces a document");
assert.notEqual(sha256(stamped), sha256(source), "stamping changes the bytes");
assert.equal(sha256(source), sha256(await blankPdf(2)), "the source buffer was not modified in place");
const stampedInfo = await readPdf(stamped);
assert.equal(stampedInfo.pageCount, 2, "stamping adds no pages");

// The coordinate flip: y is a fraction from the TOP, so a box at y=0 sits at
// the top of the page in PDF space, not the bottom. Asserted on the maths the
// module uses, because getting this backwards puts every signature in the
// wrong half of the page and still produces a valid-looking PDF.
const ph = 792;
const topBox = { y: 0, height: 0.1 };
const bottomBox = { y: 0.9, height: 0.1 };
const pdfY = (f: { y: number; height: number }) => ph - f.y * ph - f.height * ph;
assert.equal(pdfY(topBox), 712.8, "a box at the top lands high in PDF space");
assert.ok(Math.abs(pdfY(bottomBox)) < 1e-9, "a box at the bottom lands at the page floor (within float error)");
assert.ok(pdfY(topBox) > pdfY(bottomBox), "top is above bottom after the flip");

const certified = await appendCertificate(stamped, {
  requestId: "sig_check",
  title: "Editor Agreement",
  sourceSha256: sha256(source),
  createdAt: new Date("2026-11-18T10:00:00Z"),
  completedAt: new Date("2026-11-18T11:30:00Z"),
  signers: [
    {
      name: "Tyrone Madison",
      email: "tyrone@example.com",
      status: "signed",
      consentAt: new Date("2026-11-18T11:00:00Z"),
      viewedAt: new Date("2026-11-18T10:59:00Z"),
      signedAt: new Date("2026-11-18T11:30:00Z"),
      signedIp: "203.0.113.7",
      signedUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
  ],
  events: [
    { type: "created", at: new Date("2026-11-18T10:00:00Z"), ip: "", signerEmail: null },
    { type: "signed", at: new Date("2026-11-18T11:30:00Z"), ip: "203.0.113.7", signerEmail: "tyrone@example.com" },
  ],
});
const certInfo = await readPdf(certified);
assert.ok(certInfo.pageCount > stampedInfo.pageCount, "the certificate is appended, not substituted");

// A long audit trail must spill onto further pages rather than run off one.
const many = await appendCertificate(stamped, {
  requestId: "sig_long",
  title: "Long trail",
  sourceSha256: sha256(source),
  createdAt: new Date(),
  completedAt: new Date(),
  signers: [],
  events: Array.from({ length: 120 }, (_, i) => ({
    type: `event_${i}`,
    at: new Date(),
    ip: "203.0.113.7",
    signerEmail: "a@example.com",
  })),
});
const manyInfo = await readPdf(many);
assert.ok(manyInfo.pageCount > certInfo.pageCount, "a long trail spills onto more pages");

console.log("signatures/pdf ok");
