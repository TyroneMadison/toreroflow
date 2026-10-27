import { hashtagCount, IG_LONGFORM_MAX_SECONDS, mentionCount } from "@toreroflow/core";
import {
  DEFAULT_PLATFORM_LIMITS,
  type Issue,
  type PlatformLimits,
  type PreflightDesign,
  type PreflightRequest,
  type PreflightResult,
  type WorkflowPlatform,
} from "@toreroflow/contracts";

/**
 * W2 preflight: every target of one draft checked at once, before anything
 * posts. Pure: the route loads the draft and hands it in, so each rule is
 * tested on its own without a database.
 *
 * Blocking (needs a fix or a logged override): missing cover, video over the
 * length limit, caption characters, hashtags, mentions, YouTube title.
 * Warning: fonts, colors or logo outside the brand kit, only when a kit exists.
 */

/**
 * Platform maximums (Oct 2026). Per-account limits are lower and override
 * these; none supplied yet (SPLIT-PLAN "Needs Tyrone"). Video length:
 * YouTube 12 hours (verified accounts), Instagram reels through the provider
 * 15 minutes, TikTok uploads 60 minutes.
 */
export const PREFLIGHT_LIMITS: PlatformLimits = {
  ...DEFAULT_PLATFORM_LIMITS,
  maxVideoSeconds: { youtube: 12 * 3600, instagram: IG_LONGFORM_MAX_SECONDS, tiktok: 60 * 60 },
};

export interface PreflightTarget {
  platform: WorkflowPlatform;
  /** The words that post, hashtags included. */
  caption: string;
  title?: string | null;
  cover?: string | null;
  videoSeconds?: number | null;
}

export interface PreflightInput {
  draftId: string;
  targets: PreflightTarget[];
  limits?: PlatformLimits;
  kit?: PreflightRequest["brandKit"] | null;
  design?: PreflightDesign | null;
}

type Level = "blocking" | "warning" | "ok";
export type Finding = { level: Level; issue: Issue };
type Rule = (t: PreflightTarget, input: PreflightInput & { limits: PlatformLimits }) => Finding[];

const NAME: Record<WorkflowPlatform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const n = (x: number) => x.toLocaleString("en-US");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const finding = (level: Level, t: PreflightTarget, draftId: string, code: string, message: string, field: string): Finding => ({
  level,
  issue: { platform: t.platform, code, message, fixRoute: `/create/${draftId}#${t.platform}.${field}` },
});

export const coverRule: Rule = (t, { draftId }) =>
  t.cover ? [] : [finding("blocking", t, draftId, "cover_missing", "no cover set", "cover")];

export const lengthRule: Rule = (t, { draftId, limits }) => {
  const max = limits.maxVideoSeconds[t.platform];
  if (max == null || t.videoSeconds == null || t.videoSeconds <= max) return [];
  return [
    finding("blocking", t, draftId, "video_too_long", `video is ${clock(t.videoSeconds)}, limit is ${clock(max)}`, "cutId"),
  ];
};

export const captionRule: Rule = (t, { draftId, limits }) => {
  const max =
    t.platform === "instagram"
      ? limits.instagram.captionChars
      : t.platform === "tiktok"
        ? limits.tiktok.captionChars
        : limits.youtube.descriptionChars;
  const chars = t.caption.length;
  if (chars <= max) return [];
  return [finding("blocking", t, draftId, "caption_too_long", `caption is ${n(chars)} characters, limit ${n(max)}`, "caption")];
};

/** Instagram caps hashtags and mentions; TikTok and YouTube publish no cap. */
export const tagsRule: Rule = (t, { draftId, limits }) => {
  if (t.platform !== "instagram") return [];
  const out: Finding[] = [];
  const tags = hashtagCount(t.caption);
  const mentions = mentionCount(t.caption);
  if (tags > limits.instagram.hashtags) {
    out.push(finding("blocking", t, draftId, "too_many_hashtags", `${tags} hashtags, limit ${limits.instagram.hashtags}`, "caption"));
  }
  if (mentions > limits.instagram.mentions) {
    out.push(finding("blocking", t, draftId, "too_many_mentions", `${mentions} mentions, limit ${limits.instagram.mentions}`, "caption"));
  }
  return out;
};

export const titleRule: Rule = (t, { draftId, limits }) => {
  if (t.platform !== "youtube") return [];
  const len = (t.title ?? "").length;
  const max = limits.youtube.titleChars;
  if (len === 0) return [finding("blocking", t, draftId, "title_missing", "no title set", "title")];
  if (len > max) return [finding("blocking", t, draftId, "title_too_long", `title is ${len} characters, limit ${max}`, "title")];
  return [finding("ok", t, draftId, "title_ok", `title ${len} of ${max} characters`, "title")];
};

/** Fonts, colors and logo outside the brand kit. Skipped when there is no kit or nothing to compare. */
export const brandKitRule: Rule = (t, { draftId, kit, design }) => {
  if (!kit || !design) return [];
  const out: Finding[] = [];
  const families = new Set(kit.fonts.map((f) => f.family.toLowerCase()));
  const colors = new Set(kit.colors.map((c) => c.toLowerCase()));
  const badFonts = design.fonts.filter((f) => !families.has(f.toLowerCase()));
  const badColors = design.colors.filter((c) => !colors.has(c.toLowerCase()));
  if (badFonts.length) {
    out.push(finding("warning", t, draftId, "font_off_brand", `uses a font not in the brand kit: ${badFonts.join(", ")}`, "cover"));
  }
  if (badColors.length) {
    out.push(finding("warning", t, draftId, "color_off_brand", `uses a color not in the brand kit: ${badColors.join(", ")}`, "cover"));
  }
  if (design.logoAssetId && design.logoAssetId !== kit.logoAssetId) {
    out.push(finding("warning", t, draftId, "logo_off_brand", "uses a logo that is not the brand kit logo", "cover"));
  }
  return out;
};

export const RULES: Rule[] = [coverRule, lengthRule, captionRule, tagsRule, titleRule, brandKitRule];

export function runPreflight(input: PreflightInput): PreflightResult {
  const ctx = { ...input, limits: input.limits ?? PREFLIGHT_LIMITS };
  const result: PreflightResult = { blocking: [], warnings: [], ok: [] };
  for (const t of input.targets) {
    for (const rule of RULES) {
      for (const f of rule(t, ctx)) {
        (f.level === "blocking" ? result.blocking : f.level === "warning" ? result.warnings : result.ok).push(f.issue);
      }
    }
  }
  return result;
}
