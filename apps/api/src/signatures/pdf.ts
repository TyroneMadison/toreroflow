import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
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

/**
 * Whether a PNG has any pixel that is not fully transparent.
 *
 * A blank signature pad still produces a perfectly valid PNG, and a valid
 * transparent PNG stamps onto the document without complaint: the contract
 * comes back marked signed with an empty box. That is the one failure this
 * feature must never have, so a signature is checked for ink before it counts.
 *
 * Only the alpha bytes of the compressed scanlines are read, and deliberately
 * without un-filtering them. Every PNG filter is a difference between bytes of
 * the same channel, so an image whose alpha is 0 everywhere filters to all
 * zeroes under any filter type. One non-zero alpha byte therefore proves the
 * image is not blank, which is the only direction that matters here. (An
 * opaque image is safe too: on the first scanline there is nothing above or
 * before to subtract, so its alpha bytes survive non-zero.)
 */
export function pngHasInk(dataUrl: string): boolean {
  if (!isPngDataUrl(dataUrl)) return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  } catch {
    return false;
  }
  if (raw.length < 8 || raw.readUInt32BE(0) !== 0x89504e47) return false;

  let width = 0;
  let channels = 0;
  let bitDepth = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= raw.length; ) {
    const len = raw.readUInt32BE(at);
    const type = raw.toString("latin1", at + 4, at + 8);
    const body = raw.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      if (body.length < 10) return false;
      width = body.readUInt32BE(0);
      bitDepth = body[8]!;
      const colorType = body[9]!;
      // Only the two types a canvas produces carry alpha at all.
      channels = colorType === 6 ? 4 : colorType === 4 ? 2 : 0;
      // Interlaced data is laid out in passes, so scanline arithmetic below
      // would read the wrong bytes. A canvas never produces one.
      if (body.length > 12 && body[12] !== 0) return true;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + len;
  }
  // No alpha channel means every pixel is opaque, so there is something there.
  if (channels === 0) return true;
  if (bitDepth !== 8 || width === 0 || !idat.length) return true;

  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(idat));
  } catch {
    // Undecodable: let the stamping step be the one that rejects it.
    return true;
  }
  const stride = width * channels + 1; // +1 for each scanline's filter byte
  for (let row = 0; row + stride <= pixels.length; row += stride) {
    for (let px = 1 + (channels - 1); px < stride; px += channels) {
      if (pixels[row + px] !== 0) return true;
    }
  }
  return false;
}

/**
 * The subset of characters the built-in Helvetica can actually draw.
 *
 * pdf-lib's standard fonts are WinAnsi-encoded and THROW on anything outside
 * it. That throw lands after the signature has already been committed, which
 * wedges a finished contract permanently. A signer called Nguyễn, a Polish
 * surname, or an emoji typed into a text field is enough.
 *
 * So: decompose and drop combining marks, which turns most accented Latin into
 * its base letter, and replace whatever is still unencodable. Losing a diacritic
 * on the certificate is a blemish; losing the whole signed document is not.
 *
 * ponytail: embed a Unicode TTF with fontkit if non-Latin names ever need to
 * render properly, which costs a font file in the repo and a dependency.
 */
export function toWinAnsi(text: string): string {
  const stripped = text.normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of stripped) {
    const code = ch.codePointAt(0)!;
    // Printable ASCII, plus the Latin-1 range WinAnsi shares with Unicode.
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (code === 0x2018 || code === 0x2019) out += "'";
    else if (code === 0x201c || code === 0x201d) out += '"';
    else if (code === 0x2013 || code === 0x2014) out += "-";
    else if (code === 0x20ac) out += ch; // the euro sign is in WinAnsi
    else if (ch === "\t") out += " ";
    else if (code > 0x7e) out += "?";
  }
  return out;
}

function drawFittedText(page: PDFPage, font: PDFFont, raw: string, box: { x: number; y: number; w: number; h: number }) {
  const text = toWinAnsi(raw);
  if (!text) return;
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
  const line = (raw: string, opts: { size?: number; font?: PDFFont; color?: typeof ink; gap?: number } = {}) => {
    const size = opts.size ?? 9.5;
    if (y < 56) nextPage();
    // Through toWinAnsi without exception: the title and the signer names come
    // from a filename and a text box, and one unencodable character thrown here
    // would lose the certificate for a document that is already signed.
    page.drawText(toWinAnsi(raw), { x: left, y, size, font: opts.font ?? font, color: opts.color ?? ink });
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
