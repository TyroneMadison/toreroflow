import { normalizeHandle } from "./research";

/**
 * Turning a client's welcome reply into their record.
 *
 * After they pay, the client gets a link, fills in what only they know, and
 * that arrives as a form submission. This file is the part that decides what
 * of it reaches the database.
 *
 * The rule running through it: an answer wins, a blank changes nothing.
 *
 * The client is the authority on their own name, number and handles, so what
 * they write replaces what is on file even where something is already there.
 * That is the point of sending the link to a brand that already exists: they
 * correct what is wrong and add what is missing.
 *
 * A box they left empty is not an answer and never clears anything. Nothing on
 * the form is required, so a half finished reply is the normal case, and a
 * client who skips the phone box must not wipe the number already stored.
 */

/** The exact field names on the welcome form. Changing one changes the form. */
export const WELCOME_FIELDS = {
  token: "client-token",
  businessName: "business-name",
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
  /** The brand's own name. Theirs to correct, so it can rename the client. */
  name?: string;
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
  const business = text(d[WELCOME_FIELDS.businessName]);
  if (business) patch.name = business;
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
 * What to actually write.
 *
 * Every answer they gave, and nothing else. An earlier version of this only
 * filled blanks and let a stored value win, which meant a client correcting
 * their own phone number changed nothing. They are the authority on their own
 * details, so an answer replaces what is there.
 *
 * A blank is not an answer: `readWelcomeReply` has already dropped empty boxes,
 * so nothing here can produce an empty string to write over something real.
 */
export function fieldsToUpdate(patch: ClientPatch): ClientPatch {
  const out: ClientPatch = {};
  for (const key of ["name", "contactName", "contactEmail", "contactPhone"] as const) {
    const value = patch[key];
    if (value && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Their handles, merged over whatever was recorded before.
 *
 * A platform they left blank keeps whatever was already known, so filling in
 * only the missing YouTube box does not erase the Instagram handle from last
 * time.
 */
export function mergeHandles(
  stored: Record<string, string> | null | undefined,
  incoming: WelcomeHandle[],
): Record<string, string> {
  const out: Record<string, string> = { ...(stored ?? {}) };
  for (const h of incoming) out[h.platform] = h.handle;
  return out;
}
