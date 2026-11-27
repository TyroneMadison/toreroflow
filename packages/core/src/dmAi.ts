import { z } from "zod";
import { DM_STAGES, DM_STAGE_LABEL, type DmContactView, type DmStage } from "./dm";

/**
 * AI replies (F5): the rules the worker obeys and the screen explains.
 *
 * OFF until a person turns it on. DM_AI_DEFAULTS is what an account without a
 * settings row gets, the Prisma defaults say the same, and dmAi.check.ts fails
 * if any of them ever switches the AI on or to autopilot. Drafts only is the
 * normal mode: a person presses Send. Autopilot sends on its own only when a
 * person picked it for that account, the agency's kill switch is off, the 24h
 * window is open, the thread is not paused or handed off, and no handoff rule
 * matched. Generalised from fewchat's AI setter (MIT, Copyright (c) 2026 Jason
 * Cooperson), which was built to sell one offer; this one answers for a brand.
 */

export const DM_AI_MODES = ["drafts", "autopilot"] as const;
export type DmAiMode = (typeof DM_AI_MODES)[number];

/** Longest wait before an autopilot reply: 5 minutes (the mockup's "2 to 5 min"). */
export const DM_AI_DELAY_CAP_SEC = 300;
/** A chat is "quiet" this long after their last message before the AI writes (fewchat: 45 s). */
export const DM_AI_QUIET_MS = 45_000;
/** No autopilot send this close to the end of the 24h window: it could bounce while it waits. */
export const DM_AI_WINDOW_MARGIN_MS = 10 * 60_000;
/** "Waiting" in Needs you: nobody has answered for this long. */
export const DM_AI_WAITING_MS = 30 * 60_000;
/** Messages of the chat the AI reads, newest last. */
export const DM_AI_HISTORY = 30;
/** Bubbles one reply may have, and Instagram's limit for each. */
export const DM_AI_MAX_BUBBLES = 3;
export const DM_AI_BUBBLE_MAX = 1000;

export const DM_AI_TOPICS = ["price", "refund", "complaint", "person"] as const;
export type DmAiTopic = (typeof DM_AI_TOPICS)[number];
/** Handoff rules: a match hands the chat to the team before the AI writes a word. */
export const DM_AI_TOPIC_INFO: Record<DmAiTopic, { label: string; why: string; re: RegExp }> = {
  price: {
    label: "Prices and discounts",
    why: "Asked about price",
    re: /\b(price|prices|pricing|cost|costs|how much|discount|discounts|deal|cheaper|quote|promo code)\b/i,
  },
  refund: { label: "Refunds and money back", why: "Asked about a refund", re: /\b(refund|refunds|money back|chargeback|charged twice|double charged)\b/i },
  complaint: {
    label: "Complaints",
    why: "Made a complaint",
    re: /\b(complain|complaint|terrible|awful|worst|unacceptable|furious|scam|rip ?off|disappointed|third time)\b/i,
  },
  person: {
    label: "Asking for a person",
    why: "Asked for a person",
    // "Are you a bot?" is not here: the AI answers that itself, honestly.
    re: /\b(real person|someone real|a human|talk to (someone|somebody|a person|the owner)|speak to (someone|somebody|a person|the owner)|manager)\b/i,
  },
};

export interface DmAiLink {
  label: string;
  url: string;
}
export interface DmAiLesson {
  id: string;
  text: string;
  /** "team" (a reply by the team) or "handoff". */
  from: string;
  at: string;
}

export interface DmAiSettings {
  enabled: boolean;
  mode: DmAiMode;
  instructions: string;
  links: DmAiLink[];
  lessons: DmAiLesson[];
  replyDelayMinSec: number;
  replyDelayMaxSec: number;
  typing: boolean;
  pauseOnTeamReply: boolean;
  /** 0: the AI stays paused until someone turns it back on. */
  resumeAfterHours: number;
  quietStartHour: number | null;
  quietEndHour: number | null;
  handoffTopics: DmAiTopic[];
  handoffWords: string[];
  dailyCap: number;
}

/** What an account without a settings row gets. OFF, drafts only. */
export const DM_AI_DEFAULTS: Readonly<DmAiSettings> = Object.freeze({
  enabled: false,
  mode: "drafts",
  instructions: "",
  links: [],
  lessons: [],
  replyDelayMinSec: 20,
  replyDelayMaxSec: 90,
  typing: true,
  pauseOnTeamReply: true,
  resumeAfterHours: 12,
  quietStartHour: null,
  quietEndHour: null,
  handoffTopics: [...DM_AI_TOPICS],
  handoffWords: [],
  dailyCap: 50,
});

/** The three waits the Reply timing sheet offers (mockup 03). */
export const DM_AI_DELAYS = [
  { id: "now", label: "At once", min: 0, max: 0 },
  { id: "short", label: "20 to 90 s", min: 20, max: 90 },
  { id: "long", label: "2 to 5 min", min: 120, max: 300 },
] as const;
export const DM_AI_RESUME = [2, 6, 12, 24, 0] as const;

const hour = z.number().int().min(0).max(23).nullable();
const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), "links must start with https://");

/** PUT /clients/:id/dm/ai/:accountId. Partial: only what changed. */
export const dmAiSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(DM_AI_MODES).optional(),
    instructions: z.string().max(4000).optional(),
    links: z.array(z.object({ label: z.string().trim().min(1).max(40), url: httpsUrl })).max(5).optional(),
    lessons: z
      .array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(300), from: z.string().max(20).default("team"), at: z.string().max(40) }))
      .max(30)
      .optional(),
    replyDelayMinSec: z.number().int().min(0).max(DM_AI_DELAY_CAP_SEC).optional(),
    replyDelayMaxSec: z.number().int().min(0).max(DM_AI_DELAY_CAP_SEC).optional(),
    typing: z.boolean().optional(),
    pauseOnTeamReply: z.boolean().optional(),
    resumeAfterHours: z.number().int().min(0).max(168).optional(),
    quietStartHour: hour.optional(),
    quietEndHour: hour.optional(),
    handoffTopics: z.array(z.enum(DM_AI_TOPICS)).max(DM_AI_TOPICS.length).optional(),
    handoffWords: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    dailyCap: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => b.replyDelayMinSec === undefined || b.replyDelayMaxSec === undefined || b.replyDelayMinSec <= b.replyDelayMaxSec, {
    message: "the shortest wait cannot be longer than the longest",
  });
export type DmAiSettingsPatch = z.infer<typeof dmAiSettingsPatchSchema>;

const arr = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : []);
const isLink = (x: unknown): x is DmAiLink => !!x && typeof (x as DmAiLink).label === "string" && typeof (x as DmAiLink).url === "string";
const isLesson = (x: unknown): x is DmAiLesson => !!x && typeof (x as DmAiLesson).text === "string" && typeof (x as DmAiLesson).id === "string";
const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const hr = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 23 ? Math.round(v) : null);

/**
 * A settings row (or none) as settings. Anything missing or odd reads as the
 * default, and the default is off: a half-written row never turns the AI on.
 */
export function dmAiSettingsOf(row: Record<string, unknown> | null | undefined): DmAiSettings {
  if (!row) return { ...DM_AI_DEFAULTS, links: [], lessons: [], handoffTopics: [...DM_AI_DEFAULTS.handoffTopics], handoffWords: [] };
  const min = int(row.replyDelayMinSec, DM_AI_DEFAULTS.replyDelayMinSec, 0, DM_AI_DELAY_CAP_SEC);
  const max = int(row.replyDelayMaxSec, DM_AI_DEFAULTS.replyDelayMaxSec, 0, DM_AI_DELAY_CAP_SEC);
  return {
    enabled: row.enabled === true,
    mode: row.mode === "autopilot" ? "autopilot" : "drafts",
    instructions: typeof row.instructions === "string" ? row.instructions : "",
    links: arr(row.links, isLink).slice(0, 5),
    lessons: arr(row.lessons, isLesson).slice(0, 30),
    replyDelayMinSec: Math.min(min, max),
    replyDelayMaxSec: Math.max(min, max),
    typing: row.typing !== false,
    pauseOnTeamReply: row.pauseOnTeamReply !== false,
    resumeAfterHours: int(row.resumeAfterHours, DM_AI_DEFAULTS.resumeAfterHours, 0, 168),
    quietStartHour: hr(row.quietStartHour),
    quietEndHour: hr(row.quietEndHour),
    // Missing reads as every topic: a half-written row hands off more, never less.
    handoffTopics: Array.isArray(row.handoffTopics)
      ? arr(row.handoffTopics, (t): t is DmAiTopic => (DM_AI_TOPICS as readonly unknown[]).includes(t))
      : [...DM_AI_DEFAULTS.handoffTopics],
    handoffWords: arr(row.handoffWords, (w): w is string => typeof w === "string" && !!w.trim()),
    dailyCap: int(row.dailyCap, DM_AI_DEFAULTS.dailyCap, 1, 500),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A handoff rule this message matches, before any model is asked. Own words first. */
export function dmAiHandoffMatch(text: string | null | undefined, s: Pick<DmAiSettings, "handoffTopics" | "handoffWords">): { topic: string; why: string } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const w of s.handoffWords) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(t)) return { topic: "word", why: `Said "${w.trim()}"` };
  }
  for (const k of s.handoffTopics) if (DM_AI_TOPIC_INFO[k].re.test(t)) return { topic: k, why: DM_AI_TOPIC_INFO[k].why };
  return null;
}

/** The hour (0 to 23) in a timezone; the server's own when the name is unknown. */
export function hourIn(now: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now)) % 24;
  } catch {
    return now.getHours();
  }
}

/** Inside quiet hours. 22 to 7 wraps past midnight; equal or empty hours mean none. */
export function inQuietHours(now: Date, start: number | null, end: number | null, timeZone: string): boolean {
  if (start === null || end === null || start === end) return false;
  const h = hourIn(now, timeZone);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** A random wait between the two, in ms. */
export const dmAiDelayMs = (s: Pick<DmAiSettings, "replyDelayMinSec" | "replyDelayMaxSec">, rand: () => number = Math.random): number =>
  Math.round((s.replyDelayMinSec + rand() * Math.max(0, s.replyDelayMaxSec - s.replyDelayMinSec)) * 1000);

/** What the worker knows about a chat when it decides. */
export interface DmAiContext {
  now: Date;
  settings: DmAiSettings;
  /** The agency's kill switch for AI sending. */
  killed: boolean;
  platform: "instagram" | "facebook";
  /** Instagram through our own Meta app, with a working token. */
  native: boolean;
  thread: {
    status: string;
    pausedAt: Date | null;
    aiOff: boolean;
    aiHandoffAt: Date | null;
    aiPausedUntil: Date | null;
    lastDirection: string | null;
    lastInboundAt: Date | null;
    windowEndsAt: Date | null;
  };
  /** The contact is tagged friend: the AI never answers friends. */
  friend: boolean;
  /** An automation already answered (or is answering) their newest message. */
  automationAnswered: boolean;
  /** AI replies sent on this account in the last 24 hours. */
  sentToday: number;
  /** Quiet hours count in the business's own timezone (BUSINESS_TIMEZONE). */
  timezone: string;
}

/**
 * Why the AI must not write on its own for this chat now, or null when it may.
 * Only native Instagram chats are drafted unprompted: Messenger is reply only
 * through Zernio, so its drafts come only when a person asks.
 */
export function dmAiNoDraft(c: DmAiContext): string | null {
  const t = c.thread;
  if (!c.settings.enabled) return "AI replies are off for this account";
  if (c.platform !== "instagram" || !c.native) return "Only Instagram connected through Torerone's Meta app is answered on its own";
  if (t.status === "done") return "Marked done";
  if (t.pausedAt) return "Auto replies are paused in this chat";
  if (t.aiOff) return "AI replies are off in this chat";
  if (t.aiHandoffAt) return "Handed to the team";
  if (t.aiPausedUntil && t.aiPausedUntil > c.now) return "Paused after a reply by the team";
  if (c.friend) return "Tagged friend: the AI never replies to friends";
  if (t.lastDirection !== "in" || !t.lastInboundAt) return "They have not written since the last reply";
  if (c.now.getTime() - t.lastInboundAt.getTime() < DM_AI_QUIET_MS) return "Waiting for them to finish typing";
  if (!t.windowEndsAt || t.windowEndsAt <= c.now) return "The 24 hour reply window closed";
  if (c.automationAnswered) return "An automation answered this message";
  return null;
}

/**
 * Whether an autopilot reply may go out now. "draft" keeps it for a person
 * (the reply is still good, sending it on its own is not allowed right now);
 * "skip" drops it (the chat moved on, or the AI must stay out).
 */
export function dmAiNoSend(c: DmAiContext): { keep: "draft" | "skip"; reason: string } | null {
  const t = c.thread;
  if (!c.settings.enabled) return { keep: "skip", reason: "AI replies were turned off" };
  if (c.platform !== "instagram" || !c.native) return { keep: "draft", reason: "Sent only by a person on this account" };
  if (t.pausedAt) return { keep: "skip", reason: "Auto replies are paused in this chat" };
  if (t.aiOff) return { keep: "skip", reason: "AI replies are off in this chat" };
  if (t.aiHandoffAt) return { keep: "skip", reason: "Handed to the team" };
  if (t.aiPausedUntil && t.aiPausedUntil > c.now) return { keep: "skip", reason: "The team replied" };
  if (c.friend) return { keep: "skip", reason: "Tagged friend" };
  if (t.status === "done") return { keep: "skip", reason: "Marked done" };
  if (t.lastDirection !== "in") return { keep: "skip", reason: "Someone already replied" };
  if (!t.windowEndsAt || t.windowEndsAt.getTime() - DM_AI_WINDOW_MARGIN_MS <= c.now.getTime()) return { keep: "skip", reason: "The 24 hour reply window is closing" };
  if (c.killed) return { keep: "draft", reason: "AI sending is stopped for every account" };
  if (c.settings.mode !== "autopilot") return { keep: "draft", reason: "Drafts only: a person sends it" };
  if (inQuietHours(c.now, c.settings.quietStartHour, c.settings.quietEndHour, c.timezone)) return { keep: "draft", reason: "Quiet hours: left as a draft" };
  if (c.sentToday >= c.settings.dailyCap) return { keep: "draft", reason: "Daily cap reached: left as a draft" };
  return null;
}

/** The model's answer, as JSON (output_config json_schema). */
export const DM_AI_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "bubbles", "stage", "note", "reason"],
  properties: {
    action: { type: "string", enum: ["reply", "handoff", "stop"] },
    bubbles: { type: "array", items: { type: "string" } },
    stage: { type: "string", enum: [...DM_STAGES] },
    note: { type: "string" },
    reason: { type: "string" },
  },
} as const;

export interface DmAiDecision {
  action: "reply" | "handoff" | "stop";
  bubbles: string[];
  stage: DmStage;
  note: string;
  reason: string;
}

const decisionShape = z.object({
  action: z.enum(["reply", "handoff", "stop"]),
  bubbles: z.array(z.string()).default([]),
  stage: z.enum(DM_STAGES).catch("engaged"),
  note: z.string().default(""),
  reason: z.string().default(""),
});

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

/**
 * The model's JSON as a decision a person (or autopilot) can trust: at most
 * three bubbles, no em dashes, and no link that is not one of the account's
 * own. A reply that ends up empty becomes a handoff, never a blank message.
 */
export function readDmAiDecision(text: string, s: Pick<DmAiSettings, "links">): DmAiDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { action: "handoff", bubbles: [], stage: "engaged", note: "", reason: "The AI's answer could not be read" };
  }
  const d = decisionShape.safeParse(raw);
  if (!d.success) return { action: "handoff", bubbles: [], stage: "engaged", note: "", reason: "The AI's answer could not be read" };
  const allowed = new Set(s.links.map((l) => l.url.trim().replace(/\/+$/, "").toLowerCase()));
  const bubbles = d.data.bubbles
    .map((b) =>
      b
        .replace(/\u2014/g, ", ")
        .replace(/–/g, "-")
        .replace(URL_RE, (u) => (allowed.has(u.replace(/[.,!?]+$/, "").replace(/\/+$/, "").toLowerCase()) ? u : ""))
        .replace(/\s+,/g, ",")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
        .slice(0, DM_AI_BUBBLE_MAX),
    )
    .filter(Boolean)
    .slice(0, DM_AI_MAX_BUBBLES);
  const clean = (x: string) => x.replace(/\u2014/g, ", ").trim().slice(0, 300);
  if (d.data.action === "reply" && !bubbles.length) {
    return { action: "handoff", bubbles: [], stage: d.data.stage, note: clean(d.data.note), reason: "The AI wrote nothing it could send" };
  }
  return {
    action: d.data.action,
    bubbles: d.data.action === "reply" ? bubbles : [],
    stage: d.data.stage,
    note: clean(d.data.note),
    reason: clean(d.data.reason) || (d.data.action === "handoff" ? "Not sure of the answer" : ""),
  };
}

/** The instructions every reply is written under. */
export function dmAiSystemPrompt(brand: string, handle: string, s: DmAiSettings, channel: "Instagram" | "Messenger"): string {
  const topics = s.handoffTopics.map((t) => DM_AI_TOPIC_INFO[t].label.toLowerCase());
  const lines = [
    `You answer ${channel} direct messages for ${brand}${handle ? ` (@${handle.replace(/^@/, "")})` : ""}. You are an AI assistant for ${brand}.`,
    `If anyone asks whether they are talking to a person, a bot or an AI, say plainly that you are an assistant for ${brand}. Never claim or suggest you are a person, never invent a name, age, location or personal story.`,
    "Write like a friendly, brief human team member would type in DMs: 1 to 3 short messages (bubbles), each under 300 characters. Plain text only: no markdown, no hashtags, no em dashes.",
    "Only state facts that are in the business notes below. Never promise prices, discounts, refunds, bookings, availability or anything else they do not say. If you are not sure of the answer, choose action \"handoff\" with no bubbles and a short reason.",
    `Always choose "handoff" for ${topics.length ? `${topics.join(", ")}, ` : ""}anything about health, legal or safety, and anyone upset.`,
    s.links.length
      ? `You may send these links, exactly as written, when they help: ${s.links.map((l) => `${l.label}: ${l.url}`).join("; ")}. Never send any other link.`
      : "Never send links.",
    "If no reply is needed (they said thanks or goodbye, or sent only an emoji or a like), choose action \"stop\" with no bubbles.",
    `stage: where they are now, one of ${DM_STAGES.map((k) => `${k} (${DM_STAGE_LABEL[k]})`).join(", ")}.`,
    "note: one short line about this person for the team (what they want). reason: why you chose this action, in a few words.",
  ];
  const notes = s.instructions.trim();
  const lessons = s.lessons.map((l) => `- ${l.text}`).join("\n");
  return `${lines.join("\n")}\n\nBusiness notes from the team:\n${notes || "(none yet: hand off anything specific)"}${lessons ? `\n\nWhat the team taught you:\n${lessons}` : ""}`;
}

export interface DmAiLine {
  direction: "in" | "out";
  text: string | null;
  kinds?: string[];
}

/** The chat as the model reads it, oldest first. */
export function dmAiTranscript(name: string | null, lines: DmAiLine[]): string {
  const said = lines
    .slice(-DM_AI_HISTORY)
    .map((m) => {
      const extra = (m.kinds ?? []).map((k) => `[${k.replace(/_/g, " ")}]`).join(" ");
      const t = [m.text?.trim(), extra].filter(Boolean).join(" ");
      return t ? `${m.direction === "in" ? "THEM" : "YOU"}: ${t}` : null;
    })
    .filter(Boolean);
  return `Person: ${name || "unknown"}\n\nConversation so far (oldest first):\n${said.join("\n")}\n\nWrite your next move.`;
}

// ---------------------------------------------------------------------------
// Views (GET /clients/:id/dm/ai)
// ---------------------------------------------------------------------------

export interface DmAiAccountView {
  accountId: string;
  platform: "instagram" | "facebook";
  handle: string;
  transport: "native" | "zernio";
  /** Instagram through our Meta app: the only place autopilot can send. */
  canAutopilot: boolean;
  settings: DmAiSettings;
  updatedAt: string | null;
  sentToday: number;
}

export interface DmAiQueueRow {
  threadId: string;
  accountId: string;
  platform: "instagram" | "facebook";
  contact: DmContactView;
  /** waiting: nobody answered for 30 minutes. handoff: the AI passed it on. */
  why: "waiting" | "handoff";
  reason: string;
  since: string | null;
  preview: string | null;
  paused: boolean;
  aiOff: boolean;
}

export interface DmAiPeriodStats {
  /** Chats the AI answered with no person sending anything. */
  answered: number;
  handedOff: number;
  drafts: number;
  sentAsIs: number;
  edited: number;
  autoSent: number;
  discarded: number;
  costCents: number;
}

export interface DmAiOverview {
  /** ANTHROPIC_API_KEY is set on the server. */
  configured: boolean;
  /** The agency's kill switch: AI sending stopped for every account. */
  killedAt: string | null;
  timezone: string;
  accounts: DmAiAccountView[];
  queue: DmAiQueueRow[];
  counts: { all: number; waiting: number; handoff: number };
  period: { from: string; to: string };
  stats: DmAiPeriodStats;
  monthCostCents: number;
  stages: Record<DmStage, number>;
  never: {
    list: Array<{ contactId: string; threadId: string | null; name: string; handle: string | null; platform: "instagram" | "facebook"; note: string | null; tags: string[]; via: "friend" | "off" }>;
    friends: number;
    off: number;
  };
}

export interface DmAiDraftView {
  id: string;
  status: string;
  origin: string;
  bubbles: string[];
  note: string | null;
  reason: string | null;
  sendAt: string | null;
  createdAt: string;
}

/** "$0.42" from cents. */
export const centsText = (c: number): string => `$${(Math.max(0, c) / 100).toFixed(2)}`;
