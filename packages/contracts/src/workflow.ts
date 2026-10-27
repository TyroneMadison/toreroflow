import { z } from "zod";
import {
  IG_CAPTION_MAX,
  IG_HASHTAG_MAX,
  IG_MENTION_MAX,
  TIKTOK_VIDEO_CAPTION_MAX,
  YOUTUBE_DESCRIPTION_MAX,
} from "@toreroflow/core";

/** The three platforms the workflow set fans out to (W1 to W5). */
export const WorkflowPlatformSchema = z.enum(["youtube", "instagram", "tiktok"]);
export type WorkflowPlatform = z.infer<typeof WorkflowPlatformSchema>;

// ---- W1 fan-out: one draft, one target per platform ----

/** The fields a target can override. Present in `overrides` means overridden. */
export const OverridesSchema = z
  .object({
    caption: z.string(),
    title: z.string(),
    cover: z.string(),
    cutId: z.string(),
    postAt: z.string().datetime(),
  })
  .partial()
  .strict();
export type Overrides = z.infer<typeof OverridesSchema>;
export type OverrideField = keyof Overrides;

export const TargetSchema = z.object({
  platform: WorkflowPlatformSchema,
  overrides: OverridesSchema,
});
export type Target = z.infer<typeof TargetSchema>;

export const DraftSchema = z.object({
  id: z.string().min(1),
  brandId: z.string().min(1),
  videoId: z.string().min(1),
  caption: z.string(),
  title: z.string().optional(),
  postAt: z.string().datetime(),
  targets: z.array(TargetSchema),
});
export type Draft = z.infer<typeof DraftSchema>;

/** PUT /drafts/:id body: the whole draft minus its id. */
export const DraftUpsertSchema = DraftSchema.omit({ id: true });
export type DraftUpsert = z.infer<typeof DraftUpsertSchema>;

/** Reset to draft: the key is deleted, never set to undefined or "". */
export function resetOverride(target: Target, field: OverrideField): Target {
  const overrides = { ...target.overrides };
  delete overrides[field];
  return { ...target, overrides };
}

/** What a target actually posts: its override when present, else the draft's value. */
export function resolveTarget(draft: Draft, target: Target) {
  const o = target.overrides;
  return {
    platform: target.platform,
    caption: "caption" in o ? o.caption! : draft.caption,
    title: "title" in o ? o.title : draft.title,
    cover: o.cover,
    cutId: o.cutId,
    postAt: "postAt" in o ? o.postAt! : draft.postAt,
  };
}

// ---- W2 preflight ----

export const IssueSchema = z.object({
  platform: WorkflowPlatformSchema,
  code: z.string().min(1),
  message: z.string(),
  /** App route to the field that fixes it, e.g. "/create/draft_1#instagram.caption". */
  fixRoute: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

/** What a post's cover and overlays use, for the brand kit checks. */
export const PreflightDesignSchema = z.object({
  fonts: z.array(z.string()),
  colors: z.array(z.string()),
  logoAssetId: z.string().nullable().optional(),
});
export type PreflightDesign = z.infer<typeof PreflightDesignSchema>;

/**
 * design and brandKit are optional (additive): the brand kit rules run only
 * when both are present. brandKit is the BrandKit fields the rules read; the
 * server has no kit store on this branch yet.
 */
export const PreflightRequestSchema = z.object({
  draftId: z.string().min(1),
  design: PreflightDesignSchema.optional(),
  brandKit: z
    .object({
      fonts: z.array(z.object({ family: z.string().min(1) })),
      colors: z.array(z.string()),
      logoAssetId: z.string().nullable(),
    })
    .optional(),
});
export type PreflightRequest = z.infer<typeof PreflightRequestSchema>;
export const PreflightResultSchema = z.object({
  blocking: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  ok: z.array(IssueSchema),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

/** POST /drafts/:id/override body. The reason is required and kept. */
export const OverrideRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type OverrideRequest = z.infer<typeof OverrideRequestSchema>;

/** Who did it. Logged with every override. */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("bot"), bot: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

export const OverrideLogSchema = z.object({
  id: z.string().min(1),
  draftId: z.string().min(1),
  reason: z.string(),
  actor: ActorSchema,
  at: z.string().datetime(),
});
export type OverrideLog = z.infer<typeof OverrideLogSchema>;

// ---- W3 upload queue ----

export const QueuePrioritySchema = z.enum(["rush", "normal"]);
export const QueueStateSchema = z.enum(["queued", "uploading", "done", "failed"]);
export const QueueItemSchema = z.object({
  id: z.string().min(1),
  draftId: z.string().min(1),
  priority: QueuePrioritySchema,
  position: z.number().int().nonnegative(),
  state: QueueStateSchema,
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/** PATCH /queue/reorder: the full new order, first id uploads first. */
export const QueueReorderRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "ids must be unique"),
});
export const QueueResponseSchema = z.object({ items: z.array(QueueItemSchema) });
/** PATCH /queue/:id/priority: the operator (or Polly) marks a video Client rush, or back to normal. */
export const QueuePriorityRequestSchema = z.object({ priority: QueuePrioritySchema });

// ---- W4 rollup ----

export const RollupMetricSchema = z.enum(["views", "likes", "comments", "shares", "avgWatchSeconds"]);
export const RollupRowSchema = z.object({
  metric: RollupMetricSchema,
  /** Null when that platform has no post or no number for it. */
  youtube: z.number().nullable(),
  instagram: z.number().nullable(),
  tiktok: z.number().nullable(),
  total: z.number().nullable(),
});
export const RollupSchema = z.object({
  videoId: z.string().min(1),
  rows: z.array(RollupRowSchema),
});
export type Rollup = z.infer<typeof RollupSchema>;

// ---- W5 templates ----

export const TemplateSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["client", "brand"]),
  brandId: z.string().min(1),
  name: z.string().min(1),
  platforms: z.array(WorkflowPlatformSchema).min(1),
  captionPattern: z.string(),
  hashtags: z.array(z.string()),
  coverStyle: z.string(),
  /** "HH:mm" in ET. */
  postTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  /** Free text such as "3 per week, Mon Wed Fri". */
  cadence: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;
export const TemplateUpsertSchema = TemplateSchema.omit({ id: true });
export const TemplateListSchema = z.object({ templates: z.array(TemplateSchema) });
export const TemplateApplyRequestSchema = z.object({ videoId: z.string().min(1), postAt: z.string().datetime() });

/** GET /templates/cadence?brandId=: suggestions from the brand's posting history (last 8 weeks, ET). */
export const WeekdaySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
export const CadenceSlotSchema = z.object({
  day: WeekdaySchema,
  /** "HH:00" in ET. */
  time: z.string().regex(/^([01]\d|2[0-3]):00$/),
});
export const CadenceSuggestionsSchema = z.object({
  brandId: z.string().min(1),
  postsPerWeek: z.number().nonnegative(),
  /** Best slots by average views, best first (up to 3). */
  bestTimes: z.array(CadenceSlotSchema.extend({ posts: z.number().int(), avgViews: z.number().nullable() })),
  /** A regular slot (used in at least half the weeks) with no post in a given week. */
  missedSlots: z.array(CadenceSlotSchema.extend({ weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  /** Suggested Template.cadence text, e.g. "3 per week, Mon Wed Fri". */
  cadence: z.string(),
});
export type CadenceSuggestions = z.infer<typeof CadenceSuggestionsSchema>;

// ---- Platform limits (preflight config) ----

export const PlatformLimitsSchema = z.object({
  instagram: z.object({ captionChars: z.number().int(), hashtags: z.number().int(), mentions: z.number().int() }),
  youtube: z.object({ titleChars: z.number().int(), descriptionChars: z.number().int() }),
  tiktok: z.object({ captionChars: z.number().int() }),
  /** Per-platform max video length in seconds; null means not checked. */
  maxVideoSeconds: z.record(WorkflowPlatformSchema, z.number().int().positive().nullable()),
});
export type PlatformLimits = z.infer<typeof PlatformLimitsSchema>;

/**
 * DEFAULTS: the platform maximums (Oct 2026). Per-account limits may be lower
 * and override these; Tyrone has not supplied any yet (SPLIT-PLAN "Needs Tyrone").
 */
export const DEFAULT_PLATFORM_LIMITS: PlatformLimits = {
  instagram: { captionChars: IG_CAPTION_MAX, hashtags: IG_HASHTAG_MAX, mentions: IG_MENTION_MAX },
  youtube: { titleChars: 100, descriptionChars: YOUTUBE_DESCRIPTION_MAX },
  tiktok: { captionChars: TIKTOK_VIDEO_CAPTION_MAX },
  maxVideoSeconds: { youtube: null, instagram: null, tiktok: null },
};
