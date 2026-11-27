/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Automations (F4): what a row says, filters, folder groups and the Zernio
 * group, step summaries, the sparkline, keyword entry, the editor's address,
 * and the wiring: the old DM campaigns card is gone, Workflows mounts the new
 * screen, the post picker only asks for Instagram posts, the phone rules fit
 * 360px with 16px inputs, and the reduced motion fallback exists.
 */
declare const process: { cwd(): string };
// @ts-expect-error node's fs is not in this package's browser tsconfig on
// purpose (see motion.check.ts). This file runs under tsx, never in the bundle.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { templateConfig, type DmAutomationView, type DmCampaignRow } from "@toreroflow/core";
import {
  addKeywords,
  dmSummary,
  groupRows,
  matchesFilters,
  NO_FILTERS,
  optionsSummary,
  phoneMeta,
  publicSummary,
  rowState,
  sortRows,
  spark,
  triggerLine,
  whenSummary,
} from "./automations";
import { automationPath, canonicalUrl, parseUrl } from "./routes";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const cfg = { ...templateConfig("comment_link"), keywords: ["GUIDE", "FREE"], steps: [{ type: "message" as const, text: "Here is the free starter guide. Tap below and it opens right away.", button: { title: "Open the guide", url: "https://x.example/g" } }] };
const native = (o: Partial<DmAutomationView>): DmAutomationView => ({
  id: "a1",
  source: "native",
  name: "Free guide by comment",
  status: "live",
  folder: "Lead magnets",
  socialAccountId: "sa1",
  accountHandle: "sample.handle",
  platform: "instagram",
  config: cfg,
  hasUnpublished: false,
  publishedAt: null,
  updatedAt: "2026-11-27T10:00:00.000Z",
  lastRunAt: null,
  deletedAt: null,
  stats: { runs: 1284, sent: 1200, failed: 3, clicks: 494, ctr: 0.412 },
  spark: [2, 3, 2, 5, 4, 7, 6, 9],
  waiting: null,
  testCode: null,
  testCodeExpiresAt: null,
  lastTestAt: null,
  ...o,
});
const zernio: DmCampaignRow = {
  id: "z1",
  source: "zernio",
  name: "Messenger hours reply",
  platform: "facebook",
  trigger: "comment",
  socialAccountId: "sa-fb",
  accountHandle: "Sample Client",
  isActive: false,
  keywords: ["HOURS", "OPEN"],
  matchMode: "contains",
  postId: null,
  postTitle: null,
  dmMessage: "We are open 9 to 5",
  stats: { runs: 57, sent: 57, failed: 0, clicks: 0, ctr: null },
  canMove: false,
};

// ---- states and filters ----
eq(rowState(native({})), "live", "live");
eq(rowState(native({ status: "draft" })), "draft", "draft");
eq(rowState(native({ status: "paused" })), "off", "paused shows as Off");
eq(rowState(zernio), "off", "an inactive Zernio campaign is Off");
const rows = [native({}), native({ id: "a2", name: "Spring promo", status: "draft", folder: null, config: { ...cfg, keywords: ["SPRING"] }, stats: { runs: 0, sent: 0, failed: 0, clicks: 0, ctr: null } }), zernio];
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, tab: "live" })).map((r) => r.id), ["a1"], "Live tab");
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, search: "spring" })).map((r) => r.id), ["a2"], "search by name");
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, search: "hours" })).map((r) => r.id), ["z1"], "search by keyword");
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, folder: "Lead magnets" })).map((r) => r.id), ["a1"], "folder");
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, accountId: "sa-fb" })).map((r) => r.id), ["z1"], "account");
eq(rows.filter((r) => matchesFilters(r, { ...NO_FILTERS, triggers: ["welcome"] })).length, 0, "trigger filter");
eq(sortRows(rows, "runs").map((r) => r.id), ["a1", "z1", "a2"], "most runs first");
eq(sortRows(rows, "name").map((r) => r.id), ["a1", "z1", "a2"], "by name");

// ---- groups: folders A to Z, No folder, then Still at Zernio ----
eq(groupRows(rows).map((g) => g.label), ["Lead magnets", "No folder", "Still at Zernio"], "groups");
eq(groupRows(rows).at(-1)!.zernio, true, "the Zernio group is marked");

// ---- what a row says (round 2 mockup copy) ----
eq(triggerLine(native({})), { lead: "Comment on any post contains", keywords: ["GUIDE", "FREE"], tail: "" }, "comment row");
eq(triggerLine(native({ config: { ...cfg, scope: "posts", postIds: ["17900000000000001"], followersOnly: true, keywords: ["PRICE"] } })), { lead: "Comment on one post contains", keywords: ["PRICE"], tail: ", followers only" }, "followers only, one post");
eq(triggerLine(native({ config: { ...cfg, trigger: "dm_keyword", keywords: ["BOOK", "BOOKING"] } })).lead, "DM contains", "DM keyword row");
eq(triggerLine(native({ config: { ...cfg, trigger: "story_reply", keywords: [], matchMode: "any" } })).lead, "Someone replies to your story", "story reply row");
eq(triggerLine(native({ config: { ...cfg, trigger: "welcome", matchMode: "any" } })).lead, "Someone DMs you for the very first time", "welcome row");
eq(triggerLine(zernio).lead, "Facebook comment contains", "Zernio Messenger campaign");
eq(phoneMeta(native({}), ""), "1,284 runs", "phone line");
eq(phoneMeta(native({ status: "draft" }), "1 hour ago"), "Draft, edited 1 hour ago", "phone draft line");

// ---- step summaries ----
eq(whenSummary(cfg, "sample.handle"), "Someone comments GUIDE or FREE on any post or reel on @sample.handle", "When this happens");
eq(publicSummary(cfg), 'On. One of 3 replies, picked at random: "Sent! Check your DMs"', "Reply in public");
eq(publicSummary({ ...cfg, publicReplyOn: false }), "Off", "public off");
eq(dmSummary(cfg), '"Here is the free starter guide. Tap below..." with the button Open the guide', "Send the DM");
eq(optionsSummary(cfg), "Followers only: off. Once per person: on. Track link opens: on. Also answer DMs with the keyword: off.", "Options");

// ---- sparkline, keywords ----
const s = spark([2, 3, 2, 5, 4, 7, 6, 9])!;
if (!s.d.startsWith("M2 ") || s.trend !== "up") throw new Error(`sparkline ${JSON.stringify(s)}`);
eq(spark([0, 0, 0, 0, 0, 0, 0, 0]), null, "no runs, no line");
eq(spark([9, 8, 7, 6, 2, 1, 1, 0])!.trend, "down", "falling");
eq(addKeywords(["GUIDE"], "guide, free ,  , FREE"), ["GUIDE", "free"], "trimmed, deduplicated in any case");
eq(addKeywords(Array.from({ length: 20 }, (_, i) => `k${i}`), "x").length, 20, "at most 20");

// ---- the editor's own address ----
eq(automationPath("au_1"), "/create/workflows/automations/au_1", "editor path");
const r = parseUrl("/create/workflows/automations/au_1?client=c_1");
eq([r.screen, r.section, r.item], ["workflows", "automations", "au_1"], "the editor path parses");
eq(canonicalUrl("/create/workflows/automations/au_1?client=c_1"), "/create/workflows/automations/au_1?client=c_1", "and survives normalizing");
eq(parseUrl("/create/workflows/automations").item, null, "the list has no item");

// ---- wiring ----
const root = process.cwd();
const read = (f: string) => readFileSync(`${root}/${f}`, "utf8") as string;
if (existsSync(`${root}/src/components/DmCampaigns.tsx`)) throw new Error("the old DmCampaigns.tsx is still there");
const wf = read("src/screens/WorkflowsScreen.tsx");
if (!wf.includes("<Automations ")) throw new Error("WorkflowsScreen does not mount Automations");
if (/DmCampaigns/.test(wf)) throw new Error("WorkflowsScreen still mounts DmCampaigns");
if (/SOON = new Set<WorkflowArea>\([^)]*automations/.test(wf)) throw new Error("Automations is still a placeholder");
// The post picker asks for this Instagram account's posts, never the YouTube catalogue (the recon bug).
const dir = `${root}/src/components/automations`;
for (const f of readdirSync(dir) as string[]) {
  const src = read(`src/components/automations/${f}`);
  if (/external\/youtube|platformVideoId/.test(src)) throw new Error(`${f} reaches for YouTube videos`);
}
if (!read("src/components/automations/parts.tsx").includes("/dm/automations/posts?accountId=")) throw new Error("the post picker lost its Instagram endpoint");
// Phone: sized to the screen, inputs at 16px, targets at 44px.
const phoneCss = read("src/styles/mobile/automations.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const [, px] of phoneCss.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) if (Number(px) > 360) throw new Error(`a phone rule is ${px}px wide`);
for (const sel of [".au-toolrow .ibx-input input", ".au-kwbox.ph input"]) {
  const rule = phoneCss.match(new RegExp(`${sel.replace(/\./g, "\\.")}\\{([^}]*)\\}`));
  if (!rule || !/font-size:16px/.test(rule[1]!)) throw new Error(`${sel} must be 16px so iOS does not zoom`);
}
if (!/\.au-ar\{[^}]*min-height:68px/.test(phoneCss)) throw new Error("phone rows lost their height");
const css = read("src/components/automations/automations.css");
if (!/prefers-reduced-motion:reduce/.test(css) || !/data-motion="reduced"/.test(css)) throw new Error("automations.css lacks the reduced motion fallback");
if (/#FA614B|var\(--accent\)/.test(css.replace(/\.au-hbtn\.pri\{[^}]*\}|\.au-tpl\[aria-checked="true"\]\{[^}]*\}|\.au-tpl \.ck\{[^}]*\}/g, ""))) {
  throw new Error("coral is only for the one primary button and the picked template (round 2)");
}

console.log("automations: all checks passed");
