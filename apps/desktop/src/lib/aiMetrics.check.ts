/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Workflows > AI replies, Metrics and Auto-post (F5): the copy the screens
 * show against the round 2 mockups (03, 05, 06), the status band never saying
 * "on" for an account nobody turned on, the chart geometry, the CSV, the
 * wiring (no "coming soon" left, the old Drive card gone), and the phone rules
 * (360px, 16px inputs, coral only for the one primary button).
 */
declare const process: { cwd(): string };
// @ts-expect-error node's fs is not in this package's browser tsconfig on purpose (see motion.check.ts).
import { existsSync, readFileSync } from "node:fs";
import { dmAiSettingsOf, type DmAiAccountView, type DmAiOverview, type DmAiQueueRow, type DmMetricsView } from "@toreroflow/core";
import {
  aiBand,
  chartGeo,
  delayChip,
  delayPreset,
  delaySummary,
  driveBand,
  durText,
  fmtPct,
  handoffSummary,
  kpiText,
  knowsSummary,
  metricsCsv,
  needsLook,
  neverSummary,
  niceMax,
  queueNote,
  resumeLabel,
  VIDEO_PILL,
  waitText,
} from "./aiMetrics";

const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};

// ---- AI replies copy (mockup 03) ----
const s = dmAiSettingsOf(null);
eq(delaySummary(s), "Waits 20 to 90 seconds and shows typing", "the default timing row");
eq(delaySummary(s, true), "Waits 20 to 90 seconds", "phone row");
eq(delaySummary({ ...s, replyDelayMinSec: 120, replyDelayMaxSec: 300 }), "Waits 2 to 5 minutes and shows typing", "the long wait");
eq(delaySummary({ ...s, replyDelayMinSec: 0, replyDelayMaxSec: 0, typing: false }), "Replies at once", "at once");
eq(delayPreset(s), "short", "20 to 90 s is the middle choice");
eq(delayChip({ replyDelayMinSec: 120, replyDelayMaxSec: 300 }), "2 to 5 min", "chip");
eq(resumeLabel(12), "After 12 hours with no reply from you", "resume");
eq(resumeLabel(0), "Not on its own: you turn it back on", "never resumes on its own");
const knows = { ...s, instructions: "Open 7 to 8", links: [1, 2, 3].map((i) => ({ label: `L${i}`, url: `https://x.test/${i}` })), lessons: [1, 2, 3].map((i) => ({ id: `l${i}`, text: "t", from: "team", at: "" })) };
eq(knowsSummary(knows), "Instructions, 3 links, 3 lessons from handoffs", "What the AI knows");
eq(knowsSummary(knows, true), "Instructions, 3 links, 3 lessons", "phone");
eq(knowsSummary(s), "Nothing yet: add what it should know", "empty");
const never = (off: number, friends: number): DmAiOverview["never"] => ({ off, friends, list: [] });
eq(neverSummary(never(3, 6)), "3 people and 6 more tagged friend", "Never auto-reply to");
eq(neverSummary(never(0, 0)), "Nobody yet. Anyone tagged friend is skipped", "nobody");
eq(handoffSummary(s), "Prices and discounts, refunds and money back, complaints and asking for a person", "handoff rules");

const acct = (patch: Partial<DmAiAccountView>, set: Record<string, unknown> = {}): DmAiAccountView => ({
  accountId: "a",
  platform: "instagram",
  handle: "sample.handle",
  transport: "native",
  canAutopilot: true,
  settings: dmAiSettingsOf(set),
  updatedAt: null,
  sentToday: 0,
  ...patch,
});
// The band never says on for accounts nobody turned on.
eq(aiBand([acct({}), acct({ accountId: "b" })], null, "Sample Client").state, "off", "nothing on: off");
eq(aiBand([acct({}, { enabled: true })], null, "Sample Client").pill.label, "Drafts only", "on, drafts only");
const on = aiBand([acct({}, { enabled: true, mode: "autopilot" }), acct({ accountId: "b" }), acct({ accountId: "c", platform: "facebook" })], null, "Sample Client");
eq([on.title, on.pill.label], ["AI replies are on", "Answering"], "mockup band");
if (!on.line.startsWith("On for 1 of 3 accounts.") || !on.line.includes("It never pretends to be a person")) throw new Error(`band line: ${on.line}`);
eq(aiBand([acct({}, { enabled: true, mode: "autopilot" })], "2026-11-27T10:00:00Z", "X").state, "stopped", "kill switch");

const now = Date.parse("2026-11-27T15:00:00Z");
eq(waitText("2026-11-27T14:19:00Z", now), "No answer for 41 min", "desktop wait");
eq(waitText("2026-11-27T14:19:00Z", now, true), "41 min", "phone wait");
const row = (p: Partial<DmAiQueueRow>): DmAiQueueRow => ({
  threadId: "t",
  accountId: "fb",
  platform: "facebook",
  contact: { id: "c", displayName: "Priya S.", handle: null, avatarUrl: null, stage: "new", tags: [], notes: null, optIn: false, lastSeenAt: null },
  why: "waiting",
  reason: "No answer yet",
  since: null,
  preview: "Hi! Are you open on Sundays?",
  paused: false,
  aiOff: false,
  ...p,
});
eq(queueNote(row({}), [acct({ accountId: "fb", platform: "facebook" })]), '"Hi! Are you open on Sundays?" AI is off on Messenger', "mockup Needs you line");
eq(queueNote(row({ why: "handoff", preview: null, reason: "Asked about price" }), []), "Asked about price", "handoff line");

// ---- Metrics ----
eq(fmtPct(0.386), "38.6%", "CTR");
eq(fmtPct(0.64), "64%", "reply rate");
eq(kpiText("received", 1942), "1,942", "count");
eq(kpiText("ctr", null), "n/a", "no sends");
eq(durText(1380), "23 min", "minutes");
eq(durText(5400), "1.5 h", "hours");
eq(durText(null), "n/a", "none");
eq([niceMax(312), niceMax(0), niceMax(7)], [500, 4, 10], "axis ceilings");
const g = chartGeo([1, 2, null, 4], [0, 1, 1, 2], 400, 226, 2, false);
if (!g.a.startsWith("M") || g.a.split("M").length !== 3) throw new Error(`a gap in the series breaks the line: ${g.a}`);
if (!g.b || !g.area.endsWith("Z")) throw new Error("sent line and area");
if (g.grid.length !== 5 || g.max !== 5) throw new Error(`grid ${g.max}`);
const rate = chartGeo([0.5, null, 0.2], undefined, 300, 150, 0, true, true);
eq(rate.max, 1, "rates run to 100%");
eq(rate.grid[4]!.label, "100%", "rate axis");
const view = {
  from: "2026-11-21T00:00:00.000Z",
  to: "2026-11-27T15:00:00.000Z",
  kpis: Object.fromEntries(["received", "people", "contacts", "reach", "replyRate", "ctr"].map((k) => [k, { value: k === "ctr" ? 0.5 : 3, prev: null, delta: null }])),
  chart: { from: "2026-10-29T00:00:00.000Z", days: 2, shadeFrom: 0, series: { received: { a: [1, 2], b: [0, 1] }, people: { a: [1, 1] }, contacts: { a: [0, 1] }, reach: { a: [0, 0] }, replyRate: { a: [null, null] }, ctr: { a: [null, null] } } },
} as unknown as DmMetricsView;
const csv = metricsCsv(view, 'Sample, "Client"');
if (!csv.startsWith('"Metrics for Sample, ""Client"""') || !csv.includes("CTR,50%,n/a") || !csv.includes("2026-10-30,2,1,1,1,0")) throw new Error(`csv:\n${csv}`);

// ---- Auto-post ----
eq([VIDEO_PILL.scheduled!.cls, VIDEO_PILL.held!.cls, VIDEO_PILL.failed!.cls, VIDEO_PILL.downloaded!.label], ["info", "paused", "bad", "Writing caption"], "video pills (mockup 06)");
eq([needsLook("held"), needsLook("failed"), needsLook("scheduled")], [true, true, false], "needs a look");
eq(driveBand({ tone: "ok", text: "Running. Last checked 2 min ago, next check in about 3 min." }), { title: "Drive auto-post is running", pill: { cls: "ok", label: "Running" }, line: "Last checked 2 min ago, next check in about 3 min." }, "band");
eq(driveBand({ tone: "off", text: "Not running." }).pill, { cls: "", label: "Off" }, "off");

// ---- wiring ----
const root = process.cwd();
const read = (f: string) => readFileSync(`${root}/${f}`, "utf8") as string;
if (existsSync(`${root}/src/components/DriveAutoPost.tsx`)) throw new Error("the old Drive card is still there; Auto-post replaced it");
const wf = read("src/screens/WorkflowsScreen.tsx");
for (const c of ["<AiReplies ", "<Metrics ", "<AutoPost ", "<Inbox ", "<Contacts ", "<Automations "]) if (!wf.includes(c)) throw new Error(`WorkflowsScreen does not mount ${c.trim()}`);
if (/SOON|coming soon/i.test(wf)) throw new Error("a coming soon placeholder is left in WorkflowsScreen");
if (!wf.includes("/dm/summary")) throw new Error("the rail counts are not real data");
const ap = read("src/components/ai/AutoPost.tsx");
for (const t of ["Saved, not running yet", "drive-auto-post", "workflow-create", "workflow-delete-", "workflow-dest-", "Stop Drive auto-post", "Copy connect link", "Sync accounts", "Connect another Instagram account", "Check folder"]) {
  if (!ap.includes(t)) throw new Error(`Auto-post lost "${t}" from the old Drive card and rules`);
}
const ai = read("src/components/ai/AiReplies.tsx");
for (const t of ["Never pretends to be a person", "Needs you", "Reply timing", "Never auto-reply to", "What the AI knows", "Try a test message", "Let the AI answer again", "Tag as friend", "Stop all AI sending"]) {
  if (!ai.includes(t)) throw new Error(`AI replies lost "${t}"`);
}
// The page never turns anything on by itself: the only enabled: true it sends is a person's switch.
if (/enabled:\s*true/.test(ai)) throw new Error("AiReplies sends enabled: true outside a person's switch");
const inbox = read("src/components/inbox/Inbox.tsx");
for (const t of ["dm-ai-draft", "dm-ai-send", "dm-ai-ask", "dm-ai-toggle", "draftId"]) if (!inbox.includes(t)) throw new Error(`the Inbox lost the AI draft piece ${t}`);
const met = read("src/components/ai/Metrics.tsx");
for (const t of ["Where people drop off", "What started", "Top automations", "not delivered", "Export CSV", "Compare with the period before"]) if (!met.includes(t)) throw new Error(`Metrics lost "${t}"`);
// No em dashes in anything these screens say.
for (const f of ["src/components/ai/AiReplies.tsx", "src/components/ai/Metrics.tsx", "src/components/ai/AutoPost.tsx", "src/lib/aiMetrics.ts", "src/screens/WorkflowsScreen.tsx"]) {
  if (read(f).includes("\u2014")) throw new Error(`${f} has an em dash`);
}
// Phone: sized to the screen, 16px inputs, and coral only for the one primary button.
const phoneCss = read("src/styles/mobile/areas.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const [, px] of phoneCss.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) if (Number(px) > 360) throw new Error(`a phone rule is ${px}px wide`);
const inputRule = phoneCss.match(/\.au-sheet \.ibx-input\.round input\{([^}]*)\}/);
if (!inputRule || !/font-size:16px/.test(inputRule[1]!)) throw new Error("the phone search input must be 16px so iOS does not zoom");
const css = read("src/components/ai/areas.css");
if (/#FA614B|var\(--accent\)/.test(css + phoneCss)) throw new Error("coral is only for the one primary button (round 2)");
if (!/prefers-reduced-motion:reduce/.test(css)) throw new Error("areas.css lacks the reduced motion fallback");

console.log("aiMetrics: all checks passed");
