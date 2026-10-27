import assert from "node:assert/strict";
import type { z } from "zod";
import {
  ApprovalLinkSchema,
  BotIdentitySchema,
  canOverridePreflight,
  DEFAULT_PLATFORM_LIMITS,
  DEFAULT_REPORT_JOB_CONFIG,
  DraftSchema,
  ENDPOINTS,
  hasScope,
  MergedInsightSchema,
  OverrideRequestSchema,
  OverridesSchema,
  POLLY,
  PreflightResultSchema,
  QueueItemSchema,
  QueueReorderRequestSchema,
  ReportJobConfigSchema,
  resetOverride,
  resolveTarget,
  RollupSchema,
  SunraCarouselQuoteSchema,
  SunraCarouselRequestSchema,
  SunraGenerateRequestSchema,
  SunraModelsResponseSchema,
  TemplateSchema,
  TrelloIntakeConfigSchema,
  type Draft,
  type Principal,
  type Target,
} from "./index";

// Compile-time: inferred types line up with the spec shapes.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _t1: Eq<Target["platform"], "youtube" | "instagram" | "tiktok"> = true;
const _t2: Eq<keyof Target["overrides"], "caption" | "title" | "cover" | "cutId" | "postAt"> = true;
const _t3: Eq<z.infer<typeof QueueItemSchema>["priority"], "rush" | "normal"> = true;
void [_t1, _t2, _t3];

const at = "2026-11-01T15:00:00.000Z";
const draft: Draft = {
  id: "d1",
  brandId: "b1",
  videoId: "v1",
  caption: "draft caption",
  title: "Draft title",
  postAt: at,
  targets: [
    { platform: "youtube", overrides: {} },
    { platform: "instagram", overrides: { caption: "ig only" } },
    { platform: "tiktok", overrides: {} },
  ],
};
assert.deepEqual(DraftSchema.parse(draft), draft);

// Override wins on its own target only; others follow the draft.
assert.equal(resolveTarget(draft, draft.targets[1]!).caption, "ig only");
assert.equal(resolveTarget(draft, draft.targets[0]!).caption, "draft caption");
// An empty-string override still counts as overridden.
assert.equal(resolveTarget(draft, { platform: "tiktok", overrides: { caption: "" } }).caption, "");

// Reset deletes the key, does not leave it as undefined.
const reset = resetOverride(draft.targets[1]!, "caption");
assert.equal("caption" in reset.overrides, false);
assert.equal("caption" in draft.targets[1]!.overrides, true, "reset does not mutate");

// Unknown override fields and unknown platforms are refused.
assert.equal(OverridesSchema.safeParse({ hashtags: "#x" }).success, false);
assert.equal(DraftSchema.safeParse({ ...draft, targets: [{ platform: "snapchat", overrides: {} }] }).success, false);

// Preflight result and override reason.
assert.ok(
  PreflightResultSchema.parse({
    blocking: [{ platform: "instagram", code: "caption_too_long", message: "2,201 characters", fixRoute: "/create/d1#instagram.caption" }],
    warnings: [],
    ok: [],
  }),
);
assert.equal(OverrideRequestSchema.safeParse({ reason: "  " }).success, false);
assert.equal(OverrideRequestSchema.safeParse({}).success, false);
assert.ok(OverrideRequestSchema.parse({ reason: "client approved by phone" }));

// Queue.
assert.equal(QueueItemSchema.safeParse({ id: "q", draftId: "d1", priority: "urgent", position: 0, state: "queued" }).success, false);
assert.equal(QueueReorderRequestSchema.safeParse({ ids: ["a", "a"] }).success, false);
assert.ok(QueueReorderRequestSchema.parse({ ids: ["b", "a"] }));

// Rollup and template.
assert.ok(RollupSchema.parse({ videoId: "v1", rows: [{ metric: "views", youtube: 10, instagram: null, tiktok: 5, total: 15 }] }));
const template = {
  id: "t1",
  scope: "brand",
  brandId: "b1",
  name: "Walkaround",
  platforms: ["instagram"],
  captionPattern: "{hook}",
  hashtags: ["#cars"],
  coverStyle: "bold",
  postTimes: ["09:30"],
  cadence: "3 per week",
};
assert.ok(TemplateSchema.parse(template));
assert.equal(TemplateSchema.safeParse({ ...template, scope: "global" }).success, false);
assert.equal(TemplateSchema.safeParse({ ...template, postTimes: ["25:00"] }).success, false);

// Platform limit defaults are the platform maximums.
assert.deepEqual(DEFAULT_PLATFORM_LIMITS.instagram, { captionChars: 2200, hashtags: 30, mentions: 20 });
assert.deepEqual(DEFAULT_PLATFORM_LIMITS.youtube, { titleChars: 100, descriptionChars: 5000 });
assert.equal(DEFAULT_PLATFORM_LIMITS.tiktok.captionChars, 2200);

// Ideas: report job is OFF by default, runs on the 1st, fixed sender.
assert.equal(DEFAULT_REPORT_JOB_CONFIG.killSwitch, false);
assert.ok(ReportJobConfigSchema.parse(DEFAULT_REPORT_JOB_CONFIG));
assert.equal(ReportJobConfigSchema.safeParse({ ...DEFAULT_REPORT_JOB_CONFIG, runDay: 15 }).success, false);
assert.equal(ReportJobConfigSchema.safeParse({ ...DEFAULT_REPORT_JOB_CONFIG, sender: "other@x.com" }).success, false);
assert.ok(TrelloIntakeConfigSchema.parse({ boardName: "Torone Editor Pipeline", listName: "To edit", boardId: null, listId: null, labelByBrand: {} }));
assert.equal(
  MergedInsightSchema.safeParse({ dedupeKey: "p|views|d", metric: "views", value: 1, sources: ["zernio"], chosenSource: "youtube" }).success,
  false,
);
assert.equal(
  SunraCarouselQuoteSchema.safeParse({ quoteId: "q", modelId: "nano-banana-2", slides: 1, creditsPerImage: 7, credits: 7, width: 1080, height: 1350, aspectRatio: "4:5", requiresApproval: false, expiresAt: at }).success,
  false,
  "a quote never skips approval",
);
assert.equal(SunraGenerateRequestSchema.safeParse({ approved: true }).success, false, "generate names the model it pays for");
assert.ok(SunraGenerateRequestSchema.parse({ approved: true, modelId: "gpt-image-1" }));
assert.equal(SunraCarouselRequestSchema.parse({ brandId: "b", prompt: "x" }).modelId, "nano-banana-2");
assert.equal(
  SunraModelsResponseSchema.safeParse({ models: [{ id: "m", label: "M", provider: "p", creditsPerImage: 0, supportedAspectRatios: [], supportedSizes: [], supportedResolutions: [], maxRefImages: 0 }] }).success,
  false,
  "a model always has a price",
);
assert.equal(
  ApprovalLinkSchema.safeParse({ id: "a", versionId: "v", token: "short", expiresAt: at, revokedAt: null, status: "pending" }).success,
  false,
);

// Permissions: Polly is full access, other bots default to none.
const polly: Principal = { role: "bot", bot: POLLY };
const other: Principal = { role: "bot", bot: BotIdentitySchema.parse({ name: "coverbot" }) };
assert.equal(BotIdentitySchema.parse({ name: "x" }).fullAccess, false);
assert.equal(canOverridePreflight({ role: "owner" }), true);
assert.equal(canOverridePreflight(polly), true);
assert.equal(canOverridePreflight(other), false);
assert.equal(canOverridePreflight({ role: "viewer" }), false);
assert.equal(hasScope(other, "templates:apply"), false);
assert.equal(hasScope({ role: "bot", bot: { name: "b", fullAccess: false, scopes: ["templates:read"] } }, "templates:read"), true);

// Every endpoint path is unique per method and starts with "/".
const keys = Object.values(ENDPOINTS).map((e) => `${e.method} ${e.path}`);
assert.equal(new Set(keys).size, keys.length);
assert.ok(keys.every((k) => k.split(" ")[1]!.startsWith("/")));

console.log(`contracts.check: ok (${keys.length} endpoints)`);
