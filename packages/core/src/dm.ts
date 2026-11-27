import { z } from "zod";

/**
 * DMs: the rules both sides agree on (F2).
 *
 * Shared because the server enforces them and the screen explains them, and
 * two copies of "when does the reply window close" would disagree the first
 * time one of them changed.
 */

/** Where a contact is in the funnel. Labels are the mockups' (round 2). */
export const DM_STAGES = ["new", "engaged", "qualify", "offer", "link", "won"] as const;
export type DmStage = (typeof DM_STAGES)[number];
export const DM_STAGE_LABEL: Record<DmStage, string> = {
  new: "New",
  engaged: "Engaged",
  qualify: "Qualifying",
  offer: "Offer sent",
  link: "Link sent",
  won: "Customer",
};

export const DM_STATUSES = ["open", "waiting", "done"] as const;
export type DmStatus = (typeof DM_STATUSES)[number];

/** Meta's standard messaging window after a person's last message. */
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The HUMAN_AGENT tag stretches it to 7 days, for apps Meta approved for it. */
export const DM_HUMAN_AGENT_MS = 7 * 24 * 60 * 60 * 1000;

export type ReplyWindow =
  | { open: true; tag: null; endsAt: Date }
  | { open: true; tag: "HUMAN_AGENT"; endsAt: Date }
  | { open: false; reason: "never_messaged" | "closed"; endsAt: Date | null };

/**
 * Whether a reply can go out now, and how.
 *
 * Instagram refuses a message to anyone whose last message to the account is
 * older than 24 hours. Checking here gives the operator a sentence instead of
 * Meta's error code 10, and stops a send that was always going to bounce.
 */
export function replyWindow(
  lastInboundAt: Date | null | undefined,
  now: Date = new Date(),
  humanAgent = false,
): ReplyWindow {
  if (!lastInboundAt) return { open: false, reason: "never_messaged", endsAt: null };
  const std = new Date(lastInboundAt.getTime() + DM_WINDOW_MS);
  if (now < std) return { open: true, tag: null, endsAt: std };
  const ext = new Date(lastInboundAt.getTime() + DM_HUMAN_AGENT_MS);
  if (humanAgent && now < ext) return { open: true, tag: "HUMAN_AGENT", endsAt: ext };
  return { open: false, reason: "closed", endsAt: humanAgent ? ext : std };
}

/**
 * Whether an id can be a post on this platform, for a DM campaign's scope.
 *
 * Instagram media ids are long numbers (17895695668004550); Facebook post ids
 * are a number or "pageId_postId". A YouTube video id (11 characters with
 * letters) is neither, which is the recon bug: the old picker sent those, so a
 * scoped campaign listened on a post that does not exist and never fired.
 */
export function isPlatformPostId(platform: string, id: string): boolean {
  if (platform === "instagram") return /^\d{8,25}$/.test(id);
  if (platform === "facebook") return /^\d{5,25}(_\d{5,25})?$/.test(id);
  return false;
}

const tagName = z.string().trim().min(1).max(40);

/** A reply. Text, an image (or other media by URL), or both. */
export const dmReplySchema = z
  .object({
    text: z.string().trim().max(1000).optional(),
    media: z
      .object({
        type: z.enum(["image", "video", "audio", "file"]),
        /** Instagram fetches it, so it has to be public https. */
        url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "media must be an https URL"),
      })
      .optional(),
    /** Quote one of the thread's messages (its platform id). */
    replyTo: z.string().max(200).optional(),
  })
  .refine((b) => !!b.text || !!b.media, { message: "a reply needs text or media" });
export type DmReplyInput = z.infer<typeof dmReplySchema>;

/** Thread edits. Stage, tags and notes belong to the contact; status to the thread. */
export const dmThreadPatchSchema = z
  .object({
    status: z.enum(DM_STATUSES).optional(),
    stage: z.enum(DM_STAGES).optional(),
    /** The whole set, replacing what was there. */
    tags: z.array(tagName).max(20).optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type DmThreadPatch = z.infer<typeof dmThreadPatchSchema>;

export const dmContactPatchSchema = z
  .object({
    stage: z.enum(DM_STAGES).optional(),
    tags: z.array(tagName).max(20).optional(),
    notes: z.string().max(4000).nullable().optional(),
    optIn: z.boolean().optional(),
    displayName: z.string().trim().max(120).nullable().optional(),
  })
  .strict();
export type DmContactPatch = z.infer<typeof dmContactPatchSchema>;

/** One attachment as the screen draws it. url is our media proxy, never the CDN. */
export interface DmAttachmentView {
  type: string;
  url: string | null;
  preview?: string | null;
  title?: string | null;
  link?: string | null;
}

export interface DmContactView {
  id: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  stage: DmStage;
  tags: string[];
  notes: string | null;
  optIn: boolean;
  lastSeenAt: string | null;
}

/** One row of the unified inbox, whichever transport it came through. */
export interface DmThreadView {
  id: string;
  source: "native" | "zernio";
  platform: "instagram" | "facebook";
  /** Our SocialAccount id. */
  accountId: string;
  accountHandle: string;
  status: DmStatus;
  unread: number;
  pausedAt: string | null;
  lastMessageAt: string | null;
  lastPreview: string | null;
  lastDirection: "in" | "out" | null;
  /** Native threads only; Zernio applies Meta's window on its side. */
  windowEndsAt: string | null;
  /** Can a reply go out from here at all. Messenger: only in an existing thread. */
  canReply: boolean;
  contact: DmContactView;
}

export interface DmMessageView {
  id: string;
  externalId: string;
  direction: "in" | "out";
  text: string | null;
  attachments: DmAttachmentView[];
  replyTo: string | null;
  reactions: Record<string, string> | null;
  unsent: boolean;
  edited: boolean;
  transcript: string | null;
  status: "sent" | "failed";
  error: string | null;
  sentAt: string | null;
}
