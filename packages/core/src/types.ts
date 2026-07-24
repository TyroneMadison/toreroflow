export const PLATFORMS = ["instagram", "tiktok", "youtube", "snapchat"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  snapchat: "Snapchat",
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
