/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The Inbox and Contacts (F3): conversation states and the calls that change
 * them, list filters as query strings, the reply window the composer obeys,
 * bubble runs and day lines, CSV safety, and the screen wiring: the old
 * DmInbox is gone, Workflows mounts the new screens, the phone rules stay in
 * the phone query and every sheet fits 360px.
 */
declare const process: { cwd(): string };
// @ts-expect-error node's fs is not in this package's browser tsconfig on
// purpose (see motion.check.ts). This file runs under tsx, never in the bundle.
import { existsSync, readFileSync } from "node:fs";
import type { DmMessageView } from "@toreroflow/core";
import {
  agoWords,
  contactQuery,
  convoState,
  csvField,
  NO_CONTACT_FILTERS,
  NO_FILTERS,
  previewLine,
  replyState,
  span,
  stateChange,
  threadItems,
  threadQuery,
  tone,
  who,
} from "./inbox";

const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};

// Conversation states: Done and Flagged win over Paused.
eq(convoState({ status: "open", pausedAt: null }), "active", "open");
eq(convoState({ status: "open", pausedAt: "2026-11-27T10:00:00Z" }), "paused", "paused");
eq(convoState({ status: "waiting", pausedAt: "2026-11-27T10:00:00Z" }), "flagged", "waiting is Flagged");
eq(convoState({ status: "done", pausedAt: null }), "done", "done");
// ...and what picking one sends.
eq(stateChange({ status: "open", pausedAt: null }, "paused"), { pause: true }, "pause an open thread");
eq(stateChange({ status: "done", pausedAt: "x" }, "active"), { status: "open", pause: false }, "reopen and resume");
eq(stateChange({ status: "open", pausedAt: null }, "flagged"), { status: "waiting" }, "flag");
eq(stateChange({ status: "waiting", pausedAt: null }, "flagged"), {}, "no-op");

// Tabs and filters as the API reads them.
eq(threadQuery(NO_FILTERS), "", "no filters");
eq(threadQuery({ ...NO_FILTERS, tab: "active" }), "?status=open&paused=0", "Active");
eq(threadQuery({ ...NO_FILTERS, tab: "paused" }), "?paused=1", "Paused");
eq(threadQuery({ ...NO_FILTERS, tab: "flagged" }), "?status=waiting", "Flagged");
eq(
  threadQuery({ ...NO_FILTERS, tab: "done", search: " @maya ", accountId: "sa1", platform: "facebook", stage: "qualify", tag: "group of 4", unread: true }, 60),
  "?status=done&search=%40maya&accountId=sa1&platform=facebook&stage=qualify&tag=group+of+4&unread=1&limit=60",
  "everything",
);
eq(contactQuery({ ...NO_CONTACT_FILTERS, stages: ["engaged", "qualify"], sort: "name", unread: true }, "c9"), "?unread=1&stage=engaged%2Cqualify&sort=name&cursor=c9", "contacts");

// The reply window, as the composer shows it.
const now = Date.parse("2026-11-27T12:00:00Z");
eq(replyState({ source: "native", canReply: true, windowEndsAt: "2026-11-28T02:12:00Z" }, false, now), { kind: "open", left: "14h 12m" }, "open with time left");
eq(replyState({ source: "native", canReply: true, windowEndsAt: "2026-11-25T12:00:00Z" }, false, now), { kind: "closed", closedAgo: "2 days ago" }, "closed");
eq(replyState({ source: "native", canReply: true, windowEndsAt: null }, false, now), { kind: "closed", closedAgo: null }, "never messaged");
eq(replyState({ source: "zernio", canReply: true, windowEndsAt: null }, false, now), { kind: "open", left: null }, "Zernio applies it");
eq(replyState({ source: "native", canReply: false, windowEndsAt: "2026-11-28T02:12:00Z" }, false, now), { kind: "reconnect" }, "revoked token");
eq(replyState({ source: "native", canReply: true, windowEndsAt: "2026-11-28T02:12:00Z" }, true, now), { kind: "viewer" }, "viewers never get a composer");
eq(span(38 * 60_000), "38m", "minutes");
eq(span(20_000), "under a minute", "seconds");
eq(agoWords(3 * 3600_000), "3 hours ago", "hours ago");

// Rows.
eq(previewLine({ lastPreview: "Here is the booking link", lastDirection: "out" }), "You: Here is the booking link", "You: prefix");
eq(previewLine({ lastPreview: null, lastDirection: null }), "No messages yet", "empty thread");
eq(who({ displayName: null, handle: "maya.sample" }), "maya.sample", "handle when no name");
eq(tone("abc"), tone("abc"), "stable tone");

// Bubbles: a run joins, a new hour starts a day line, only the last in-bubble shows the avatar.
const m = (id: string, direction: "in" | "out", at: string): DmMessageView => ({
  id, externalId: id, direction, text: id, attachments: [], replyTo: null, reactions: null, unsent: false, edited: false, transcript: null, status: "sent", error: null, sentAt: at,
});
const items = threadItems(
  [m("a", "in", "2026-11-27T09:14:00Z"), m("b", "in", "2026-11-27T09:15:00Z"), m("c", "out", "2026-11-27T09:16:00Z"), m("d", "in", "2026-11-27T11:00:00Z")],
  now,
);
eq(items.map((i) => (i.kind === "sep" ? "|" : `${i.key}:${i.pos}${i.avatar ? "*" : ""}`)), ["|", "a:first", "b:last*", "c:single", "|", "d:single*"], "runs and day lines");

// CSV: quoted when needed, never a formula.
eq(csvField('Maya "R."'), '"Maya ""R."""', "quotes");
eq(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)", "formula injection");
eq(csvField("a,b"), '"a,b"', "comma");

// Wiring: the new screens replace the old inbox.
const root = process.cwd();
const read = (f: string) => readFileSync(`${root}/${f}`, "utf8") as string;
if (existsSync(`${root}/src/components/DmInbox.tsx`)) throw new Error("the old DmInbox.tsx is still there");
const wf = read("src/screens/WorkflowsScreen.tsx");
for (const want of ["<Inbox ", "<Contacts ", 'className="mb-chips wf-areas"']) if (!wf.includes(want)) throw new Error(`WorkflowsScreen lacks ${want}`);
if (/SOON = new Set<WorkflowArea>\([^)]*contacts/.test(wf)) throw new Error("Contacts is still a placeholder");
if (/DmInbox/.test(wf)) throw new Error("WorkflowsScreen still mounts DmInbox");
// Every phone sheet and bar in the Inbox is sized to the screen, never a fixed width over 360px.
const phoneCss = read("src/styles/mobile/inbox.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const [, px] of phoneCss.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) if (Number(px) > 360) throw new Error(`a phone rule is ${px}px wide`);
if (!/\.ibx-pbox \.tx\{[^}]*font-size:16px/.test(phoneCss)) throw new Error("the phone composer must be 16px so iOS does not zoom");
// Reduced motion: the desktop sheet and hover transitions stop.
const css = read("src/components/inbox/inbox.css");
if (!/prefers-reduced-motion:reduce/.test(css) || !/data-motion="reduced"/.test(css)) throw new Error("inbox.css lacks the reduced motion fallback");

console.log("inbox: all checks passed");
