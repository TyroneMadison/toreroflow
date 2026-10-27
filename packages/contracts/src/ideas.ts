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
  footageUrl: z.string().url().optional(),
  notes: z.string().max(4000).optional(),
});

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

export const SunraCarouselRequestSchema = z.object({
  brandId: id,
  slides: z.number().int().min(1).max(20),
  prompt: z.string().min(1),
  /** Instagram takes up to 10 slides; TikTok photo posts up to 20 here. */
  platform: z.enum(["instagram", "tiktok"]).default("instagram"),
});
export const SunraCarouselQuoteSchema = z.object({
  quoteId: id,
  priceUsd: z.number().nonnegative(),
  /** Always true: nothing is spent until a human approves this quote. */
  requiresApproval: z.literal(true),
  expiresAt: iso,
});
export type SunraCarouselQuote = z.infer<typeof SunraCarouselQuoteSchema>;
/** POST /sunra/carousel/:quoteId/generate. approved must be the literal true. */
export const SunraGenerateRequestSchema = z.object({ approved: z.literal(true) });
export const SunraGenerateResultSchema = z.object({
  quoteId: id,
  status: z.enum(["generating", "done", "failed"]),
  slideUrls: z.array(z.string()),
});
/** Generation as a whole. Off by default: quotes still work, generate answers 403. */
export const SunraSettingsSchema = z.object({ generationEnabled: z.boolean() });

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

// ---- Failed post retry (always manual) ----

export const FailedPostRetrySchema = z.object({
  postTargetId: id,
  platform: WorkflowPlatformSchema,
  error: z.string(),
  reason: z.string(),
  action: z.enum(["retry", "reconnect"]),
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

// ---- Repurpose (placeholder, built last) ----

export const RepurposeJobSchema = z.object({
  id,
  sourceVideoId: id,
  step: z.enum(["transcribe", "find_moments", "cut", "captions", "thumbnails", "review", "done"]),
  state: z.enum(["queued", "running", "failed", "done"]),
});
export type RepurposeJob = z.infer<typeof RepurposeJobSchema>;
