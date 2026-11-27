import { DM_STAGE_LABEL, type DmContactView, type DmMessageView, type DmStage, type DmThreadView } from "@toreroflow/core";

/*
 * The Inbox and Contacts (F3): the rules the screens share, kept out of the
 * components so inbox.check.ts can run them without a browser.
 */

/** The four states a conversation shows (mockups 02, 02d), from the API's status and pause. */
export const CONVO_STATES = ["active", "paused", "flagged", "done"] as const;
export type ConvoState = (typeof CONVO_STATES)[number];
export const CONVO_LABEL: Record<ConvoState, string> = { active: "Active", paused: "Paused", flagged: "Flagged", done: "Done" };

/** What one row or the details pane says the conversation is. Done and Flagged win over Paused. */
export function convoState(t: Pick<DmThreadView, "status" | "pausedAt">): ConvoState {
  if (t.status === "done") return "done";
  if (t.status === "waiting") return "flagged";
  return t.pausedAt ? "paused" : "active";
}

/** The status tabs over the list, as list query parameters. */
export const LIST_TABS = [{ id: "all", label: "All" }, ...CONVO_STATES.map((id) => ({ id, label: CONVO_LABEL[id] }))] as const;
export type ListTab = (typeof LIST_TABS)[number]["id"];

export interface InboxFilters {
  tab: ListTab;
  search: string;
  accountId: string | null;
  stage: DmStage | null;
  tag: string | null;
  unread: boolean;
  platform: "instagram" | "facebook" | null;
}
export const NO_FILTERS: InboxFilters = { tab: "all", search: "", accountId: null, stage: null, tag: null, unread: false, platform: null };

/** GET /clients/:id/dm/threads query for these filters. */
export function threadQuery(f: InboxFilters, limit?: number): string {
  const q = new URLSearchParams();
  if (f.tab === "active") (q.set("status", "open"), q.set("paused", "0"));
  else if (f.tab === "paused") q.set("paused", "1");
  else if (f.tab === "flagged") q.set("status", "waiting");
  else if (f.tab === "done") q.set("status", "done");
  if (f.search.trim()) q.set("search", f.search.trim());
  if (f.accountId) q.set("accountId", f.accountId);
  if (f.platform) q.set("platform", f.platform);
  if (f.stage) q.set("stage", f.stage);
  if (f.tag) q.set("tag", f.tag);
  if (f.unread) q.set("unread", "1");
  if (limit) q.set("limit", String(limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Picking a conversation state is up to two calls: Active and Paused are the
 * pause switch on an open thread, Flagged and Done are the status.
 */
export function stateChange(from: Pick<DmThreadView, "status" | "pausedAt">, to: ConvoState): { status?: "open" | "waiting" | "done"; pause?: boolean } {
  const out: { status?: "open" | "waiting" | "done"; pause?: boolean } = {};
  const status = to === "flagged" ? "waiting" : to === "done" ? "done" : "open";
  if (status !== from.status) out.status = status;
  if (to === "paused" && !from.pausedAt) out.pause = true;
  if (to === "active" && from.pausedAt) out.pause = false;
  return out;
}

/** The person's name as rows show it. */
export const who = (c: Pick<DmContactView, "displayName" | "handle">): string => c.displayName?.trim() || c.handle?.trim() || "Instagram user";
/** "@handle", or null for Messenger people (no handle). */
export const atHandle = (c: Pick<DmContactView, "handle">): string | null => (c.handle ? `@${c.handle.replace(/^@/, "")}` : null);

/** One of the mockups' eight avatar tones (c1..c8), stable per person. */
export function tone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `c${(h % 8) + 1}`;
}

/** The row's second line: their words, or "You: ..." when the account wrote last. */
export function previewLine(t: Pick<DmThreadView, "lastPreview" | "lastDirection">): string {
  const p = t.lastPreview?.trim() || "No messages yet";
  return t.lastDirection === "out" && t.lastPreview ? `You: ${p}` : p;
}

/**
 * The list once a conversation (or, with no id, every one) is marked read
 * (F7), drawn before the server answers: its dot goes and its messages leave
 * the unread count. The next list read reconciles either way.
 */
export function markedRead<L extends { threads: Array<{ id: string; unread: number }>; counts: { unread: number } }>(list: L, threadId?: string): L {
  const hit = (t: { id: string }) => !threadId || t.id === threadId;
  const cleared = list.threads.reduce((n, t) => n + (hit(t) ? t.unread : 0), 0);
  return {
    ...list,
    threads: list.threads.map((t) => (hit(t) && t.unread ? { ...t, unread: 0 } : t)),
    counts: { ...list.counts, unread: threadId ? Math.max(0, list.counts.unread - cleared) : 0 },
  };
}

/** "now", "4m", "2h", "3d", then "Nov 12". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return shortDate(iso);
}

export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const clock = (d: Date): string => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** "14h 12m", "38m", "under a minute". */
export function span(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "2 days ago", "3 hours ago", "just now", for the closed window line. */
export function agoWords(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/**
 * Whether a reply can go out, for the composer (mockups 02 and 10e).
 * Native threads know Meta's window; Zernio applies it on its side, so those
 * stay open and the send answers if it was too late.
 */
export type ReplyState =
  | { kind: "open"; left: string | null }
  | { kind: "closed"; closedAgo: string | null }
  | { kind: "reconnect" }
  | { kind: "viewer" };
export function replyState(t: Pick<DmThreadView, "source" | "canReply" | "windowEndsAt">, viewer: boolean, now = Date.now()): ReplyState {
  if (viewer) return { kind: "viewer" };
  if (!t.canReply) return { kind: "reconnect" };
  if (t.source !== "native") return { kind: "open", left: null };
  if (!t.windowEndsAt) return { kind: "closed", closedAgo: null };
  const end = new Date(t.windowEndsAt).getTime();
  return end > now ? { kind: "open", left: span(end - now) } : { kind: "closed", closedAgo: agoWords(now - end) };
}

/** The green dot on the avatar: their 24 hour window is open. */
export const windowOpen = (t: Pick<DmThreadView, "windowEndsAt">, now = Date.now()): boolean =>
  !!t.windowEndsAt && new Date(t.windowEndsAt).getTime() > now;

/** "Today, 9:14 AM", "Yesterday, 6:42 PM", "Monday, 4:10 PM", "Nov 12, 4:10 PM". */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  const head =
    diff === 0 ? "Today" : diff === 1 ? "Yesterday" : diff > 1 && diff < 7 ? d.toLocaleDateString("en-US", { weekday: "long" }) : shortDate(iso);
  return `${head}, ${clock(d)}`;
}

/** Bubbles in a run join (4px corners); a gap over an hour starts a new day line. */
export type Item =
  | { kind: "sep"; key: string; label: string }
  | { kind: "msg"; key: string; m: DmMessageView; pos: "single" | "first" | "mid" | "last"; avatar: boolean };
const RUN_MS = 5 * 60_000;
const SEP_MS = 60 * 60_000;
export function threadItems(messages: DmMessageView[], now = Date.now()): Item[] {
  const out: Item[] = [];
  const at = (m: DmMessageView) => (m.sentAt ? new Date(m.sentAt).getTime() : 0);
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (m.sentAt && (!prev || at(m) - at(prev) > SEP_MS || new Date(at(m)).toDateString() !== new Date(at(prev)).toDateString())) {
      out.push({ kind: "sep", key: `sep-${m.id}`, label: dayLabel(m.sentAt, now) });
    }
    const joinsPrev = !!prev && prev.direction === m.direction && at(m) - at(prev) <= RUN_MS && out[out.length - 1]?.kind === "msg";
    const joinsNext =
      !!next && next.direction === m.direction && at(next) - at(m) <= RUN_MS && !(at(next) - at(m) > SEP_MS);
    const pos = joinsPrev && joinsNext ? "mid" : joinsPrev ? "last" : joinsNext ? "first" : "single";
    out.push({ kind: "msg", key: m.id, m, pos, avatar: m.direction === "in" && !joinsNext });
  });
  return out;
}

/** What a part is called when there is nothing to draw (row previews, the actions sheet). */
export const PART_LABEL: Record<string, string> = {
  image: "Photo",
  gif: "GIF",
  sticker: "Sticker",
  video: "Video",
  audio: "Voice message",
  file: "File",
  post: "Shared post",
  reel: "Shared reel",
  share: "Shared link",
  story: "Shared story",
  story_reply: "Replied to your story",
  story_mention: "Mentioned you in their story",
  like: "Heart",
  card: "Card",
  unsupported: "A message Instagram does not show here",
};

/** The one-line summary of a message (Replying to bar, actions sheet). */
export function messageSummary(m: Pick<DmMessageView, "text" | "attachments" | "unsent"> & { transcript?: string | null }): string {
  if (m.unsent) return "Unsent message";
  if (m.text?.trim()) return m.text.trim();
  if (m.transcript?.trim()) return m.transcript.trim();
  const first = m.attachments[0];
  return first ? (PART_LABEL[first.type] ?? "Attachment") : "Message";
}

export const STAGE_OPTIONS = (Object.keys(DM_STAGE_LABEL) as DmStage[]).map((id) => ({ id, label: DM_STAGE_LABEL[id] }));

/** Contacts sort orders (phone filter sheet). */
export const CONTACT_SORTS = [
  { id: "last", label: "Last message" },
  { id: "first", label: "First seen" },
  { id: "name", label: "Name" },
] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number]["id"];

export interface ContactFilters {
  search: string;
  tag: string | null;
  unread: boolean;
  stages: DmStage[];
  platform: "instagram" | "facebook" | null;
  accountId: string | null;
  sort: ContactSort;
}
export const NO_CONTACT_FILTERS: ContactFilters = { search: "", tag: null, unread: false, stages: [], platform: null, accountId: null, sort: "last" };

export function contactQuery(f: ContactFilters, cursor?: string | null): string {
  const q = new URLSearchParams();
  if (f.search.trim()) q.set("search", f.search.trim());
  if (f.tag) q.set("tag", f.tag);
  if (f.unread) q.set("unread", "1");
  if (f.stages.length) q.set("stage", f.stages.join(","));
  if (f.platform) q.set("platform", f.platform);
  if (f.accountId) q.set("accountId", f.accountId);
  if (f.sort !== "last") q.set("sort", f.sort);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** One CSV field, quoted when it has to be, and never read as a formula by a spreadsheet. */
export function csvField(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
