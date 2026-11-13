import {
  POLLY,
  resetOverride,
  type Draft,
  type DraftUpsert,
  type Issue,
  type OverrideField,
  type PreflightRequest,
  type PreflightResult,
  type Principal,
  type QueueItem,
  type Rollup,
  type Target,
  type Template,
  type WorkflowPlatform,
} from "@toreroflow/contracts";

/*
 * The workflow screens' logic (W1 to W5), kept out of the components so the
 * check file can run it without a DOM. Types and the reset rule come from
 * @toreroflow/contracts; nothing here redefines them.
 */

export const PLATFORM_LABEL: Record<WorkflowPlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};
export const WORKFLOW_PLATFORMS: WorkflowPlatform[] = ["youtube", "instagram", "tiktok"];

// ---- W1 fan-out ----

/** Writes one field to one target's overrides. Every other target is untouched. */
export function setOverride(draft: Draft, platform: WorkflowPlatform, field: OverrideField, value: string): Draft {
  return {
    ...draft,
    targets: draft.targets.map((t) =>
      t.platform === platform ? { ...t, overrides: { ...t.overrides, [field]: value } } : t,
    ),
  };
}

/** Reset to draft: the contract's resetOverride, which deletes the key. */
export function resetField(draft: Draft, platform: WorkflowPlatform, field: OverrideField): Draft {
  return { ...draft, targets: draft.targets.map((t) => (t.platform === platform ? resetOverride(t, field) : t)) };
}

export function isOverridden(t: Target): boolean {
  return Object.keys(t.overrides).length > 0;
}

/** A fresh draft for a video: one target per platform, nothing overridden. */
export function newDraft(id: string, brandId: string, videoId: string, caption: string, postAt: string, title?: string): Draft {
  return {
    id,
    brandId,
    videoId,
    caption,
    ...(title ? { title } : {}),
    postAt,
    targets: WORKFLOW_PLATFORMS.map((platform) => ({ platform, overrides: {} })),
  };
}

/** Adds a platform back (one target each) or takes one off the draft. */
export function setTargets(draft: Draft, platforms: WorkflowPlatform[]): Draft {
  return {
    ...draft,
    targets: WORKFLOW_PLATFORMS.filter((p) => platforms.includes(p)).map(
      (platform) => draft.targets.find((t) => t.platform === platform) ?? { platform, overrides: {} },
    ),
  };
}

/**
 * The PUT /drafts/:id body. The server replaces every target's overrides
 * whole (an omitted key is a reset), so this always sends all of them.
 */
export function upsertBody(draft: Draft): DraftUpsert {
  const { id: _id, ...body } = draft;
  return { ...body, targets: draft.targets.map((t) => ({ platform: t.platform, overrides: { ...t.overrides } })) };
}

/** What the server would refuse with a 400, caught before the request. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.targets.length) return "Add at least one platform before saving.";
  const dup = draft.targets.find((t, i) => draft.targets.findIndex((x) => x.platform === t.platform) !== i);
  return dup ? `${PLATFORM_LABEL[dup.platform]} is on the draft twice. Keep one.` : null;
}

/** A failed save, said for the composer's inline error. */
export function saveErrorText(status: number | null, message: string): string {
  if (status === 403) return "Viewers can open drafts but not save them.";
  if (status === 409) return `${cap(message)}. Saving only changes drafts.`;
  if (status === 400 && /^no (.+) account/.test(message)) return `${cap(message)}. Remove that platform or connect the account in Settings.`;
  return cap(message);
}

/** Capitalized, with platform ids ("no tiktok account") as their names. */
const cap = (s: string) => {
  const t = s.replace(/\b(youtube|instagram|tiktok)\b/g, (p) => PLATFORM_LABEL[p as WorkflowPlatform]);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/*
 * The draft open in the composer, handed between Fan-out and Preflight
 * through sessionStorage so a reload keeps it. saved is true only while the
 * server holds this exact version (loaded with GET or just saved); any edit,
 * and any draft from a template, is unsaved.
 */
export interface DraftSession {
  draft: Draft;
  saved: boolean;
}
const DRAFT_KEY = "toreroflow-fanout-draft";
export function stashDraft(session: DraftSession, store: Pick<Storage, "setItem"> = sessionStorage): void {
  store.setItem(DRAFT_KEY, JSON.stringify(session));
}
export function loadStashedDraft(store: Pick<Storage, "getItem"> = sessionStorage): DraftSession | null {
  try {
    const raw = store.getItem(DRAFT_KEY);
    const s = raw ? (JSON.parse(raw) as DraftSession) : null;
    return s?.draft?.id ? { draft: s.draft, saved: s.saved === true } : null;
  } catch {
    return null;
  }
}

/** "YYYY-MM-DDTHH:mm" local, the GlassDateTime value, from an ISO time. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(local: string): string {
  return new Date(local).toISOString();
}

// ---- W2 preflight ----

export function preflightSummary(r: PreflightResult): { blocked: boolean; text: string } {
  const n = r.blocking.length;
  if (!n) return { blocked: false, text: r.warnings.length ? `Clear to post, ${plural(r.warnings.length, "warning")}.` : "All clear." };
  const platforms = new Set(r.blocking.map((i) => i.platform)).size;
  return { blocked: true, text: `${plural(n, "issue")} across ${plural(platforms, "platform")}.` };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What preflight needs from the draft's video when it goes inline. */
export interface PreflightMedia {
  kind: "video" | "carousel";
  durationSec: number | null;
  coverOffsetMs: number | null;
  thumbUrl: string | null;
}

/**
 * The POST /preflight body: exactly one of draftId (the server holds this
 * version) or draft (template drafts, new ones and unsaved edits, inline).
 */
export function preflightBody(session: DraftSession, media?: PreflightMedia | null): PreflightRequest {
  if (session.saved) return { draftId: session.draft.id };
  const draft: NonNullable<PreflightRequest["draft"]> = upsertBody(session.draft);
  if (media) {
    draft.kind = media.kind;
    if (media.kind === "video" && media.durationSec != null) draft.videoSeconds = media.durationSec;
    // ponytail: a picked frame or an uploaded cover file (cover.<ext>) counts as a cover; the
    // list has no coverKey, add it to MediaAssetInfo if the thumbUrl shape ever changes.
    const cover = media.coverOffsetMs != null ? `frame:${media.coverOffsetMs}` : media.thumbUrl && /\/cover\.\w+/.test(media.thumbUrl) ? media.thumbUrl : null;
    if (cover) draft.cover = cover;
  }
  return { draft };
}

/** A preflight that could not run, said for the error state. */
export function preflightErrorText(status: number | null, message: string, saved: boolean): string {
  if (status === 403) return "This account cannot run preflight.";
  if (status === 404) return saved ? "This draft is no longer saved. Open it again in Fan-out." : "This draft's brand is not in your agency.";
  if (status === 400) return `Preflight could not read the draft: ${message}`;
  return message;
}

/** The field an issue's fixRoute points at ("/create/new#instagram.caption"). */
export function fixTarget(issue: Issue): { platform: WorkflowPlatform; field: string } {
  const field = issue.fixRoute.split("#")[1]?.split(".")[1] ?? "caption";
  return { platform: issue.platform, field };
}

/** Where a fix link goes: Fan-out at the field, /create/new for an unsaved draft. */
export function fixHref(issue: Issue, draftId: string, saved: boolean): string {
  const { platform, field } = fixTarget(issue);
  return `/create/${saved ? encodeURIComponent(draftId) : "new"}#${platform}.${field}`;
}

/** The composer field a fix link's hash names ("instagram.caption"), as its DOM id. */
export function fieldFromHash(hash: string): string | null {
  const m = /^#?(youtube|instagram|tiktok)\.(\w+)$/.exec(hash);
  return m ? fieldId(m[1] as WorkflowPlatform, m[2]!) : null;
}

export function fixLabel(issue: Issue): string {
  if (issue.code.endsWith("_off_brand")) return "Review brand";
  const { field } = fixTarget(issue);
  return field === "cover" ? "Fix cover" : field === "cutId" ? "Pick a cut" : field === "title" ? "Edit title" : "Edit caption";
}

/** The composer field's DOM id, shared by the fix links and the inputs. */
export const fieldId = (platform: WorkflowPlatform, field: string) => `fanout-${platform}-${field}`;

/** Operator or Polly. The server decides; this only hides what it would refuse. */
export function principalFrom(role: "owner" | "viewer" | undefined, token: string | null): Principal {
  const bot = botName(token);
  if (bot) return { role: "bot", bot: bot === POLLY.name ? POLLY : { name: bot, fullAccess: false, scopes: [] } };
  return role === "owner" ? { role: "owner" } : { role: "viewer" };
}

function botName(token: string | null): string | null {
  try {
    const part = token?.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: string; bot?: string };
    return payload.role === "bot" ? (payload.bot ?? "bot") : null;
  } catch {
    return null;
  }
}

// ---- W3 queue ----

/** Moves one id to a new index, for drag and for Move up / Move down. */
export function moveId(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
  return next;
}

/** Rush first, then position: the order GET /queue already returns, kept after local moves. */
export function queueOrder(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => Number(b.priority === "rush") - Number(a.priority === "rush") || a.position - b.position);
}

// ---- W4 rollup ----

/** False when no platform has a single number: Zernio's analytics are not in. */
export function rollupHasData(r: Rollup): boolean {
  return r.rows.some((row) => row.youtube != null || row.instagram != null || row.tiktok != null);
}

export function fmtMetric(metric: Rollup["rows"][number]["metric"], v: number | null): string {
  if (v == null) return "n/a";
  if (metric === "avgWatchSeconds") {
    const s = Math.round(v);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString("en-US");
}

export const METRIC_LABEL: Record<Rollup["rows"][number]["metric"], string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  avgWatchSeconds: "Avg watch",
};

// ---- W5 templates ----

export type TemplateForm = Omit<Template, "id" | "hashtags" | "postTimes"> & { hashtags: string; postTimes: string };

export function templateToForm(t: Omit<Template, "id">): TemplateForm {
  return { ...t, hashtags: t.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" "), postTimes: t.postTimes.join(", ") };
}

/** Back to the upsert body. Bad times are left for the server's 400 to name. */
export function formToTemplate(f: TemplateForm): Omit<Template, "id"> {
  return {
    ...f,
    name: f.name.trim(),
    hashtags: f.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean),
    postTimes: f.postTimes.split(/[\s,]+/).filter(Boolean),
  };
}

export function blankTemplate(brandId: string): Omit<Template, "id"> {
  return { scope: "client", brandId, name: "", platforms: [...WORKFLOW_PLATFORMS], captionPattern: "", hashtags: [], coverStyle: "", postTimes: [], cadence: "" };
}
