export const PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "snapchat",
  "facebook",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  snapchat: "Snapchat",
  facebook: "Facebook",
};

export type SocialAccountStatus = "connected" | "needs_reconnect" | "error";
export type MediaAssetStatus = "uploaded" | "processing" | "ready" | "failed";
export type PostStatus = "draft" | "scheduled" | "publishing" | "posted" | "failed";
export type PostTargetStatus = "scheduled" | "publishing" | "posted" | "failed";
export type CaptionStyle = "bold_pop" | "karaoke" | "minimal" | "neon";

export interface HealthResponse {
  status: "ok";
  service: "toreroflow-api";
  version: string;
  time: string;
  /**
   * Whether the background worker is alive.
   *
   * The API answering says nothing about the process that transcodes video,
   * publishes posts and pulls analytics. When that is down, uploads are still
   * accepted and simply never finish, so the app has to be able to say so.
   */
  worker: "up" | "down";
}

export interface AuthUser {
  id: string;
  email: string;
  role: "owner" | "viewer";
  agencyId: string;
  agencyName: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
