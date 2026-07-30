import { normalizeHandle } from "./research";

/**
 * Turning a client's welcome reply into their record.
 *
 * After they pay, the client gets a link, fills in what only they know, and
 * that arrives as a form submission. This file is the part that decides what
 * of it reaches the database.
 *
 * The rule running through it: a reply may fill a blank, and may correct a
 * field the client themselves filled in earlier, but must never blank
 * something out. A form left half finished is the normal case, not the
 * exception, and a client who skips the phone box should not wipe the number
 * that was already on file.
 */

/** The exact field names on the welcome form. Changing one changes the form. */
export const WELCOME_FIELDS = {
  token: "client-token",
  contactName: "contact-name",
  contactEmail: "email",
  contactPhone: "phone",
  instagram: "handle-instagram",
  tiktok: "handle-tiktok",
  youtube: "handle-youtube",
  facebook: "handle-facebook",
  snapchat: "handle-snapchat",
  notes: "notes",
} as const;

export interface WelcomeReply {
  /** Netlify's own id for the submission, so the same one is never applied twice. */
  id: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface ClientPatch {
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface WelcomeHandle {
  platform: "instagram" | "tiktok" | "youtube" | "facebook" | "snapchat";
  handle: string;
}

export interface AppliedWelcome {
  token: string | null;
  patch: ClientPatch;
  handles: WelcomeHandle[];
  notes: string | null;
}

/** Trimmed, or null when there is nothing there. Blank is not an answer. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length ? clean : null;
}

/**
 * A social handle as the client typed it, or null when it was not one.
 *
 * The normalising itself belongs to the research module, which has done this
 * since the website form started collecting handles. This only turns its
 * "nothing usable" empty string into a null, which is what the rest of this
 * file speaks.
 */
export function handleFrom(input: unknown): string | null {
  const raw = text(input);
  if (!raw) return null;
  return normalizeHandle(raw) || null;
}

/**
 * What one reply says, without deciding anything about what is already stored.
 *
 * Kept separate from the writing so the mapping can be checked on its own, and
 * so nothing about a client is changed by reading a submission.
 */
export function readWelcomeReply(reply: WelcomeReply): AppliedWelcome {
  const d = reply.data ?? {};
  const patch: ClientPatch = {};
  const name = text(d[WELCOME_FIELDS.contactName]);
  const email = text(d[WELCOME_FIELDS.contactEmail]);
  const phone = text(d[WELCOME_FIELDS.contactPhone]);
  if (name) patch.contactName = name;
  if (email) patch.contactEmail = email;
  if (phone) patch.contactPhone = phone;

  const handles: WelcomeHandle[] = [];
  for (const platform of ["instagram", "tiktok", "youtube", "facebook", "snapchat"] as const) {
    const handle = handleFrom(d[WELCOME_FIELDS[platform]]);
    if (handle) handles.push({ platform, handle });
  }

  return {
    token: text(d[WELCOME_FIELDS.token]),
    patch,
    handles,
    notes: text(d[WELCOME_FIELDS.notes]),
  };
}

/**
 * What to actually write, given what is already on file.
 *
 * Only fills blanks. A client correcting a detail they gave earlier is a real
 * case, but it is not one this can tell apart from a stale autofill, so the
 * value already stored wins and the reply is kept for the operator to read.
 */
export function fieldsToFill(patch: ClientPatch, current: ClientPatch): ClientPatch {
  const out: ClientPatch = {};
  for (const key of ["contactName", "contactEmail", "contactPhone"] as const) {
    const incoming = patch[key];
    const existing = current[key];
    if (incoming && !existing?.trim()) out[key] = incoming;
  }
  return out;
}
