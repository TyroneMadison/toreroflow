import type { SignatureFieldType } from "@toreroflow/contracts";

/**
 * The field-placement arithmetic, and the rules the Send button explains.
 *
 * Every box is stored as fractions of the page, 0-1, with y from the top. The
 * builder renders the PDF at whatever width fits the window, and the server
 * stamps at the PDF's real point size; a pixel anywhere in between would move
 * every signature the moment those two differ. Converting at the edges, in
 * these two functions, is the only way that stays true.
 *
 * The send rules are duplicated from the API on purpose. The server is still
 * the one that enforces them; this is so the button can say "Dana has no
 * fields" before a round trip instead of after one.
 */

export interface Box {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldDraft extends Box {
  /** Local id, until the server gives it one. */
  key: string;
  signerIndex: number;
  type: SignatureFieldType;
  required: boolean;
}

export interface SignerDraft {
  email: string;
  name: string;
  order: number;
}

/** Sensible first size for each kind of box, as fractions of the page. */
export const DEFAULT_SIZE: Record<SignatureFieldType, { width: number; height: number }> = {
  signature: { width: 0.28, height: 0.055 },
  initials: { width: 0.08, height: 0.045 },
  date: { width: 0.16, height: 0.032 },
  text: { width: 0.22, height: 0.032 },
  checkbox: { width: 0.024, height: 0.024 },
};

/** Below this a box is too small to see, let alone hit. */
export const MIN_SIDE = 0.015;

/** Keeps a box inside its page and above the minimum size. */
export function clampBox(b: Box): Box {
  const width = Math.min(Math.max(b.width, MIN_SIDE), 1);
  const height = Math.min(Math.max(b.height, MIN_SIDE), 1);
  return {
    page: b.page,
    width,
    height,
    x: Math.min(Math.max(b.x, 0), 1 - width),
    y: Math.min(Math.max(b.y, 0), 1 - height),
  };
}

/**
 * A drop at (px, py) on a page rendered `rendered` pixels wide and tall,
 * centred on the cursor so the box lands where it looks like it was dropped.
 */
export function dropBox(
  type: SignatureFieldType,
  page: number,
  px: number,
  py: number,
  rendered: { width: number; height: number },
): Box {
  const { width, height } = DEFAULT_SIZE[type];
  return clampBox({ page, width, height, x: px / rendered.width - width / 2, y: py / rendered.height - height / 2 });
}

/** Drag by a pixel delta on a page of this rendered size. */
export function moveBox(b: Box, dx: number, dy: number, rendered: { width: number; height: number }): Box {
  return clampBox({ ...b, x: b.x + dx / rendered.width, y: b.y + dy / rendered.height });
}

/** Resize from the bottom-right corner by a pixel delta. */
export function resizeBox(b: Box, dx: number, dy: number, rendered: { width: number; height: number }): Box {
  const width = Math.min(Math.max(b.width + dx / rendered.width, MIN_SIDE), 1 - b.x);
  const height = Math.min(Math.max(b.height + dy / rendered.height, MIN_SIDE), 1 - b.y);
  return { ...b, width, height };
}

/**
 * Where a box sits on its page, as CSS percentages.
 *
 * Percent rather than pixels so the overlay needs no measuring and no resize
 * listener: the boxes track the page element at any window width for free,
 * which is the whole reason the coordinates are fractions.
 */
export function boxStyle(b: Box): { left: string; top: string; width: string; height: string } {
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
  return { left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height) };
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * Why Send is off, in the order a person would fix them. Empty means ready.
 *
 * Mirrors the API's own refusals (routes/signatures.ts), including the one that
 * matters most: a signer with no fields can never finish the document, so the
 * request would sit there looking sent forever.
 */
export function sendBlockers(
  title: string,
  signers: SignerDraft[],
  fields: FieldDraft[],
  pageCount: number,
): string[] {
  const out: string[] = [];
  if (!title.trim()) out.push("Give the document a title.");
  if (!signers.length) out.push("Add at least one signer.");

  const emails = signers.map((s) => s.email.trim().toLowerCase());
  const bad = signers.filter((s) => !EMAIL.test(s.email.trim()));
  if (bad.length) out.push(`${bad.length === 1 ? "One email does" : `${bad.length} emails do`} not look right.`);
  const dup = emails.filter((e, i) => e && emails.indexOf(e) !== i);
  if (dup.length) out.push(`${[...new Set(dup)].join(", ")} is listed twice.`);

  if (signers.length && !fields.length) out.push("Place at least one field on the document.");
  const idle = signers.filter((_, i) => !fields.some((f) => f.signerIndex === i));
  if (fields.length && idle.length) {
    out.push(`${idle.map((s) => s.name.trim() || s.email.trim() || "a signer").join(", ")} has nothing to fill.`);
  }
  if (fields.some((f) => f.page >= pageCount)) out.push("A field is placed past the end of the document.");
  return out;
}

/* ---------- reading a sent request ---------- */

export interface SignerView {
  id: string;
  email: string;
  name: string;
  order: number;
  status: "pending" | "viewed" | "signed" | "declined";
  signedAt: string | null;
  declineReason: string;
  signingUrl?: string;
}

export interface RequestView {
  id: string;
  title: string;
  status: "draft" | "sent" | "completed" | "declined" | "voided";
  expiresAt: string;
  signedUrl: string | null;
  documentUrl: string;
  signers: SignerView[];
}

/** Badge colour per status. Shared, so the card and the screen cannot drift. */
export const TONE: Record<RequestView["status"], "ok" | "bad" | "warn" | "info" | undefined> = {
  completed: "ok",
  sent: "info",
  declined: "bad",
  voided: undefined,
  draft: "warn",
};

/**
 * "2 of 3 signed". Takes counts, not signers: the summary endpoint sends counts
 * so the Overview card does not have to pull every signer of every contract.
 */
export const progress = (signed: number, total: number): string => `${signed} of ${total} signed`;

export const signedCount = (signers: { status: string }[]): number =>
  signers.filter((s) => s.status === "signed").length;

/**
 * Who the document is actually sitting with: the signers whose turn it is.
 * Everyone with a lower order has to be done first, as the server enforces.
 */
export function waitingOn<T extends { order: number; status: string }>(signers: T[]): T[] {
  return signers.filter(
    (s) => s.status !== "signed" && s.status !== "declined" && signers.every((o) => o.order >= s.order || o.status === "signed"),
  );
}

/** Days left, floored, or 0 once it has passed. */
export const daysLeft = (expiresAt: string, now = Date.now()): number =>
  Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 86_400_000));

/** One line under the title in the list. */
export function statusLine(r: RequestView, now = Date.now()): string {
  if (r.status === "draft") return "Draft, not sent";
  if (r.status === "completed") return "Signed by everyone";
  if (r.status === "voided") return "Cancelled";
  if (r.status === "declined") {
    const who = r.signers.find((s) => s.status === "declined");
    return `Declined by ${who?.name || who?.email || "a signer"}${who?.declineReason ? `: ${who.declineReason}` : ""}`;
  }
  const next = waitingOn(r.signers);
  const d = daysLeft(r.expiresAt, now);
  const expiry = d === 0 ? "expires today" : `${d} day${d === 1 ? "" : "s"} left`;
  return next.length ? `Waiting on ${next.map((s) => s.name || s.email).join(", ")} · ${expiry}` : expiry;
}
