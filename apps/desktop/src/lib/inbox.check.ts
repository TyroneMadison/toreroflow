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
  isPinned,
  keptScrollTop,
  markedRead,
  mergeMessages,
  messageCount,
  prependOlder,
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

// F7: marking read clears at once, before the server answers.
const lst = { threads: [{ id: "a", unread: 2 }, { id: "b", unread: 0 }, { id: "c", unread: 3 }], counts: { all: 3, unread: 9 }, warnings: ["w"] };
const one = markedRead(lst, "a");
eq(one.threads.map((t) => t.unread), [0, 0, 3], "opening one clears only its dot");
eq(one.counts, { all: 3, unread: 7 }, "and takes its messages off the count (the rest may be on later pages)");
eq(one.warnings, ["w"], "the rest of the list is kept");
eq(markedRead(lst, "b").threads[1], lst.threads[1], "an already read row is left as it is");
eq(markedRead({ ...lst, counts: { all: 3, unread: 1 } }, "c").counts.unread, 0, "never below zero");
eq(markedRead(lst, "zz").counts.unread, 9, "a row not in the list changes nothing");
const all = markedRead(lst);
eq(all.threads.map((t) => t.unread), [0, 0, 0], "Mark all as read clears every row");
eq(all.counts.unread, 0, "and the count, rows on later pages included");
eq(lst.threads[0]!.unread, 2, "the old list is not changed in place");

// G1: a fresh newest page merges by id; older pages stay; a quiet poll is the same array.
const at = (i: number) => new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString();
const msg = (i: number, extra: Partial<DmMessageView> = {}) => ({ ...m(`m${i}`, i % 2 ? "in" : "out", at(i)), ...extra });
const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => msg(from + k));
const idsOf = (ms: DmMessageView[]) => ms.map((x) => x.id);
const shown = page(70, 119);
eq(mergeMessages(shown, page(70, 119)) === shown, true, "nothing new: the same array, no redraw");
const grown = mergeMessages(shown, page(71, 120));
eq(idsOf(grown).slice(0, 2), ["m70", "m71"], "a message that slid off the fresh page stays");
eq(idsOf(grown).at(-1), "m120", "the new message is last");
eq(grown.length, 51, "no doubles");
const edited = mergeMessages(shown, [...page(70, 118), msg(119, { text: "edited", edited: true })]);
eq([edited.at(-1)!.text, edited.length], ["edited", 50], "an edit lands in place");
const withOlder = prependOlder(shown, page(20, 70));
eq([withOlder.length, withOlder[0]!.id, withOlder[50]!.id], [100, "m20", "m70"], "older above, the overlap once");
const thenPoll = mergeMessages(withOlder, page(72, 121));
eq([thenPoll[0]!.id, thenPoll.at(-1)!.id, thenPoll.length], ["m20", "m121", 102], "a poll after Load older keeps the older pages");
eq(mergeMessages(shown, []) === shown, true, "an empty answer clears nothing");
eq(idsOf(mergeMessages([], page(0, 2))), ["m0", "m1", "m2"], "first page");
// The count, and the scroll arithmetic the conversation uses.
eq(messageCount({ messages: 1204, messagesExact: true }), "1,204", "the true count");
eq(messageCount({ messages: 500, messagesExact: false }), "500+", "too long to count to the start");
eq(messageCount({ messages: 50 }), "50", "older servers say nothing: exact");
eq(isPinned({ scrollHeight: 4000, scrollTop: 3330, clientHeight: 600 }), true, "70px from the bottom is following");
eq(isPinned({ scrollHeight: 4000, scrollTop: 2000, clientHeight: 600 }), false, "scrolled up is not");
eq(keptScrollTop({ scrollHeight: 4000, scrollTop: 40 }, 6500), 2540, "older messages above: the reader's line stays put");

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
// F7: Mark all as read lives in the Workflows Inbox only, and opening a conversation marks it read.
const inbox = read("src/components/inbox/Inbox.tsx");
for (const want of ['data-testid="dm-mark-all-read"', "Mark all as read", '"read-all"', "/read`", "markedRead(l, threadId)", "void markRead(openShown.id)", 'new Event("toreroflow:dm-read")']) {
  if (!inbox.includes(want)) throw new Error(`Inbox.tsx lacks ${want}`);
}
if (/unread > 0 && !viewer/.test(inbox)) throw new Error("mark read on open must work for viewers too");
// G1: opens at the newest, loads older with the place kept, never yanks a reader who scrolled up.
for (const want of [
  'data-testid="dm-load-older"',
  "Load older messages",
  'data-testid="dm-new-messages"',
  "New messages",
  "mergeMessages(d.messages, r.messages)",
  "prependOlder(d.messages, r.messages)",
  "?before=${encodeURIComponent(cursor)}",
  "keptScrollTop(was, el.scrollHeight)",
  "pinned.current = isPinned(el)",
  "else setNewBelow(true)",
  'addEventListener("focus", back)',
  "messageCount(activity)",
]) {
  if (!inbox.includes(want)) throw new Error(`Inbox.tsx lacks ${want}`);
}
if (/useEffect\(\(\) => \{\s*const el = msgsRef\.current;\s*if \(!el\) return;\s*el\.scrollTop = el\.scrollHeight;/.test(inbox)) {
  throw new Error("the conversation must not jump to the bottom on every new message");
}
if (!/\.ibx-newchip\{[^}]*position:absolute/.test(read("src/components/inbox/inbox.css"))) throw new Error("the New messages chip must float over the list");
if (/\u2014/.test(inbox)) throw new Error("no em dashes in Inbox copy");
if (!read("src/components/Dock.tsx").includes('addEventListener("toreroflow:dm-read"')) throw new Error("the Dock count must follow a mark read");
for (const f of ["src/components/inbox/Contacts.tsx", "src/screens/WorkflowsScreen.tsx", "src/components/Dock.tsx"]) {
  if (/Mark all as read|dm-mark-all-read/.test(read(f))) throw new Error(`${f}: Mark all as read belongs to the Inbox only`);
}
// Every phone sheet and bar in the Inbox is sized to the screen, never a fixed width over 360px.
const phoneCss = read("src/styles/mobile/inbox.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const [, px] of phoneCss.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) if (Number(px) > 360) throw new Error(`a phone rule is ${px}px wide`);
if (!/\.ibx-pbox \.tx\{[^}]*font-size:16px/.test(phoneCss)) throw new Error("the phone composer must be 16px so iOS does not zoom");
// Reduced motion: the desktop sheet and hover transitions stop.
const css = read("src/components/inbox/inbox.css");
if (!/prefers-reduced-motion:reduce/.test(css) || !/data-motion="reduced"/.test(css)) throw new Error("inbox.css lacks the reduced motion fallback");

console.log("inbox: all checks passed");
