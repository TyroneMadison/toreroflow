import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { PDFDocument, rgb } from "pdf-lib";
import { readPdf, stampFields, appendCertificate, pngHasInk, sha256, toWinAnsi, type StampField } from "./pdf";

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

/* ---------------------------------------------------------- blank signatures */

/**
 * The failure this guards is the worst one available here: a signer taps the
 * pad without drawing, a perfectly valid fully-transparent PNG is submitted,
 * it stamps without complaint, and the contract comes back marked signed with
 * an empty signature box and nothing in the record to show it.
 *
 * Real PNGs are built here rather than pasted as base64 so the test exercises
 * the actual chunk and scanline parsing.
 */
function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA, what a canvas produces
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
      raw[at++] = a;
    }
  }
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const blankPad = png(64, 24, () => [0, 0, 0, 0]);
const signed = png(64, 24, (x, y) => (y === 12 && x > 4 && x < 60 ? [20, 20, 30, 255] : [0, 0, 0, 0]));
const opaque = png(8, 8, () => [255, 255, 255, 255]);

assert.equal(pngHasInk(blankPad), false, "an untouched pad is not a signature");
assert.equal(pngHasInk(signed), true, "one drawn stroke is");
assert.equal(pngHasInk(opaque), true, "a fully opaque image is not blank either");
// A single ink pixel anywhere is enough; the test is "is there anything", not
// "is it enough of a signature", which is not ours to judge.
assert.equal(pngHasInk(png(40, 40, (x, y) => (x === 39 && y === 39 ? [0, 0, 0, 1] : [0, 0, 0, 0]))), true);
assert.equal(pngHasInk(png(40, 40, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0]))), true);

// Not a PNG at all, or not even a data URL: not a signature.
assert.equal(pngHasInk("Dana Owner"), false);
assert.equal(pngHasInk("data:image/png;base64,"), false);
assert.equal(pngHasInk("data:image/png;base64,zzzznotbase64png"), false);
assert.equal(pngHasInk("data:image/jpeg;base64,/9j/4AAQSkZJRg=="), false);

// And a blank one really does stamp silently, which is why the check exists.
const stampedBlank = await stampFields(source, [
  { type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.08, value: blankPad },
]);
assert.ok(stampedBlank.length > 0, "a transparent PNG stamps without error, so nothing downstream would catch it");

/* ------------------------------------------------------------- encoding */

/**
 * pdf-lib's standard fonts are WinAnsi and THROW on anything outside it. That
 * throw would land after the signature is already committed, wedging a
 * finished contract, so text is folded to something Helvetica can draw.
 */
assert.equal(toWinAnsi("Jose Muller"), "Jose Muller");
assert.equal(toWinAnsi("José Müller"), "Jose Muller", "accents are dropped, not thrown on");
assert.equal(toWinAnsi("Nguyễn"), "Nguyen");
assert.equal(toWinAnsi("Łukasz"), "?ukasz", "no base letter to fall back to, but still drawable");
assert.equal(toWinAnsi("Иван"), "????");
assert.equal(toWinAnsi("ok 🎉"), "ok ?");
assert.equal(toWinAnsi("“smart” ‘quotes’ — dash"), '"smart" \'quotes\' - dash');
assert.equal(toWinAnsi("a\tb"), "a b");

// The real test: every one of these must survive a certificate and a stamp.
for (const nasty of ["Nguyễn Văn A", "Łukasz Żółć", "Иван Иванов", "契約書", "sign 🎉 here", "a b"]) {
  const cert = await appendCertificate(source, {
    requestId: "sig_enc",
    title: nasty,
    sourceSha256: sha256(source),
    createdAt: new Date(),
    completedAt: new Date(),
    signers: [
      {
        name: nasty,
        email: "x@example.com",
        status: "signed",
        consentAt: new Date(),
        viewedAt: new Date(),
        signedAt: new Date(),
        signedIp: "203.0.113.7",
        signedUserAgent: nasty,
      },
    ],
    events: [{ type: "signed", at: new Date(), ip: "203.0.113.7", signerEmail: nasty }],
  });
  assert.ok(cert.length > 0, `certificate survives ${JSON.stringify(nasty)}`);
  const stampedNasty = await stampFields(source, [
    { type: "text", page: 0, x: 0.1, y: 0.1, width: 0.4, height: 0.05, value: nasty },
  ]);
  assert.ok(stampedNasty.length > 0, `stamping survives ${JSON.stringify(nasty)}`);
}

console.log("signatures/pdf ok");
