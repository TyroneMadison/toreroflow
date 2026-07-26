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
}

export interface ClientSummary {
  id: string;
  name: string;
  avatarSeed: string | null;
  plan: string | null;
  createdAt: string;
  workflowCount: number;
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
