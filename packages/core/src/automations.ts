import { z } from "zod";
import { DM_WINDOW_MS, isPlatformPostId } from "./dm";

/**
 * DM automations (F4): the rules the API, the worker and the screen share.
 *
 * An automation is a trigger plus what it sends. The matcher lives here so the
 * editor's "matches GUIDE" line, the API's dry run and the worker's real run
 * can never disagree. Ported from fewchat's comments.ts and flows.ts (MIT,
 * Copyright (c) 2026 Jason Cooperson; see THIRD_PARTY_NOTICES.md).
 */

export const DM_TRIGGERS = ["comment", "story_reply", "story_mention", "dm_keyword", "welcome"] as const;
export type DmTrigger = (typeof DM_TRIGGERS)[number];
export const DM_TRIGGER_LABEL: Record<DmTrigger, string> = {
  comment: "Comment on a post or reel",
  story_reply: "Reply to your story",
  story_mention: "Mention in their story",
  dm_keyword: "DM with a keyword",
  welcome: "First DM ever",
};

/** contains: "can I get the guide pls" has GUIDE. word: as a whole word. exact: the whole text. any: everything. */
export const DM_MATCH_MODES = ["contains", "word", "exact", "any"] as const;
export type DmMatchMode = (typeof DM_MATCH_MODES)[number];

/** all: every post, old and new. next: locks onto the next post published. posts: the ones picked. */
export const DM_SCOPES = ["all", "next", "posts"] as const;
export type DmScope = (typeof DM_SCOPES)[number];

export const DM_AUTOMATION_STATUSES = ["draft", "live", "paused"] as const;
export type DmAutomationStatus = (typeof DM_AUTOMATION_STATUSES)[number];

/** Meta: a comment can get one private reply, within 7 days of it. */
export const PRIVATE_REPLY_MS = 7 * 24 * 60 * 60 * 1000;
/** Meta allows 750 private replies an hour per account; fewchat stays under it with room to spare. */
export const AUTOMATION_HOURLY_BUDGET = 700;
/** What a test code is good for once handed out. */
export const TEST_CODE_MS = 15 * 60 * 1000;

const keyword = z.string().trim().min(1).max(60);
const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => u.startsWith("https://"), "the button link has to start with https://");

/**
 * Instagram media ids only. The old campaign picker sent YouTube video ids,
 * which nothing ever matched; an automation's scope refuses anything else.
 */
export const instagramPostId = z
  .string()
  .trim()
  .refine((id) => isPlatformPostId("instagram", id), "That is not an Instagram post id. Pick a post or reel from this account.");

/** One step. A message with an optional link button today; delays and conditions join with the flow builder. */
export const dmStepSchema = z.object({
  type: z.literal("message"),
  text: z.string().max(1000),
  button: z.object({ title: z.string().trim().min(1).max(20), url: httpsUrl }).nullable().optional(),
});
export type DmStep = z.infer<typeof dmStepSchema>;

export const dmAutomationConfigSchema = z.object({
  trigger: z.enum(DM_TRIGGERS),
  keywords: z.array(keyword).max(20),
  matchMode: z.enum(DM_MATCH_MODES),
  excludeKeywords: z.array(keyword).max(20),
  scope: z.enum(DM_SCOPES),
  postIds: z.array(instagramPostId).max(10),
  steps: z.array(dmStepSchema).max(1),
  publicReplyOn: z.boolean(),
  publicReplies: z.array(z.string().trim().min(1).max(300)).max(5),
  oncePerContact: z.boolean(),
  followersOnly: z.boolean(),
  trackLinks: z.boolean(),
  alsoDmKeyword: z.boolean(),
});
export type DmAutomationConfig = z.infer<typeof dmAutomationConfigSchema>;

export const DM_CONFIG_KEYS = Object.keys(dmAutomationConfigSchema.shape) as Array<keyof DmAutomationConfig>;

const folder = z.string().trim().max(40).nullable();

/** Save in the editor: any subset of the working copy. */
export const dmAutomationPatchSchema = dmAutomationConfigSchema
  .partial()
  .extend({
    name: z.string().trim().min(1).max(120).optional(),
    folder: folder.optional(),
    /** Another account: only while it was never published (its counts belong to the account it ran on). */
    socialAccountId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type DmAutomationPatch = z.infer<typeof dmAutomationPatchSchema>;

export const DM_TEMPLATES = ["comment_link", "comment_followers", "dm_keyword", "story_reply", "welcome", "story_mention", "blank"] as const;
export type DmTemplate = (typeof DM_TEMPLATES)[number];

export const dmAutomationCreateSchema = z
  .object({
    socialAccountId: z.string().min(1),
    template: z.enum(DM_TEMPLATES),
    name: z.string().trim().min(1).max(120).optional(),
    folder: folder.optional(),
  })
  .strict();

export const dmAutomationPublishSchema = z
  .object({
    /** native: our Meta app. zernio: a Zernio campaign, for accounts not connected natively (comment triggers only). */
    engine: z.enum(["native", "zernio"]).optional(),
    /** Zernio campaigns to pause because this one covers the same keyword. Never paused unless named here. */
    pauseCampaignIds: z.array(z.string().min(1).max(100)).max(20).optional(),
  })
  .strict();

const DEFAULT_PUBLIC = ["Sent! Check your DMs", "Just sent it to your inbox", "Done, look in your DMs"];

export const DM_TEMPLATE_INFO: Record<DmTemplate, { name: string; blurb: string; tag: string; icon: string }> = {
  comment_link: {
    name: "Comment keyword to DM link",
    blurb: "Someone comments a keyword and gets a DM with a button that sends your link.",
    tag: "Post or reel comments",
    icon: "i-comment",
  },
  comment_followers: {
    name: "Comment keyword to link for followers",
    blurb: "The link only goes to people who follow you. Everyone else is asked to follow first.",
    tag: "Post or reel comments",
    icon: "i-lock",
  },
  dm_keyword: {
    name: "DM keyword to link",
    blurb: "Someone DMs the keyword and gets the link back right away.",
    tag: "DM keyword",
    icon: "i-send",
  },
  story_reply: {
    name: "Story reply thank you",
    blurb: "Thank people who reply to your story and ask what they are after.",
    tag: "Story reply",
    icon: "i-story",
  },
  welcome: {
    name: "Welcome message",
    blurb: "Their first DM ever and no keyword matched: say hi and tell them what you can help with.",
    tag: "Welcome message",
    icon: "i-hand",
  },
  story_mention: {
    name: "Story mention reply",
    blurb: "Thank people who mention you in their story.",
    tag: "Story mention",
    icon: "i-at",
  },
  blank: {
    name: "Start from blank",
    blurb: "Only the trigger, nothing else. Fill in the rest in the editor.",
    tag: "Any trigger",
    icon: "i-plus",
  },
};

const BASE: DmAutomationConfig = {
  trigger: "comment",
  keywords: [],
  matchMode: "contains",
  excludeKeywords: [],
  scope: "all",
  postIds: [],
  steps: [{ type: "message", text: "", button: null }],
  publicReplyOn: false,
  publicReplies: [],
  oncePerContact: true,
  followersOnly: false,
  trackLinks: true,
  alsoDmKeyword: false,
};

/** A new automation's working copy. */
export function templateConfig(t: DmTemplate): DmAutomationConfig {
  switch (t) {
    case "comment_link":
      return { ...BASE, publicReplyOn: true, publicReplies: [...DEFAULT_PUBLIC] };
    case "comment_followers":
      return { ...BASE, publicReplyOn: true, publicReplies: [...DEFAULT_PUBLIC], followersOnly: true };
    case "dm_keyword":
      return { ...BASE, trigger: "dm_keyword" };
    case "story_reply":
      return { ...BASE, trigger: "story_reply", matchMode: "any", steps: [{ type: "message", text: "Thanks for the reply! What are you after?", button: null }] };
    case "welcome":
      return { ...BASE, trigger: "welcome", matchMode: "any", steps: [{ type: "message", text: "Hi {first_name}, thanks for the message! How can we help?", button: null }] };
    case "story_mention":
      return { ...BASE, trigger: "story_mention", matchMode: "any", steps: [{ type: "message", text: "Thanks for the mention, {first_name}!", button: null }] };
    case "blank":
      return { ...BASE };
  }
}

/** The fields of a config out of anything shaped like one (a DB row, a JSON snapshot). Unknown values fall back to the base. */
export function configOf(row: Partial<Record<keyof DmAutomationConfig, unknown>>): DmAutomationConfig {
  const parsed = dmAutomationConfigSchema.safeParse({ ...BASE, ...Object.fromEntries(Object.entries(row).filter(([k, v]) => DM_CONFIG_KEYS.includes(k as keyof DmAutomationConfig) && v !== undefined && v !== null)) });
  return parsed.success ? parsed.data : { ...BASE };
}

/** What stops a working copy going live, in plain words. Empty means it can publish. */
export function publishProblems(c: DmAutomationConfig): string[] {
  const out: string[] = [];
  const needsKeywords = c.trigger === "comment" || c.trigger === "dm_keyword";
  if (needsKeywords && c.matchMode !== "any" && !c.keywords.length) out.push("Add at least one keyword, or pick Any.");
  if (c.trigger === "dm_keyword" && c.matchMode === "any") out.push("A DM keyword automation needs a keyword: Any would answer every DM.");
  const step = c.steps[0];
  if (!step || !step.text.trim()) out.push("Write the DM.");
  if (c.trigger === "comment" && c.scope === "posts" && !c.postIds.length) out.push("Pick the post or reel, or choose Any post.");
  if (c.trigger === "comment" && c.publicReplyOn && !c.publicReplies.length) out.push("Add a public reply, or turn public replies off.");
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Lower case, letters and digits only, padded, so " guide " finds a whole word. */
const words = (s: string) => ` ${s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The keyword that matched, "" for Any, or null. */
export function keywordHit(c: Pick<DmAutomationConfig, "keywords" | "matchMode" | "excludeKeywords">, text: string | null | undefined): string | null {
  const t = text ?? "";
  if (c.excludeKeywords.some((x) => words(t).includes(words(x)))) return null;
  if (c.matchMode === "any") return "";
  for (const k of c.keywords) {
    if (!k.trim()) continue;
    if (c.matchMode === "contains" && t.toLowerCase().includes(k.toLowerCase())) return k;
    if (c.matchMode === "word" && words(t).includes(words(k)) && words(k).trim()) return k;
    if (c.matchMode === "exact" && words(t).trim() === words(k).trim()) return k;
  }
  return null;
}

/** Something that happened on an account an automation could answer. */
export type DmTriggerEvent =
  | { kind: "comment"; text: string; mediaId: string | null; at: Date }
  | {
      kind: "message";
      text: string | null;
      storyReply: boolean;
      storyMention: boolean;
      /** The first message this person ever sent the account. */
      firstMessage: boolean;
      at: Date;
    };

export type MatchResult = { ok: true; keyword: string; via: DmTrigger } | { ok: false; reason: string };

/** Whether one automation answers one event, and why not when it does not. */
export function matchEvent(c: DmAutomationConfig, ev: DmTriggerEvent): MatchResult {
  if (ev.kind === "comment") {
    if (c.trigger !== "comment") return { ok: false, reason: "not a comment automation" };
    if (c.scope === "posts" && (!ev.mediaId || !c.postIds.includes(ev.mediaId))) return { ok: false, reason: "a comment on another post" };
    if (c.scope === "next" && (!ev.mediaId || c.postIds[0] !== ev.mediaId)) return { ok: false, reason: "not the post it locked onto" };
    const k = keywordHit(c, ev.text);
    return k === null ? { ok: false, reason: "no keyword" } : { ok: true, keyword: k, via: "comment" };
  }
  if (ev.storyMention) return c.trigger === "story_mention" ? { ok: true, keyword: "", via: "story_mention" } : { ok: false, reason: "a story mention" };
  if (ev.storyReply) {
    if (c.trigger !== "story_reply") return { ok: false, reason: "a story reply" };
    const k = !c.keywords.length ? "" : keywordHit(c, ev.text);
    return k === null ? { ok: false, reason: "no keyword" } : { ok: true, keyword: k, via: "story_reply" };
  }
  if (c.trigger === "dm_keyword" || (c.trigger === "comment" && c.alsoDmKeyword)) {
    if (c.matchMode === "any" && c.trigger === "comment") return { ok: false, reason: "Any only answers comments" };
    const k = keywordHit(c, ev.text);
    return k === null || k === "" ? { ok: false, reason: "no keyword" } : { ok: true, keyword: k, via: "dm_keyword" };
  }
  if (c.trigger === "welcome") return ev.firstMessage ? { ok: true, keyword: "", via: "welcome" } : { ok: false, reason: "not their first message" };
  return { ok: false, reason: "a DM" };
}

/**
 * The one automation that answers an event, or null. One event, one reply:
 * story mentions and replies first, then keywords, and the welcome only when
 * nothing else matched (fewchat's order). Post-specific comment automations
 * beat account-wide ones; oldest first within each.
 */
export function pickAutomation<T extends { config: DmAutomationConfig; createdAt: Date }>(
  list: T[],
  ev: DmTriggerEvent,
): { automation: T; keyword: string; via: DmTrigger } | null {
  const rank = (a: T) => {
    const c = a.config;
    if (ev.kind === "comment") return c.scope === "all" ? 1 : 0;
    if (c.trigger === "welcome") return 3;
    if (c.trigger === "dm_keyword" || c.trigger === "comment") return 2;
    return 1;
  };
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
  for (const a of sorted) {
    const m = matchEvent(a.config, ev);
    if (m.ok) return { automation: a, keyword: m.keyword, via: m.via };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sending rules
// ---------------------------------------------------------------------------

/**
 * Whether Meta still takes an automated reply to this event. A comment's
 * private reply works for 7 days; anything answering a DM, story reply or
 * mention needs the standard 24h window. Automations never use HUMAN_AGENT:
 * that tag is for a person answering, not a bot.
 */
export function canStillSend(ev: { kind: "comment" | "message"; at: Date }, now = new Date()): boolean {
  const age = now.getTime() - ev.at.getTime();
  return age <= (ev.kind === "comment" ? PRIVATE_REPLY_MS : DM_WINDOW_MS);
}

/** {first_name} and {username} in a message, for one person. */
export function fillText(text: string, who: { name?: string | null; username?: string | null }): string {
  const first = (who.name ?? "").trim().split(/\s+/)[0] || (who.username ?? "").replace(/^@/, "") || "there";
  const handle = who.username ? `@${who.username.replace(/^@/, "")}` : "";
  return text.replace(/\{first_name\}/g, first).replace(/\{username\}/g, handle).replace(/\s{2,}/g, " ").trim();
}

/** One of the public reply variants, so they do not all read the same. */
export function pickVariant(list: string[], rand = Math.random()): string | null {
  const opts = list.map((l) => l.trim()).filter(Boolean);
  return opts.length ? opts[Math.min(opts.length - 1, Math.floor(rand * opts.length))]! : null;
}

/** Instagram and network hiccups worth another try; anything else fails for good (fewchat's list). */
export const RETRYABLE_SEND = /rate|limit|too many|temporar|try again|timeout|timed out|network|fetch failed|\(5\d\d\)|code (1|2|4|17|32|613|80002)\b|2534040/i;

// ---------------------------------------------------------------------------
// Views (the API's shapes, the screen's types)
// ---------------------------------------------------------------------------

export interface DmAutomationStats {
  runs: number;
  sent: number;
  failed: number;
  clicks: number;
  /** clicks / sent with a tracked link, 0..1, null when nothing could be clicked. */
  ctr: number | null;
}

export interface DmAutomationView {
  id: string;
  source: "native";
  name: string;
  status: DmAutomationStatus;
  folder: string | null;
  socialAccountId: string;
  accountHandle: string;
  platform: "instagram" | "facebook";
  config: DmAutomationConfig;
  /** Saved edits people do not get yet. */
  hasUnpublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
  lastRunAt: string | null;
  deletedAt: string | null;
  stats: DmAutomationStats;
  /** Runs per day, the last 8 days, oldest first. */
  spark: number[];
  /** Why a live automation is not answering anyone right now, or null. */
  waiting: string | null;
  testCode: string | null;
  testCodeExpiresAt: string | null;
  lastTestAt: string | null;
}

/** A Zernio comment-to-DM campaign, in the Automations list beside the native ones. */
export interface DmCampaignRow {
  id: string;
  source: "zernio";
  name: string;
  platform: "instagram" | "facebook";
  trigger: "comment" | "story_reply";
  socialAccountId: string | null;
  accountHandle: string | null;
  isActive: boolean;
  keywords: string[];
  matchMode: "exact" | "contains" | "word";
  postId: string | null;
  postTitle: string | null;
  dmMessage: string;
  stats: { runs: number; sent: number; failed: number; clicks: number; ctr: number | null };
  /** Instagram connected natively, so Move to native can run. */
  canMove: boolean;
}

export interface DmAutomationOverlap {
  automationId: string;
  campaignId: string;
  campaignName: string;
  /** The keywords both answer; empty when one of them answers every comment. */
  keywords: string[];
}

export interface DmRunView {
  id: string;
  automationId: string | null;
  automationName: string | null;
  trigger: string;
  username: string | null;
  text: string | null;
  status: string;
  reason: string | null;
  test: boolean;
  createdAt: string;
  sentAt: string | null;
}

/**
 * Whether a native automation and a Zernio campaign would both answer the
 * same comment: same account, overlapping posts and a keyword in common (or
 * one of them answering everything). Shown as a warning, never acted on alone.
 */
export function overlapKeywords(
  a: { socialAccountId: string; config: DmAutomationConfig },
  z: { socialAccountId: string | null; keywords: string[]; postId: string | null },
): string[] | null {
  if (!z.socialAccountId || a.socialAccountId !== z.socialAccountId) return null;
  const c = a.config;
  if (c.trigger !== "comment") return null;
  const posts = c.scope === "all" ? null : c.postIds;
  if (posts && (!posts.length || (z.postId && !posts.includes(z.postId)))) return null;
  if (c.matchMode === "any") return [];
  const theirs = new Set(z.keywords.map((k) => k.trim().toLowerCase()));
  const both = c.keywords.filter((k) => theirs.has(k.trim().toLowerCase()));
  return both.length ? both : null;
}
