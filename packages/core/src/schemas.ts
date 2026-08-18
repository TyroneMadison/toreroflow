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
  /** A track from Instagram's catalog. Reels only; see buildPostExtras. */
  audioId: z.string().max(120).optional(),
  audioVolume: z.number().int().min(0).max(100).optional(),
  videoVolume: z.number().int().min(0).max(100).optional(),
  shareToFeed: z.boolean().optional(),
  firstComment: z.string().max(2200).optional(),
  aiLabel: z.boolean().optional(),
  /** Also put this video on the account's story, as a second post. */
  alsoStory: z.boolean().optional(),
});

/** Instagram refuses stories longer than this. */
export const INSTAGRAM_STORY_MAX_SECONDS = 60;

/**
 * How long a video may be and still be SENT as a reel.
 *
 * Three minutes, matching what Instagram's own app allows since January 2025,
 * because the Reels tab is where the reach is and a video should get the best
 * placement available to it.
 *
 * Whether Meta's API honours three minutes is genuinely unsettled. Every
 * public source says the Content Publishing API still caps a reel at 90
 * seconds, and one measurement on a real account agrees: a 106 second video
 * was sent twice as contentType "reels" and both times Instagram created the
 * container, left it at "awaiting-finalize", and never published it. Note the
 * shape of that failure. It was not refused; it was accepted and abandoned,
 * which is exactly why it went unnoticed for three days.
 *
 * So this is optimistic on purpose, and it is safe to be optimistic now for
 * one reason: confirmPublishing watches what the platform actually did. If the
 * reel stalls, the target fails visibly within the minute and the feed-post
 * fallback republishes it. The day Meta raises the API limit this starts
 * working with no change here.
 */
export const INSTAGRAM_REEL_MAX_SECONDS = 180;

/**
 * The length past which a reel is not even attempted.
 *
 * Above this the Reels tab is not on offer at any limit, so the first attempt
 * goes straight to a feed post rather than spending a failure to learn that.
 */
export const INSTAGRAM_REEL_ATTEMPT_CEILING = 180;

/**
 * The longest video Instagram will take at all, as a feed post.
 *
 * Sixty minutes per the provider's own limits, which is far past anything this
 * agency posts; it exists so a genuinely absurd file is refused with a sentence
 * rather than dying inside the provider.
 */
export const INSTAGRAM_FEED_MAX_SECONDS = 60 * 60;

export const tiktokOptionsSchema = z.object({
  /**
   * Let TikTok attach a recommended track to a photo carousel. TikTok picks
   * the song; no API anywhere allows choosing one from their library, so a
   * toggle is the whole of what can honestly be offered.
   */
  autoAddMusic: z.boolean().optional(),
  /** Deliver to the creator's TikTok inbox instead of publishing. */
  draft: z.boolean().optional(),
});

export const youtubeOptionsSchema = z.object({
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  madeForKids: z.boolean().optional(),
  firstComment: z.string().max(10_000).optional(),
  categoryId: z.string().max(10).optional(),
  playlistId: z.string().max(60).optional(),
  aiLabel: z.boolean().optional(),
  /*
   * The long-form wizard's fields. The first two override what the route
   * would otherwise derive from the asset's draft copy, because the wizard
   * puts a real editor in front of the operator and what they typed there is
   * the truth. The rest cannot ride Zernio at all; they are stored on the
   * target and applied by the enrichment job through the channel owner's own
   * OAuth after the publish confirms (docs/longform-capability-map.md).
   */
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  /**
   * YouTube counts the pool as the tags joined with commas, capped at 500.
   * Enforced here rather than only in the wizard so a raw request cannot
   * store a set the platform will refuse at apply time.
   */
  tags: z
    .array(z.string().min(1).max(100))
    .max(60)
    .refine((t) => t.join(",").length <= 500, {
      message: "tags exceed YouTube's 500-character pool",
    })
    .optional(),
  license: z.enum(["standard", "creativeCommon"]).optional(),
  embeddable: z.boolean().optional(),
  /** ISO date (YYYY-MM-DD). The API takes a datetime; the day is what matters. */
  recordingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** BCP-47 tag for the video's spoken language, e.g. "en" or "es-419". */
  defaultLanguage: z.string().max(12).optional(),
  paidPromotion: z.boolean().optional(),
  /**
   * What the operator chose that no API can execute: comment settings, end
   * screens, fundraisers, members-only and the rest. Compiled by the wizard
   * into human sentences and shown on the published post beside the Studio
   * deep link, because recording a choice and silently not acting on it is
   * worse than not offering the choice.
   */
  studioTasks: z.array(z.string().min(1).max(200)).max(30).optional(),
  /**
   * The ad-suitability self-rating, answered in the wizard.
   *
   * Google offers no API to submit this, so it exists for two honest jobs:
   * it gates the wizard's own Schedule button (rate before you publish, the
   * discipline Studio enforces), and it prints on the finish-in-Studio card
   * so a monetized channel can carry the same answers over in one look.
   */
  selfCert: z
    .object({
      rating: z.enum(["safe", "limited"]),
      /** The category keys the operator flagged; empty means none apply. */
      flags: z.array(z.string().min(1).max(40)).max(20),
    })
    .optional(),
  /**
   * A subtitle track, uploaded to our storage at schedule time and laid onto
   * the video through captions.insert once the publish confirms. The key
   * points inside STORAGE_DIR; the language is BCP-47 and doubles as the
   * track's display name via the wizard's language list.
   */
  captions: z
    .object({
      key: z.string().min(1).max(300),
      language: z.string().min(1).max(12),
      name: z.string().max(60).optional(),
    })
    .optional(),
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

/**
 * An inline button on an auto-DM. Meta renders at most three.
 *
 * `url` is the whole point of a comment-to-DM campaign: someone comments the
 * keyword and gets the link. `postback` fires a payload back at the webhook
 * instead, and `phone` is Facebook only because Instagram refuses it.
 */
export const dmButtonSchema = z
  .object({
    type: z.enum(["url", "postback", "phone"]),
    /** Meta truncates past 20; refusing is better than shipping a clipped label. */
    title: z.string().min(1).max(20),
    url: z.string().url().optional(),
    payload: z.string().max(1000).optional(),
    phone: z.string().max(40).optional(),
  })
  .refine((b) => b.type !== "url" || !!b.url, { message: "a url button needs a url" })
  .refine((b) => b.type !== "postback" || !!b.payload, {
    message: "a postback button needs a payload",
  })
  .refine((b) => b.type !== "phone" || !!b.phone, { message: "a phone button needs a number" });

/**
 * A comment-to-DM campaign.
 *
 * Instagram and Facebook only: Meta is the only platform exposing both the
 * comment webhook and the DM send, so a campaign on any other account has
 * nothing to listen to. The route refuses those rather than creating something
 * that can never fire.
 */
export const dmCampaignSchema = z.object({
  /** Our SocialAccount id; the route resolves the provider's. */
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  /** What the commenter receives. Meta's own ceiling is 1000 characters. */
  dmMessage: z.string().min(1).max(1000),
  /**
   * At least one. Zernio rejects an empty list on an active automation, and
   * a campaign with no keyword would answer every comment on the account.
   */
  keywords: z.array(z.string().min(1).max(60)).min(1).max(20),
  matchMode: z.enum(["exact", "contains", "word"]).optional(),
  excludeKeywords: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** The platform's own media id, to scope the campaign to one video. */
  platformPostId: z.string().max(120).optional(),
  postTitle: z.string().max(200).optional(),
  buttons: z.array(dmButtonSchema).max(3).optional(),
  /** A public reply left on the comment itself, alongside the DM. */
  commentReply: z.string().max(2200).optional(),
  /** Also answer people who DM the keyword rather than commenting it. */
  alsoMatchInDms: z.boolean().optional(),
  /** Wraps links so clicks are counted. On unless turned off. */
  linkTracking: z.boolean().optional(),
});
export type DmCampaignInput = z.infer<typeof dmCampaignSchema>;

/**
 * A partial edit. accountId is absent because moving a campaign to a different
 * account is not an edit: its counters belong to the account it ran on, and
 * carrying them across would restate one account's results as another's.
 */
export const updateDmCampaignSchema = dmCampaignSchema
  .partial()
  .omit({ accountId: true })
  .extend({ isActive: z.boolean().optional() });
export type UpdateDmCampaignInput = z.infer<typeof updateDmCampaignSchema>;

/**
 * A manual reply in a DM thread.
 *
 * Short by Meta's own limit, and required rather than optional: an empty
 * message would be a request to send nothing to a real person's inbox.
 */
export const inboxReplySchema = z.object({
  accountId: z.string().min(1),
  message: z.string().min(1).max(1000),
});
export type InboxReplyInput = z.infer<typeof inboxReplySchema>;
