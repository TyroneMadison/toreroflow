import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Stamping signatures onto the document, and the certificate that proves who
 * signed what.
 *
 * Coordinates arrive as fractions of the page with y measured from the TOP,
 * because that is how a browser lays the placement boxes out. PDF space runs
 * from the BOTTOM left, so every y is flipped here, once, rather than at each
 * call site where it would eventually be forgotten.
 */

export type StampField = {
  type: "signature" | "initials" | "date" | "text" | "checkbox";
  page: number;
  /** All four are fractions of the page, 0-1. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG data URL for a drawn signature, otherwise plain text. Unfilled fields are skipped. */
  value: string | null;
};

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function readPdf(bytes: Uint8Array): Promise<{ pageCount: number; sizes: { width: number; height: number }[] }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const sizes = doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  return { pageCount: sizes.length, sizes };
}

const isPngDataUrl = (v: string) => v.startsWith("data:image/png;base64,");

function drawFittedText(page: PDFPage, font: PDFFont, text: string, box: { x: number; y: number; w: number; h: number }) {
  // Shrink to fit rather than overflow the box the sender drew.
  let size = Math.min(box.h * 0.7, 14);
  while (size > 5 && font.widthOfTextAtSize(text, size) > box.w) size -= 0.5;
  page.drawText(text, {
    x: box.x + 2,
    y: box.y + (box.h - font.heightAtSize(size)) / 2 + 1,
    size,
    font,
    color: rgb(0.05, 0.05, 0.12),
  });
}

/**
 * Returns a new PDF with every filled field drawn onto it. The input bytes are
 * never modified, so the original stays byte-identical and verifiable.
 */
export async function stampFields(sourceBytes: Uint8Array, fields: StampField[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const f of fields) {
    if (f.value === null || f.value === "") continue;
    const page = pages[f.page];
    if (!page) continue; // A field pointing past the end of the document is ignored, not fatal.

    const pw = page.getWidth();
    const ph = page.getHeight();
    const x = f.x * pw;
    const w = f.width * pw;
    const h = f.height * ph;
    // Flip: the box's top edge measured from the top becomes its bottom edge from the bottom.
    const y = ph - (f.y * ph) - h;

    if ((f.type === "signature" || f.type === "initials") && isPngDataUrl(f.value)) {
      const png = await doc.embedPng(f.value);
      // Keep the drawn aspect ratio inside the box instead of stretching it.
      const scale = Math.min(w / png.width, h / png.height);
      page.drawImage(png, {
        x: x + (w - png.width * scale) / 2,
        y: y + (h - png.height * scale) / 2,
        width: png.width * scale,
        height: png.height * scale,
      });
    } else if (f.type === "checkbox") {
      if (f.value === "true") drawFittedText(page, font, "X", { x, y, w, h });
    } else {
      drawFittedText(page, font, f.value, { x, y, w, h });
    }
  }

  return doc.save();
}

export type CertificateSigner = {
  name: string;
  email: string;
  status: string;
  consentAt: Date | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  signedIp: string;
  signedUserAgent: string;
};

export type CertificateInput = {
  requestId: string;
  title: string;
  sourceSha256: string;
  createdAt: Date;
  completedAt: Date;
  signers: CertificateSigner[];
  events: { type: string; at: Date; ip: string; signerEmail: string | null }[];
};

const stamp = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");

/**
 * Appends the certificate of completion to the stamped document. This is the
 * part a dispute actually turns on: who signed, from where, and when.
 */
export async function appendCertificate(stampedBytes: Uint8Array, info: CertificateInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(stampedBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([612, 792]);
  let y = 742;
  const left = 54;
  const ink = rgb(0.05, 0.05, 0.12);
  const grey = rgb(0.38, 0.38, 0.44);

  const nextPage = () => {
    page = doc.addPage([612, 792]);
    y = 742;
  };
  const line = (text: string, opts: { size?: number; font?: PDFFont; color?: typeof ink; gap?: number } = {}) => {
    const size = opts.size ?? 9.5;
    if (y < 56) nextPage();
    page.drawText(text, { x: left, y, size, font: opts.font ?? font, color: opts.color ?? ink });
    y -= opts.gap ?? size + 5;
  };

  line("Certificate of Completion", { size: 18, font: bold, gap: 26 });
  line(info.title, { size: 11, color: grey, gap: 20 });

  line("Document", { size: 10, font: bold, gap: 14 });
  line(`Reference    ${info.requestId}`);
  line(`Created      ${stamp(info.createdAt)}`);
  line(`Completed    ${stamp(info.completedAt)}`);
  line(`Original SHA-256`);
  line(`  ${info.sourceSha256}`, { size: 8, color: grey, gap: 20 });

  line("Signers", { size: 10, font: bold, gap: 14 });
  for (const s of info.signers) {
    line(`${s.name || s.email}  <${s.email}>`, { font: bold });
    line(`  Status     ${s.status}`);
    line(`  Consented  ${stamp(s.consentAt)}`);
    line(`  Viewed     ${stamp(s.viewedAt)}`);
    line(`  Signed     ${stamp(s.signedAt)}`);
    line(`  IP         ${s.signedIp || "—"}`);
    line(`  Device     ${(s.signedUserAgent || "—").slice(0, 86)}`, { size: 8, color: grey, gap: 18 });
  }

  line("Audit trail", { size: 10, font: bold, gap: 14 });
  for (const e of info.events) {
    line(`${stamp(e.at)}   ${e.type}${e.signerEmail ? `   ${e.signerEmail}` : ""}${e.ip ? `   ${e.ip}` : ""}`, { size: 8, gap: 11 });
  }

  if (y > 70) y -= 10;
  line("This certificate records an electronic signature made under the ESIGN Act and UETA.", { size: 7.5, color: grey, gap: 10 });
  line("The original document hash above proves the signed copy matches what was sent.", { size: 7.5, color: grey });

  return doc.save();
}
