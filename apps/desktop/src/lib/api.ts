import type { AuthUser, LoginResponse, Platform } from "@toreroflow/core";

/** Base URL of the Toreroflow API (Fastify service). */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4700";

const TOKEN_KEY = "toreroflow-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    /*
     * The API answers failures with a short `error` and a fuller `detail`, and
     * only the short one was ever read, so every explanation the server wrote
     * was thrown away here. That is how a refused bank connection reached the
     * operator as "could not start the bank connection: could not start the
     * bank connection" while the server was saying exactly which setting was
     * wrong.
     *
     * The detail wins where there is one, because callers already pass their
     * own title to the toast and the short form usually just repeats it.
     */
    const fields = (typeof body === "object" && body !== null ? body : {}) as {
      error?: unknown;
      detail?: unknown;
    };
    const short = typeof fields.error === "string" ? fields.error.trim() : "";
    const full = typeof fields.detail === "string" ? fields.detail.trim() : "";
    super(full || short || `request failed (${status})`);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  /** For routes that take the whole record every time, like the niche profile. */
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  /** Multipart POST; the browser writes the boundary header itself. */
  postForm: async <T>(path: string, form: FormData): Promise<T> => {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}${path}`, { method: "POST", headers, body: form });
    const data: unknown = await res.json();
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  },
};

/* ---- API response shapes ---- */

export interface CatalogueVideo {
  platformVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  url: string | null;
  publishedAt: string;
  views: number;
}

export interface YouTubePlaylistInfo {
  id: string;
  title: string;
}

/** One track from Instagram's catalog of audio cleared for API publishing. */
export interface AudioTrack {
  audioId: string;
  title: string;
  artist: string | null;
  durationSec: number | null;
  /** Preview audio. Expires in about a day and a half, so never persisted. */
  previewUrl: string | null;
}

/**
 * Whether this account can reach the catalog at all, and what it holds.
 *
 * Unavailable is a normal answer, not an error: Meta serves audio only to
 * Instagram accounts connected through Facebook Login, so an ordinary
 * connection publishes reels fine and reads no catalog. The UI draws the
 * reconnect path instead of a failure.
 */
export type AudioCatalog =
  | { available: true; tracks: AudioTrack[] }
  | { available: false; reason: "facebook_login_required" | "not_connected" };

export interface AccountInfo {
  id: string;
  platform: Platform;
  handle: string;
  status: "connected" | "needs_reconnect" | "error";
  connectedAt: string;
  avatarUrl: string | null;
  displayName: string | null;
  followers: number | null;
  /** True when this account only sends the client a reminder to post by hand. */
  reminder?: boolean;
}

/** The registered company, as stored. Printed on every outgoing document. */
export interface AgencyBusiness {
  id: string;
  name: string;
  legalName: string | null;
  ein: string | null;
  businessAddress: string | null;
  businessCode: string | null;
  accountingMethod: string | null;
  taxState: string | null;
  filingStatus: string | null;
  otherIncomeCents: number | null;
  stateTaxRatePct: number | null;
}

/** What to set aside for tax on this year's profit. An estimate, not advice. */
export interface TaxEstimateView {
  year: number;
  ratesYear: number;
  basis: "cash" | "accrual";
  receiptsCents: number;
  deductibleCents: number;
  netProfitCents: number;
  selfEmploymentCents: number;
  federalIncomeCents: number;
  stateIncomeCents: number;
  totalCents: number;
  effectiveRatePct: number;
  quarterlyCents: number;
  halfSelfEmploymentCents: number;
  qbiDeductionCents: number;
  taxableIncomeCents: number;
  state: string;
  stateRatePct: number;
  stateRateExact: boolean;
  stateName: string | null;
  stateChosen: boolean;
}

/**
 * A direct credential for a platform's own API, from GET /oauth/connections.
 *
 * Keyed by socialAccountId, and deliberately not folded into the account row it
 * belongs to: an account can publish without one and read nothing, which is the
 * state every account is in until its owner authorizes.
 */
export interface PlatformConnection {
  socialAccountId: string;
  platform: Platform;
  externalName: string | null;
  /** active | revoked. Revoked means the owner withdrew consent. */
  status: string;
  error: string | null;
  lastSyncedAt: string | null;
  connectedAt: string;
}

export interface ClientSummary {
  id: string;
  name: string;
  avatarSeed: string | null;
  plan: string | null;
  /** Who to actually contact. The brand is `name`; this is the person. */
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /**
   * Handles the client gave for themselves on their welcome form, by platform.
   * Not connected accounts: these cannot post, and are how a platform nobody
   * had yet becomes known.
   */
  handles: Record<string, string> | null;
  /** Standing monthly price; the Financials month seeds from this. */
  monthlyPriceCents: number | null;
  billingMode: "calendar" | "on_fulfilment";
  createdAt: string;
  workflowCount: number;
  /** Null when no account has reported a follower count yet. */
  totalFollowers: number | null;
  accounts: AccountInfo[];
}

export interface WorkflowInfo {
  id: string;
  clientId: string;
  name: string;
  sourcePlatform: Platform;
  destinations: Platform[];
  enabled: boolean;
  createdAt: string;
}

export interface AccountAnalytics {
  id: string;
  platform: Platform;
  handle: string;
  status: string;
  avatarUrl: string | null;
  displayName: string | null;
  followers: number | null;
  window: {
    views: number;
    reach: number;
    likes: number;
    comments: number;
    shares: number;
    avgWatchSec: number | null;
  };
  latest: {
    capturedAt: string;
    views: number | null;
    reach: number | null;
    followers: number | null;
    engagementRate: number | null;
    avgWatchSec: number | null;
  } | null;
  history: Array<{
    capturedAt: string;
    views: number | null;
    reach: number | null;
    followers: number | null;
  }>;
}

export interface ClientAnalytics {
  client: { id: string; name: string; plan: string | null };
  days: number;
  accounts: AccountAnalytics[];
  totals: {
    views: number;
    reach: number;
    followers: number;
    engagementRate: number | null;
    avgWatchSec: number | null;
    likes: number;
    comments: number;
    shares: number;
  };
  hasData: boolean;
}

export type VideoFormat = "short_form" | "long_form";

export interface QuotaSection {
  target: number | null;
  adjustment: number;
  uploads: number;
  revisions: number;
  delivered: number;
}

export interface ClientQuota {
  periodStart: string | null;
  /** Uploads still being probed; counted as short-form until measured. */
  unclassified: number;
  short: QuotaSection;
  long: QuotaSection;
  carousel: QuotaSection;
}

export interface ClientReport {
  id: string;
  clientId: string;
  clientName?: string;
  periodStart: string;
  periodEnd: string;
  /** e.g. "June 2026" */
  label: string;
  url: string;
  generatedAt: string;
  seen: boolean;
}

/** Where one client stands with its public report page. */
export interface ClientPublishState {
  id: string;
  name: string;
  /** The permanent path, known before the first publish creates the page. */
  slug: string | null;
  /** Absolute URL; null until the page has actually been published once. */
  url: string | null;
  publishedAt: string | null;
  /** Month the live page currently leads with, e.g. "2026-06". */
  publishedMonth: string | null;
}

export interface ReportPublishing {
  configured: boolean;
  /** Why publishing is off, ready to show the operator. */
  reason: string | null;
  clients: ClientPublishState[];
}

export interface PublishResult {
  url: string;
  slug: string;
  month: string;
  periods: string[];
  /**
   * Set when a configured public address is not actually serving the report,
   * so `url` fell back to the report site's own link. Null when there is
   * nothing to say.
   */
  publicBaseWarning: string | null;
}

/** One brand's standing on the Account Overview screen. */
export interface OverviewClient {
  id: string;
  name: string;
  avatarSeed: string | null;
  avatarUrl: string | null;
  platforms: Array<{ platform: Platform; handle: string; status: string }>;
  /** Null when the client is not on a quota, which is not a fault. */
  delivery: {
    short: { delivered: number; target: number | null };
    long: { delivered: number; target: number | null };
    behindBy: number;
  } | null;
  /** Null when nothing has ever been published. */
  lastPostAt: string | null;
  daysQuiet: number | null;
  report: {
    month: string;
    label: string;
    built: boolean;
    opened: boolean;
    publishedMonth: string | null;
    url: string | null;
    /** Published, but leading with a month that is no longer current. */
    stale: boolean;
  };
  needsReconnect: boolean;
  /** The latest "what to do next" run, null when never generated. */
  insight: { status: string; url: string | null; completedAt: string | null } | null;
  /** Higher means more overdue attention. Drives the sort order. */
  attention: number;
}

export interface AccountOverview {
  month: { key: string; label: string };
  clients: OverviewClient[];
}

/** Something that failed in the background, still failing. */
export interface SystemAlert {
  id: string;
  kind: string;
  severity: "error" | "warning";
  clientId: string | null;
  clientName: string | null;
  /** Written for the operator, and says what to do about it. */
  message: string;
  detail: string | null;
  /** How many times this same problem has been recorded. */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  dismissed: boolean;
}

export interface AlertsResponse {
  count: number;
  alerts: SystemAlert[];
}

export interface RefreshResult {
  refreshedAt: string;
  periods: string[];
  /** False when the worker was unreachable; followers may lag one cycle. */
  followersRefreshed: boolean;
}

export interface UnseenReports {
  count: number;
  /** Ready-made notification text, e.g. "Report ready for June". */
  message: string | null;
  reports: ClientReport[];
}

export interface ClientPost {
  id: string;
  /** video | image | carousel. Decides which board a post belongs on. */
  mediaType: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string | null;
  platforms: Platform[];
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /**
   * Instagram only in practice. YouTube and Facebook have no save button, and
   * TikTok has one the provider has never reported. Ask reportsSaves() rather
   * than trusting this to be a measurement.
   */
  saves: number;
  reach: number;
  /**
   * Followers gained from this video. The provider carries the field but has
   * only ever sent zero, so check that something is non-zero before showing
   * it: a column of zeros reads as a result rather than a missing measurement.
   */
  follows: number;
  /**
   * Facebook only in practice, and null (never 0) when nothing measured it.
   * See METRIC_REPORTED_BY in packages/core for which platform reports what.
   */
  impressions: number | null;
  clicks: number | null;
  /**
   * DMs a comment-to-DM campaign sent for this video, and link opens among
   * them. Null on every video that had no campaign, which is the normal case;
   * a zero means the campaign ran and nobody commented the keyword, which is
   * a result rather than a gap.
   */
  dms: number | null;
  dmClicks: number | null;
  /** Total seconds watched across all viewers, measured rather than derived. */
  totalWatchSec: number | null;
  avgWatchSec: number | null;
  durationSec: number | null;
  /**
   * When the platform last refreshed this post's numbers. Null when no source
   * carried a timestamp, which is why the provenance footer omits the date
   * entirely rather than falling back to now.
   */
  metricsUpdatedAt: string | null;
  /**
   * One entry per platform this post went to, carrying that platform's own
   * figures. Mirrors MergedPost.byPlatform on the API.
   *
   * Every total on the Analytics screen is built from these rather than from
   * the post-level fields above, because METRIC_REPORTED_BY excludes a platform
   * for two different reasons: it sends nothing, or it sends a number we
   * deliberately suppress. Instagram impressions are the second kind, so a
   * post-level total would carry them into a figure labelled Impressions.
   */
  byPlatform: Array<{
    platform: Platform;
    views: number;
    accountId?: string;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    reach: number | null;
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
    dms?: number | null;
    dmClicks?: number | null;
  }>;
}

export interface Suggestion {
  title: string;
  detail: string;
  category: string;
}

/**
 * A "what to do next" run. Generation happens on the worker, so this is
 * polled rather than returned by the request that starts it.
 */
export interface ClientInsight {
  status: string;
  suggestions: Suggestion[] | null;
  /** The rendered PDF, null until the run lands. */
  url: string | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface DraftCopy {
  /** The video's label in the app, and the fallback for the fields below. */
  name?: string;
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description?: string;
  youtubeTitle?: string;
  youtubeDescription?: string;
  hashtags?: string[];
}

export interface MediaAssetInfo {
  id: string;
  clientId: string;
  name: string;
  /** video | carousel. A carousel is images posted as one Instagram post. */
  kind: "video" | "carousel";
  /** How many images the carousel holds. Zero for a video. */
  slideCount: number;
  durationSec: number | null;
  /** Probed frame size. Null until processing has measured the file. */
  width: number | null;
  height: number | null;
  status: "uploaded" | "processing" | "ready" | "failed";
  hasTranscript: boolean;
  draftCopy: DraftCopy | null;
  /** Null until processing measures the duration. */
  format: VideoFormat | null;
  /** A re-edit of an earlier upload; excluded from the client's quota. */
  isRevision: boolean;
  revisionOfId: string | null;
  createdAt: string;
  thumbUrl: string | null;
  /** Millisecond offset of the chosen cover frame; null when auto or uploaded. */
  coverOffsetMs: number | null;
  /** The original upload; videos are published exactly as exported. */
  videoUrl: string | null;
  /** Set once the source file was cleared, a week after the post went live. */
  sourceDeletedAt?: string | null;
}

/** What to call a video on screen: the typed name, else the file name. */
export function videoLabel(asset: MediaAssetInfo): string {
  const name = asset.draftCopy?.name?.trim();
  return name ? name : asset.name;
}

export interface PostTargetInfo {
  id: string;
  postId: string;
  platform: Platform;
  status: "scheduled" | "publishing" | "posted" | "failed" | "reminded";
  scheduledAt: string | null;
  publishedAt: string | null;
  error: string | null;
  /** The platform's own id for a published post, and its public link. */
  remotePostId: string | null;
  remoteUrl: string | null;
  /**
   * The long-form wizard's afterlife: what a human still finishes in Studio,
   * and where the automatic metadata application stands. Null on everything
   * that never went through the wizard.
   */
  youtube?: {
    studioTasks: string[];
    enrich: { state: "applied" | "error" | "pending"; detail: string | null } | null;
    /** The thumbnail A/B test on this video, when one exists. */
    abTest: {
      state: "running" | "done" | "cancelled" | "error" | string;
      periodDays: number;
      startedAt: string | null;
      applied: string | null;
      note: string | null;
      result: { aPerDay?: number | null; bPerDay?: number | null; winner?: string | null; note?: string } | null;
    } | null;
  } | null;
  caption: string | null;
  assetName: string;
  thumbUrl: string | null;
  /** video | carousel, so the queue and calendar can say which is which. */
  assetKind: string;
  /** How many slides, when the asset is a carousel. Zero for a video. */
  slideCount: number;
}

/** Absolute URL for a server-stored media file. */
export function fileUrl(relative: string | null): string | null {
  return relative ? `${API_URL}${relative}` : null;
}

export async function uploadMedia(clientId: string, file: File): Promise<MediaAssetInfo> {
  const form = new FormData();
  form.append("file", file, file.name);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/clients/${clientId}/media`, {
    method: "POST",
    headers,
    body: form,
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as MediaAssetInfo;
}

/** One variant image for a thumbnail A/B test. Returns the storage key. */
export async function uploadAbThumb(
  targetId: string,
  slot: "a" | "b",
  file: File,
): Promise<{ key: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  return api.postForm(`/posts/targets/${targetId}/ab-thumb/${slot}`, form);
}

/** Park a subtitle file with the asset; the enrichment applies it after publish. */
export async function uploadCaptionFile(
  assetId: string,
  language: string,
  file: File,
): Promise<{ key: string; language: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  return api.postForm(`/media/${assetId}/captions?language=${encodeURIComponent(language)}`, form);
}

export async function uploadCoverImage(assetId: string, file: File): Promise<MediaAssetInfo> {
  const form = new FormData();
  form.append("file", file, file.name);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/media/${assetId}/cover-image`, {
    method: "POST",
    headers,
    body: form,
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as MediaAssetInfo;
}

export type { AuthUser, LoginResponse, Platform };

/** An account a client said they want their content to be like. */
export interface InspirationAccount {
  id: string;
  platform: string;
  handle: string;
  displayName: string | null;
  /** The platform's own id is known, so a run costs one call instead of two. */
  resolved: boolean;
  confirmedAt: string | null;
  error: string | null;
  lastFetchedAt: string | null;
}

export interface ResearchRun {
  id: string;
  status: string;
  maxCents: number;
  spentCents: number;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface InspirationsView {
  accounts: InspirationAccount[];
  /** What pressing the button would cost, in cents, before it is pressed. */
  quoteCents: number;
  run: ResearchRun | null;
}

/** One account inside a linked bank. */
export interface BankAccountInfo {
  id: string;
  name: string;
  mask: string | null;
  currentCents: number | null;
  availableCents: number | null;
  currency: string;
  /** Whether it counts towards money in and money out. */
  includeInCashFlow: boolean;
}

export interface BankConnectionInfo {
  id: string;
  institutionName: string | null;
  /** active | needs_reconnect | error. */
  status: string;
  error: string | null;
  lastSyncedAt: string | null;
  accounts: BankAccountInfo[];
}

export interface BankConnectionsView {
  connections: BankConnectionInfo[];
}

export interface BankFlowTotalsInfo {
  inCents: number;
  outCents: number;
  netCents: number;
  counted: number;
}

export interface BankCashflowView {
  months: number;
  totals: BankFlowTotalsInfo;
  byMonth: Array<{ month: string } & BankFlowTotalsInfo>;
  recent: Array<{ date: string; name: string; amountCents: number; pending: boolean }>;
}

/**
 * Several images as one carousel.
 *
 * Order matters: it is the order Instagram shows them in, and the first image
 * decides the aspect ratio of the whole post.
 */
export async function uploadCarousel(
  clientId: string,
  files: File[],
  /** A Create > Carousels draft whose caption and hashtags ride along. */
  draftId?: string,
  /** Per-item crop rects from the builder, aligned by position. */
  crops?: Array<{ x: number; y: number; width: number; height: number } | null>,
): Promise<MediaAssetInfo> {
  const form = new FormData();
  // Fields must precede the files: the route streams parts in order, and a
  // crops field arriving after 35 files would be read too late to matter.
  if (crops?.some((c) => c !== null)) form.append("crops", JSON.stringify(crops));
  files.forEach((f, i) => form.append(`slide${i + 1}`, f, f.name));
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
  const res = await fetch(`${API_URL}/clients/${clientId}/carousel${query}`, {
    method: "POST",
    headers,
    body: form,
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as MediaAssetInfo;
}

/** One inline button on an auto-DM. Meta renders at most three. */
export interface DmButton {
  type: "url" | "postback" | "phone";
  title: string;
  url?: string;
  payload?: string;
  phone?: string;
}

/** What a campaign has done. Zero everywhere on a fresh one. */
export interface DmCampaignStats {
  triggered: number;
  dmsSent: number;
  dmsFailed: number;
  uniqueContacts: number;
  trackedSends: number;
  linkClicks: number;
  uniqueClicks: number;
  /** Messenger only; Instagram emits no delivery receipt so this stays 0. */
  delivered: number;
  read: number;
}

export interface DmCampaign {
  id: string;
  name: string;
  platform: "instagram" | "facebook";
  trigger: "comment" | "story_reply";
  accountId: string | null;
  /** The platform's own media id, or null for a campaign covering the account. */
  platformPostId: string | null;
  postTitle: string | null;
  keywords: string[];
  matchMode: "exact" | "contains" | "word";
  excludeKeywords: string[];
  dmMessage: string;
  buttons: DmButton[];
  commentReply: string | null;
  alsoMatchInDms: boolean;
  linkTracking: boolean;
  isActive: boolean;
  stats: DmCampaignStats;
  createdAt: string | null;
}

/** One person who triggered a campaign, and what became of their DM. */
export interface DmCampaignLog {
  id: string;
  commenterId: string | null;
  commenterName: string | null;
  commentText: string | null;
  source: "comment" | "story_reply" | "dm" | null;
  status: "pending" | "sent" | "failed" | "skipped" | "gated";
  error: string | null;
  createdAt: string | null;
}

export interface InboxConversation {
  id: string;
  platform: string;
  accountId: string;
  accountUsername: string | null;
  participantId: string | null;
  participantName: string | null;
  participantPicture: string | null;
  lastMessage: string | null;
  updatedTime: string | null;
  unreadCount: number;
  instagramProfile: {
    isFollower?: boolean;
    isFollowing?: boolean;
    followerCount?: number;
    isVerified?: boolean;
  } | null;
}

export interface InboxMessage {
  id: string;
  message: string;
  senderId: string | null;
  senderName: string | null;
  direction: "incoming" | "outgoing";
  createdAt: string | null;
  attachments: Array<{ type: string | null; url: string | null }>;
}
