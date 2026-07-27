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
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${status})`,
    );
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
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/* ---- API response shapes ---- */

export interface AccountInfo {
  id: string;
  platform: Platform;
  handle: string;
  status: "connected" | "needs_reconnect" | "error";
  connectedAt: string;
  avatarUrl: string | null;
  displayName: string | null;
  followers: number | null;
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
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string | null;
  platforms: Platform[];
  views: number;
  likes: number;
  comments: number;
  shares: number;
  avgWatchSec: number | null;
  durationSec: number | null;
  byPlatform: Array<{ platform: Platform; views: number }>;
}

export interface Suggestion {
  title: string;
  detail: string;
  category: string;
}

export interface DraftCopy {
  /** Posted verbatim: YouTube title, and the Instagram/TikTok caption. */
  title?: string;
  description?: string;
  hashtags?: string[];
}

export interface MediaAssetInfo {
  id: string;
  clientId: string;
  name: string;
  durationSec: number | null;
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
  /** The original upload; videos are published exactly as exported. */
  videoUrl: string | null;
}

export interface PostTargetInfo {
  id: string;
  postId: string;
  platform: Platform;
  status: "scheduled" | "publishing" | "posted" | "failed";
  scheduledAt: string | null;
  publishedAt: string | null;
  error: string | null;
  caption: string | null;
  assetName: string;
  thumbUrl: string | null;
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

export type { AuthUser, LoginResponse, Platform };
