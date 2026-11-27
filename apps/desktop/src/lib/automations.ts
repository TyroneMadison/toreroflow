import type {
  DmAutomationConfig,
  DmAutomationOverlap,
  DmAutomationView,
  DmCampaignRow,
  DmRunView,
  DmTrigger,
} from "@toreroflow/core";
import { agoWords } from "./inbox";

/** "2 minutes ago", the mockups' wording for edits and saves. */
export const since = (iso: string, now = Date.now()): string => agoWords(Math.max(0, now - Date.parse(iso)));

/**
 * Automations (F4): the screen's own rules. What a row says, how the list
 * filters and groups, and what each step's one-line summary reads (round 2
 * mockups 01 and 02). Pure, so automations.check.ts can pin them.
 */

export type AutoRow = DmAutomationView | DmCampaignRow;

export interface AutoAccount {
  accountId: string;
  platform: "instagram" | "facebook";
  handle: string;
  transport: "native" | "zernio";
  native: boolean;
  state: string;
  paused: boolean;
}

export interface AutomationsList {
  automations: DmAutomationView[];
  campaigns: DmCampaignRow[];
  overlaps: DmAutomationOverlap[];
  accounts: AutoAccount[];
  nativeConfigured: boolean;
  zernioConfigured: boolean;
  sentLastHour: number;
  budget: number;
  trashCount: number;
  warnings: string[];
}

export interface AutoPost {
  id: string;
  caption: string | null;
  thumbnail: string | null;
  permalink: string | null;
  at: string | null;
  reel: boolean;
}

export type RowState = "live" | "draft" | "off";
export const STATE_TABS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "draft", label: "Drafts" },
  { id: "off", label: "Off" },
] as const;
export type StateTab = (typeof STATE_TABS)[number]["id"];

export function rowState(r: AutoRow): RowState {
  if (r.source === "zernio") return r.isActive ? "live" : "off";
  return r.status === "live" ? "live" : r.status === "draft" ? "draft" : "off";
}

export const TRIGGER_ICON: Record<DmTrigger, string> = {
  comment: "i-comment",
  story_reply: "i-story",
  story_mention: "i-at",
  dm_keyword: "i-send",
  welcome: "i-hand",
};
export const TRIGGER_CHIP: Record<DmTrigger, string> = {
  comment: "Comment",
  story_reply: "Story reply",
  dm_keyword: "DM keyword",
  story_mention: "Story mention",
  welcome: "Welcome",
};

export const rowTrigger = (r: AutoRow): DmTrigger => (r.source === "zernio" ? r.trigger : r.config.trigger);
export const rowKeywords = (r: AutoRow): string[] => (r.source === "zernio" ? r.keywords : r.config.matchMode === "any" ? [] : r.config.keywords);

export interface Filters {
  tab: StateTab;
  search: string;
  triggers: DmTrigger[];
  accountId: string | null;
  folder: string | null;
}
export const NO_FILTERS: Filters = { tab: "all", search: "", triggers: [], accountId: null, folder: null };

export function matchesFilters(r: AutoRow, f: Filters, tabOverride?: StateTab): boolean {
  const tab = tabOverride ?? f.tab;
  if (tab !== "all" && rowState(r) !== tab) return false;
  if (f.triggers.length && !f.triggers.includes(rowTrigger(r))) return false;
  if (f.accountId && r.socialAccountId !== f.accountId) return false;
  if (f.folder && (r.source === "zernio" || r.folder !== f.folder)) return false;
  const s = f.search.trim().toLowerCase();
  if (s && !r.name.toLowerCase().includes(s) && !rowKeywords(r).some((k) => k.toLowerCase().includes(s))) return false;
  return true;
}

export const SORTS = [
  { id: "runs", label: "Most runs" },
  { id: "edited", label: "Recently edited" },
  { id: "name", label: "Name" },
] as const;
export type Sort = (typeof SORTS)[number]["id"];

const runsOf = (r: AutoRow) => r.stats.runs;
export function sortRows(rows: AutoRow[], sort: Sort): AutoRow[] {
  return [...rows].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "edited"
        ? (b.source === "native" ? b.updatedAt : "").localeCompare(a.source === "native" ? a.updatedAt : "")
        : runsOf(b) - runsOf(a),
  );
}

/** Folders first (A to Z), then "No folder", then the campaigns still at Zernio. */
export function groupRows(rows: AutoRow[]): Array<{ key: string; label: string; rows: AutoRow[]; zernio: boolean }> {
  const folders = new Map<string, AutoRow[]>();
  const loose: AutoRow[] = [];
  const zernio: AutoRow[] = [];
  for (const r of rows) {
    if (r.source === "zernio") zernio.push(r);
    else if (r.folder) folders.set(r.folder, [...(folders.get(r.folder) ?? []), r]);
    else loose.push(r);
  }
  const out = [...folders.keys()].sort((a, b) => a.localeCompare(b)).map((k) => ({ key: `f:${k}`, label: k, rows: folders.get(k)!, zernio: false }));
  if (loose.length) out.push({ key: "none", label: "No folder", rows: loose, zernio: false });
  if (zernio.length) out.push({ key: "zernio", label: "Still at Zernio", rows: zernio, zernio: true });
  return out;
}

export const folderNames = (rows: AutoRow[]): string[] =>
  [...new Set(rows.flatMap((r) => (r.source === "native" && r.folder ? [r.folder] : [])))].sort((a, b) => a.localeCompare(b));

/** The trigger line on a row: "Comment on any post contains" + the keywords + what follows. */
export function triggerLine(r: AutoRow): { lead: string; keywords: string[]; tail: string } {
  if (r.source === "zernio") {
    const where = r.platform === "facebook" ? "Facebook comment" : r.trigger === "story_reply" ? "Story reply" : r.postId ? "Comment on one post" : "Comment on any post";
    return { lead: `${where} contains`, keywords: r.keywords, tail: "" };
  }
  const c = r.config;
  const kw = c.matchMode === "any" ? [] : c.keywords;
  const tail = c.followersOnly ? ", followers only" : "";
  switch (c.trigger) {
    case "comment": {
      const where = c.scope === "posts" ? (c.postIds.length > 1 ? `${c.postIds.length} posts` : "one post") : c.scope === "next" ? "your next post" : "any post";
      return c.matchMode === "any" ? { lead: `Any comment on ${where}`, keywords: [], tail } : { lead: `Comment on ${where} contains`, keywords: kw, tail };
    }
    case "dm_keyword":
      return { lead: "DM contains", keywords: kw, tail };
    case "story_reply":
      return kw.length ? { lead: "Story reply contains", keywords: kw, tail } : { lead: "Someone replies to your story", keywords: [], tail };
    case "story_mention":
      return { lead: "Someone mentions you in their story", keywords: [], tail };
    case "welcome":
      return { lead: "Someone DMs you for the very first time", keywords: [], tail };
  }
}

const n0 = (n: number) => n.toLocaleString("en-US");
export const pct = (x: number | null) => (x === null ? null : `${(x * 100).toFixed(1)}%`);

/** The phone row's grey line after the keywords. */
export function phoneMeta(r: AutoRow, edited: string): string {
  const st = rowState(r);
  if (st === "draft") return `Draft, edited ${edited}`;
  const runs = `${n0(r.stats.runs)} runs`;
  const t = rowTrigger(r);
  const lead =
    r.source === "native" && r.config.followersOnly ? "followers only, " : t === "story_reply" && !rowKeywords(r).length ? "Any story reply, " : t === "welcome" ? "First DM ever, " : t === "story_mention" ? "Any story mention, " : "";
  return st === "off" ? `Off, ${runs}` : `${lead}${runs}`;
}

/** 72 x 22 sparkline path and its trend, from the 8 daily counts. */
export function spark(values: number[]): { d: string; trend: "up" | "down" | "flat" } | null {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values, 1);
  const step = 68 / (values.length - 1);
  const pts = values.map((v, i) => `${Math.round((2 + i * step) * 10) / 10} ${Math.round((19 - (v / max) * 15) * 10) / 10}`);
  const half = Math.floor(values.length / 2);
  const a = values.slice(0, half).reduce((s, v) => s + v, 0);
  const b = values.slice(half).reduce((s, v) => s + v, 0);
  const trend = b > a * 1.15 ? "up" : b < a * 0.85 ? "down" : "flat";
  return { d: `M${pts.join(" ")}`, trend };
}

/** Quoted, cut at a word near `max` (mockup: "Here is the free starter guide. Tap below..."). */
const quote = (s: string, max = 38) => {
  if (s.length <= max) return `"${s}"`;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `"${(at > max * 0.6 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[\s,.;:]+$/, "")}..."`;
};
const or = (k: string[]) => (k.length <= 1 ? (k[0] ?? "") : `${k.slice(0, -1).join(", ")} or ${k[k.length - 1]}`);

/** Step 1's summary: "Someone comments GUIDE or FREE on any post or reel on @sample.handle". */
export function whenSummary(c: DmAutomationConfig, handle: string): string {
  const on = handle ? ` on @${handle.replace(/^@/, "")}` : "";
  const kw = c.matchMode === "any" ? "" : or(c.keywords);
  switch (c.trigger) {
    case "comment": {
      const where = c.scope === "posts" ? (c.postIds.length > 1 ? `${c.postIds.length} posts` : "one post or reel") : c.scope === "next" ? "the next post or reel" : "any post or reel";
      if (c.matchMode === "any") return `Someone comments anything on ${where}${on}`;
      return kw ? `Someone comments ${kw} on ${where}${on}` : `Someone comments on ${where}${on}: add a keyword`;
    }
    case "dm_keyword":
      return kw ? `Someone DMs ${kw}${on}` : "Someone DMs a keyword: add one";
    case "story_reply":
      return `Someone replies to your story${kw && c.keywords.length ? ` with ${kw}` : ""}${on}`;
    case "story_mention":
      return `Someone mentions you in their story${on}`;
    case "welcome":
      return `Someone DMs you for the very first time${on}`;
  }
}

export function publicSummary(c: DmAutomationConfig): string {
  if (c.trigger !== "comment") return "Only for comment automations";
  if (!c.publicReplyOn || !c.publicReplies.length) return "Off";
  const n = c.publicReplies.length;
  return n === 1 ? `On: ${quote(c.publicReplies[0]!)}` : `On. One of ${n} replies, picked at random: ${quote(c.publicReplies[0]!)}`;
}

export function dmSummary(c: DmAutomationConfig): string {
  const s = c.steps[0];
  if (!s || !s.text.trim()) return "Not written yet";
  const text = quote(s.text.trim(), 44);
  return s.button ? `${text} with the button ${s.button.title}` : text;
}

const onOff = (b: boolean) => (b ? "on" : "off");
export function optionsSummary(c: DmAutomationConfig): string {
  const parts = [`Once per person: ${onOff(c.oncePerContact)}.`];
  if (c.trigger === "comment") parts.unshift(`Followers only: ${onOff(c.followersOnly)}.`);
  parts.push(`Track link opens: ${onOff(c.trackLinks)}.`);
  if (c.trigger === "comment") parts.push(`Also answer DMs with the keyword: ${onOff(c.alsoDmKeyword)}.`);
  return parts.join(" ");
}

/** The match mode's example line under the segmented control. */
export function matchExample(c: Pick<DmAutomationConfig, "matchMode" | "keywords">): string {
  const k = c.keywords[0] ?? "GUIDE";
  switch (c.matchMode) {
    case "contains":
      return `"can I get the ${k.toLowerCase()} pls" matches ${k}`;
    case "word":
      return `"${k.toLowerCase()}!" matches, "${k.toLowerCase()}s" does not`;
    case "exact":
      return `Only a comment that is just "${k}"`;
    case "any":
      return "Every comment matches. Use with care.";
  }
}

/** A run's pill on Recent comments (round 2 mockup labels). */
export const RUN_PILL: Record<string, { cls: string; label: string }> = {
  sent: { cls: "ok", label: "DM sent" },
  queued: { cls: "info", label: "Queued" },
  ignored: { cls: "", label: "Ignored" },
  failed: { cls: "bad", label: "Failed" },
  expired: { cls: "warn", label: "Expired" },
  repeat: { cls: "paused", label: "Repeat" },
  skipped: { cls: "", label: "Skipped" },
  gated: { cls: "info", label: "Asked to follow" },
  dry_run: { cls: "info", label: "Dry run" },
};

/** The grey line under a recent comment. */
export function runLine(r: DmRunView): string {
  const said = r.text ? `"${r.text.slice(0, 60)}"` : "";
  if (r.status === "sent" || r.status === "dry_run") return said;
  if (r.status === "queued") return `${said} sends when there is room`.trim();
  if (r.status === "ignored") return said ? `${said} had no keyword` : "No keyword";
  return r.reason ?? said;
}

/** Keywords typed into the box: trimmed, deduplicated (any case), at most 20. */
export function addKeywords(have: string[], typed: string): string[] {
  const out = [...have];
  for (const k of typed.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (out.length >= 20) break;
    if (!out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k.slice(0, 60));
  }
  return out;
}

/** What the screen offers to move or warn about, per Zernio campaign. */
export function overlapFor(overlaps: DmAutomationOverlap[], automationId: string): DmAutomationOverlap[] {
  return overlaps.filter((o) => o.automationId === automationId);
}
