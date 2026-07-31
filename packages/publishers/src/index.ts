export * from "./simplefin";
import type { Platform } from "@toreroflow/core";

export * from "./options";
export * from "./zernio";
export * from "./youtube";

/** Spec Section 8 - every provider (unified or direct) implements this. */
export interface SocialAccountRef {
  id: string;
  platform: Platform;
  handle: string;
  providerAccountId?: string | null;
}

export interface CallbackParams {
  code?: string;
  state?: string;
  [key: string]: string | undefined;
}

export interface SocialAccountInit {
  platform: Platform;
  handle: string;
  providerAccountId: string;
  tokensEncrypted: string;
  scopes: string[];
}

export interface PublishInput {
  account: SocialAccountRef;
  videoUrl: string;
  caption: string;
  hashtags: string[];
  scheduledAt?: Date;
  /** Built platform extras, logged verbatim so dry runs can be inspected. */
  extras?: unknown;
}

export interface PublishResult {
  remotePostId: string;
  remoteUrl?: string;
}

export interface MetricSnapshotInput {
  views?: number;
  reach?: number;
  followers?: number;
  engagementRate?: number;
  avgWatchSec?: number;
  raw?: unknown;
}

export interface PostMetricInput {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

export interface Publisher {
  platform: Platform;
  connectUrl(clientId: string): Promise<string>;
  handleCallback(params: CallbackParams): Promise<SocialAccountInit>;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchAccountMetrics(account: SocialAccountRef, since: Date): Promise<MetricSnapshotInput>;
  fetchPostMetrics(remotePostId: string): Promise<PostMetricInput>;
}

/**
 * Dry-run publisher: logs the payload and returns a fake remote id so the whole
 * pipeline can run without touching live accounts (spec Section 8).
 */
export class DryRunPublisher implements Publisher {
  constructor(public platform: Platform) {}

  async connectUrl(clientId: string): Promise<string> {
    return `https://dryrun.local/oauth/${this.platform}?client=${encodeURIComponent(clientId)}`;
  }

  async handleCallback(params: CallbackParams): Promise<SocialAccountInit> {
    return {
      platform: this.platform,
      handle: `dryrun_${this.platform}`,
      providerAccountId: `dryrun-${this.platform}-${params.state ?? "0"}`,
      tokensEncrypted: "dryrun",
      scopes: [],
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    console.log(`[dryrun:${this.platform}] publish`, {
      account: input.account.handle,
      caption: input.caption.slice(0, 80),
      hashtags: input.hashtags,
      scheduledAt: input.scheduledAt?.toISOString(),
      extras: input.extras ?? null,
    });
    return { remotePostId: `dryrun-${this.platform}-${input.account.id}-${Date.now()}` };
  }

  async fetchAccountMetrics(): Promise<MetricSnapshotInput> {
    return { views: 0, reach: 0, followers: 0, engagementRate: 0, avgWatchSec: 0 };
  }

  async fetchPostMetrics(): Promise<PostMetricInput> {
    return { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  }
}
