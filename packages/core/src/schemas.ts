import { z } from "zod";
import { PLATFORMS } from "./types";

export const platformSchema = z.enum(PLATFORMS);

export const registerSchema = z.object({
  agencyName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createClientSchema = z.object({
  name: z.string().min(1).max(120),
  plan: z.string().max(60).optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * Contact details for a client. Every field is optional and nullable so any
 * one of them can be cleared without supplying the others, and the email is
 * only validated when it is actually present.
 */
export const contactSchema = z.object({
  contactName: z.string().max(120).nullish(),
  contactEmail: z.union([z.string().email().max(200), z.literal("")]).nullish(),
  contactPhone: z.string().max(40).nullish(),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const connectAccountSchema = z.object({
  handle: z.string().min(1).max(120).optional(),
});
export type ConnectAccountInput = z.infer<typeof connectAccountSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(120),
  sourcePlatform: platformSchema,
  destinations: z.array(platformSchema).min(1),
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const instagramOptionsSchema = z.object({
  trial: z.boolean().optional(),
  graduationStrategy: z.enum(["MANUAL", "SS_PERFORMANCE"]).optional(),
  collaborators: z.array(z.string().max(80)).max(3).optional(),
  audioName: z.string().max(120).optional(),
  shareToFeed: z.boolean().optional(),
  firstComment: z.string().max(2200).optional(),
  aiLabel: z.boolean().optional(),
  /** Also put this video on the account's story, as a second post. */
  alsoStory: z.boolean().optional(),
});

/** Instagram refuses stories longer than this. */
export const INSTAGRAM_STORY_MAX_SECONDS = 60;

/**
 * The longest Reel that can be published through any API.
 *
 * The Instagram app takes far longer ones, which is exactly why this catches
 * people out: a video that posts fine by hand is refused programmatically.
 * Meta's Content Publishing API caps a REELS container at 90 seconds and has
 * not moved as the app's own limit rose.
 *
 * Found the hard way. A 106 second video was scheduled twice for a client,
 * accepted both times, and failed inside the provider both times with
 * "Publishing failed due to max retries reached", while the app's calendar
 * showed it as Posted. Every video that did publish was 64 to 80 seconds.
 */
export const INSTAGRAM_REEL_MAX_SECONDS = 90;

export const tiktokOptionsSchema = z.object({
  /**
   * Let TikTok attach a recommended track to a photo carousel. TikTok picks
   * the song; no API anywhere allows choosing one from their library, so a
   * toggle is the whole of what can honestly be offered.
   */
  autoAddMusic: z.boolean().optional(),
});

export const youtubeOptionsSchema = z.object({
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  madeForKids: z.boolean().optional(),
  firstComment: z.string().max(10_000).optional(),
  categoryId: z.string().max(10).optional(),
  playlistId: z.string().max(60).optional(),
  aiLabel: z.boolean().optional(),
  relatedVideoUrl: z.string().url().max(300).optional(),
});

export const schedulePostSchema = z.object({
  /**
   * Exactly the platforms chosen, each once.
   *
   * One target is created per entry, so a repeated platform would publish the
   * same video to that account twice. The checkboxes cannot produce it, but a
   * request can, and a double post on a client's channel is not recoverable
   * by deleting a row here.
   */
  platforms: z
    .array(platformSchema)
    .min(1)
    .transform((list) => [...new Set(list)]),
  /**
   * The exact accounts chosen, when the picker knows them. Platforms alone
   * cannot say WHICH Facebook when a client has two pages, and the server
   * picking the first one is how the second page becomes unreachable. Each id
   * once, same double-post reasoning as platforms. Optional so older callers
   * and saved automations keep working; absent means one target per platform,
   * resolved server-side as before.
   */
  accountIds: z
    .array(z.string().min(1))
    .min(1)
    .transform((list) => [...new Set(list)])
    .optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  caption: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
  instagram: instagramOptionsSchema.optional(),
  youtube: youtubeOptionsSchema.optional(),
  tiktok: tiktokOptionsSchema.optional(),
});
export type SchedulePostInput = z.infer<typeof schedulePostSchema>;

export const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  sourcePlatform: platformSchema.optional(),
  destinations: z.array(platformSchema).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
