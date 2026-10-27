import {
  POLLY,
  resetOverride,
  type Draft,
  type Issue,
  type OverrideField,
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

/*
 * The draft a template's "Use template" produced, handed to the composer
 * through sessionStorage, so a reload of the composer keeps it.
 */
const DRAFT_KEY = "toreroflow-fanout-draft";
export function stashDraft(draft: Draft, store: Pick<Storage, "setItem"> = sessionStorage): void {
  store.setItem(DRAFT_KEY, JSON.stringify(draft));
}
export function loadStashedDraft(store: Pick<Storage, "getItem"> = sessionStorage): Draft | null {
  try {
    const raw = store.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
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

/** The field an issue's fixRoute points at ("/create/<draft>#instagram.caption"). */
export function fixTarget(issue: Issue): { platform: WorkflowPlatform; field: string } {
  const field = issue.fixRoute.split("#")[1]?.split(".")[1] ?? "caption";
  return { platform: issue.platform, field };
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
