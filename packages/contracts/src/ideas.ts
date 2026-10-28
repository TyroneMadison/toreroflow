import { z } from "zod";
import { WorkflowPlatformSchema } from "./workflow";

const id = z.string().min(1);
const iso = z.string().datetime();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");

// ---- Monthly client report ----

export const MonthlyReportSchema = z.object({
  id,
  brandId: id,
  month,
  views: z.number().int().nonnegative(),
  followersGained: z.number().int(),
  posts: z.number().int().nonnegative(),
  topPostId: z.string().nullable(),
  nextMonthPlan: z.array(z.string()),
  /** Set once Confirm and send went through. */
  sentAt: iso.nullable(),
});
export type MonthlyReport = z.infer<typeof MonthlyReportSchema>;

export const REPORT_SENDER = "Toreronee@gmail.com";

export const ReportJobConfigSchema = z.object({
  /** Day of month the job runs. Always the 1st. */
  runDay: z.literal(1),
  sender: z.literal(REPORT_SENDER),
  /** Every client profile email, resolved at run time, never stored here. */
  recipients: z.literal("all_client_profile_emails"),
  /** true = job sends. Default false, OFF until Tyrone says yes. */
  killSwitch: z.boolean(),
});
export type ReportJobConfig = z.infer<typeof ReportJobConfigSchema>;
export const DEFAULT_REPORT_JOB_CONFIG: ReportJobConfig = {
  runDay: 1,
  sender: REPORT_SENDER,
  recipients: "all_client_profile_emails",
  killSwitch: false,
};

// ---- Trello intake (content requests) ----

export const TrelloIntakeConfigSchema = z.object({
  boardName: z.literal("Torone Editor Pipeline"),
  listName: z.literal("To edit"),
  /** Discovered at runtime by name, never hardcoded. Null until found. */
  boardId: z.string().nullable(),
  listId: z.string().nullable(),
  /** brandId to Trello label id. */
  labelByBrand: z.record(z.string(), z.string()),
});
export type TrelloIntakeConfig = z.infer<typeof TrelloIntakeConfigSchema>;

export const ContentRequestSchema = z.object({
  brandId: id,
  what: z.string().trim().min(1).max(2000),
  dueDate: z.string().date().optional(),
  /** http(s) only: the link lands on a Trello card an editor will click. */
  footageUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "footage link must start with http:// or https://")
    .optional(),
  notes: z.string().trim().max(4000).optional(),
});
/**
 * POST /r/:token, the public form. The brand comes from the signed link, so
 * it is not in the body. Unknown fields are refused. `website` is the
 * honeypot; turnstileToken is required only when the server has Turnstile on.
 */
export const ContentRequestFormSchema = ContentRequestSchema.omit({ brandId: true })
  .extend({
    website: z.string().max(500).optional(),
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict();
/** GET /r/:token: what the form needs to render. */
export const RequestFormInfoSchema = z.object({
  brandName: z.string(),
  turnstileSiteKey: z.string().nullable(),
  maxFileBytes: z.number().int().positive(),
  fileTypes: z.array(z.string()),
});
/** A brand's request form link, operator side. */
export const RequestFormLinkSchema = z.object({
  id,
  brandId: id,
  token: z.string().min(16),
  url: z.string(),
  revokedAt: iso.nullable(),
  createdAt: iso,
});
export const RequestFormLinkCreateSchema = z.object({ brandId: id });

// ---- Merged insights ----

export const InsightSourceSchema = z.enum(["zernio", "instagram", "youtube", "tiktok", "toreroflow"]);
export const MergedInsightSchema = z.object({
  /** postId + metric + day: two sources reporting the same number collapse to one. */
  dedupeKey: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  sources: z.array(InsightSourceSchema).min(1),
  chosenSource: InsightSourceSchema,
  /** Which platform the number is for, or "total" for the sum across them. */
  platform: z.string().optional(),
  /** YYYY-MM-DD the chosen number was measured on. */
  day: z.string().optional(),
}).refine((m) => m.sources.includes(m.chosenSource), "chosenSource must be one of sources");
export type MergedInsight = z.infer<typeof MergedInsightSchema>;
/** A source that could not answer, and why (e.g. Zernio without the Analytics add-on). */
export const InsightUnavailableSchema = z.object({ source: InsightSourceSchema, reason: z.string() });
export const InsightsResponseSchema = z.object({
  insights: z.array(MergedInsightSchema),
  unavailable: z.array(InsightUnavailableSchema).default([]),
});

// ---- Brand kit ----

export const BrandKitSchema = z.object({
  brandId: id,
  /** Google Fonts family names, e.g. "Inter", "Bebas Neue". */
  fonts: z.array(z.object({ family: z.string().min(1), weights: z.array(z.number().int()).default([400]) })),
  colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  logoAssetId: z.string().nullable(),
  voiceNotes: z.string().default(""),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

// ---- Sunra carousel: quote first, spend only after approval ----

/**
 * Fallback Sunra credits per image, as observed on the account, used only
 * while no Sunra catalog (list_models / estimate_cost) is wired on the server.
 * ponytail: hard-coded observed prices, the wired catalog replaces them.
 */
export const SUNRA_CREDITS_PER_IMAGE = { "nano-banana-2": 7, "nano-banana-pro": 14 } as const;
/** Slide size per platform: Instagram portrait 4:5, TikTok photo mode 9:16. */
export const SUNRA_SLIDE_SIZE = {
  instagram: { width: 1080, height: 1350, aspectRatio: "4:5" },
  tiktok: { width: 1080, height: 1920, aspectRatio: "9:16" },
} as const;

/** One Sunra image model. Empty lists mean Sunra did not say (not checked). */
export const SunraImageModelSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  provider: z.string(),
  /** Sunra estimate_cost for one image, in credits. */
  creditsPerImage: z.number().positive(),
  supportedAspectRatios: z.array(z.string()),
  supportedSizes: z.array(z.string()),
  supportedResolutions: z.array(z.string()),
  maxRefImages: z.number().int().min(0),
});
export type SunraImageModel = z.infer<typeof SunraImageModelSchema>;
/** GET /carousels/sunra/models: every image model Sunra offers, cached. */
export const SunraModelsResponseSchema = z.object({ models: z.array(SunraImageModelSchema) });
export type SunraModelsResponse = z.infer<typeof SunraModelsResponseSchema>;

const modelId = z.string().trim().min(1).max(200);

/** POST /sunra/carousel/quote. modelId must be one of GET /carousels/sunra/models. */
export const SunraCarouselRequestSchema = z.object({
  brandId: id,
  /** Instagram takes up to 10 slides; TikTok photo posts up to 20 here. */
  slides: z.number().int().min(1).max(20).default(5),
  /** What the user typed: the whole carousel, every slide is built from it. */
  prompt: z.string().trim().min(1).max(4000),
  platform: z.enum(["instagram", "tiktok"]).default("instagram"),
  modelId: modelId.default("nano-banana-2"),
});
export type SunraCarouselRequest = z.input<typeof SunraCarouselRequestSchema>;
export const SunraCarouselQuoteSchema = z.object({
  quoteId: id,
  modelId: z.string(),
  slides: z.number().int().positive(),
  creditsPerImage: z.number().positive(),
  /** slides x creditsPerImage, rounded up: the most this carousel can spend. */
  credits: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.enum(["4:5", "9:16"]),
  /** Always true: nothing is spent until a human approves this quote. */
  requiresApproval: z.literal(true),
  expiresAt: iso,
});
export type SunraCarouselQuote = z.infer<typeof SunraCarouselQuoteSchema>;
/** POST /sunra/carousel/:quoteId/generate. approved must be the literal true; modelId must match the quote and still be offered. */
export const SunraGenerateRequestSchema = z.object({ approved: z.literal(true), modelId });
export type SunraGenerateRequest = z.infer<typeof SunraGenerateRequestSchema>;
export const SunraGenerateResultSchema = z.object({
  quoteId: id,
  modelId: z.string(),
  status: z.enum(["generating", "done", "failed"]),
  slideUrls: z.array(z.string()),
  error: z.string().optional(),
});
export type SunraGenerateResult = z.infer<typeof SunraGenerateResultSchema>;
/** Generation as a whole. Off by default: quotes still work, generate answers 403. */
export const SunraSettingsSchema = z.object({ generationEnabled: z.boolean() });
/** GET /sunra/settings: the switch, plus whether this server has a Sunra generator wired. */
export const SunraStatusSchema = SunraSettingsSchema.extend({ connected: z.boolean() });

// ---- Client approval link ----

export const ApprovalLinkSchema = z.object({
  id,
  versionId: id,
  token: z.string().min(16),
  expiresAt: iso,
  revokedAt: iso.nullable(),
  status: z.enum(["pending", "approved", "changes_requested"]),
});
export const ApprovalLinkCreateSchema = z.object({ versionId: id, expiresInHours: z.number().int().min(1).max(24 * 30) });
export const ApprovalLinkListSchema = z.object({ links: z.array(ApprovalLinkSchema) });
/** Public page /a/:token: a comment, pinned to a moment when atMs is set. */
export const ApprovalCommentCreateSchema = z.object({
  atMs: z.number().int().nonnegative().optional(),
  body: z.string().trim().min(1).max(2000),
});
export const ApprovalCommentSchema = z.object({ id, atMs: z.number().int().nullable(), body: z.string(), createdAt: iso });
export const ApprovalDecisionSchema = z.object({ decision: z.enum(["approved", "changes_requested"]) });
export const PublicApprovalSchema = z.object({
  status: ApprovalLinkSchema.shape.status,
  expiresAt: iso,
  video: z.object({ name: z.string(), url: z.string(), durationSec: z.number().nullable() }),
  comments: z.array(ApprovalCommentSchema),
});

// ---- Failed post retry (always manual) ----

export const FailedPostRetrySchema = z.object({
  postTargetId: id,
  platform: WorkflowPlatformSchema,
  error: z.string(),
  reason: z.string(),
  action: z.enum(["retry", "reconnect"]),
});
/** GET /failed-posts: the alert banner count and the list behind it. */
export const FailedPostListSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(
    FailedPostRetrySchema.extend({
      brandId: id,
      /** What to do about it, in the operator's words. */
      advice: z.string(),
      scheduledAt: iso.nullable(),
    }),
  ),
});
export const FailedPostRetryResultSchema = z.object({
  /** "already_live" means the post was found live and nothing was re-uploaded. */
  outcome: z.enum(["queued", "already_live", "needs_reconnect"]),
});

// ---- Asset library ----

export const AssetSchema = z.object({
  id,
  /** Null means shared across every brand. */
  brandId: z.string().nullable(),
  type: z.enum(["logo", "video", "template", "audio", "image"]),
  name: z.string().min(1),
  url: z.string(),
  createdAt: iso,
});
export type Asset = z.infer<typeof AssetSchema>;
export const AssetListSchema = z.object({ assets: z.array(AssetSchema) });
/**
 * GET /assets filters. brandId set: what that brand can see (its own plus
 * shared). sharing "shared" or "brand" narrows to one side.
 */
export const AssetQuerySchema = z.object({
  brandId: z.string().min(1).optional(),
  type: AssetSchema.shape.type.optional(),
  sharing: z.enum(["shared", "brand", "all"]).default("all"),
});

// ---- Repurpose (placeholder, built last) ----

export const RepurposeJobSchema = z.object({
  id,
  sourceVideoId: id,
  step: z.enum(["transcribe", "find_moments", "cut", "captions", "thumbnails", "review", "done"]),
  state: z.enum(["queued", "running", "failed", "done"]),
});
export type RepurposeJob = z.infer<typeof RepurposeJobSchema>;
