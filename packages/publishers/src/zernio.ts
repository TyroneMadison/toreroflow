import type { Platform } from "@toreroflow/core";

const BASE = "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  name?: string;
  displayName?: string;
  profileId?: string;
  profile?: string;
  status?: string;
}

/**
 * Zernio unified publishing provider (docs.zernio.com).
 * Model: one Zernio "profile" per Toreroflow client; accounts OAuth-connect to
 * that profile via a hosted authUrl; tokens live with Zernio, never with us.
 */
export class ZernioProvider {
  constructor(private readonly apiKey: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body; keep raw text for the error message
    }
    if (!res.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : text.slice(0, 200) || `zernio request failed (${res.status})`;
      throw new ZernioError(res.status, message);
    }
    return data as T;
  }

  /** Create the Zernio profile backing a Toreroflow client. Returns profile id. */
  async createProfile(name: string, description?: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>("POST", "/profiles", {
      name,
      description: description ?? `Toreroflow client: ${name}`,
    });
    const profile = (data.profile ?? data) as { _id?: string; id?: string };
    const id = profile._id ?? profile.id;
    if (!id) throw new ZernioError(500, "zernio profile response missing id");
    return id;
  }

  /** Hosted OAuth page URL for connecting one platform to a profile. */
  async connectUrl(platform: Platform, profileId: string): Promise<string> {
    const data = await this.request<{ authUrl?: string; url?: string }>(
      "GET",
      `/connect/${platform}?profileId=${encodeURIComponent(profileId)}`,
    );
    const url = data.authUrl ?? data.url;
    if (!url) throw new ZernioError(500, "zernio connect response missing authUrl");
    return url;
  }

  /** All connected accounts visible to this API key. */
  async listAccounts(profileId?: string): Promise<ZernioAccount[]> {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
    const data = await this.request<Record<string, unknown>>("GET", `/accounts${query}`);
    const accounts = (data.accounts ?? data) as unknown;
    return Array.isArray(accounts) ? (accounts as ZernioAccount[]) : [];
  }

  /**
   * Performance data across connected accounts. Zernio's docs leave the item
   * shape loose, so callers normalize field names defensively and keep raw.
   */
  async analytics(limit = 200): Promise<Array<Record<string, unknown>>> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/analytics?limit=${limit}`,
    );
    const arr = (data.analytics ?? data.posts ?? data.data ?? data) as unknown;
    return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
  }

  /** Presigned upload slot for a media file (valid 1h; storage 7 days). */
  async presignMedia(
    filename: string,
    contentType: string,
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    const data = await this.request<{ uploadUrl?: string; publicUrl?: string }>(
      "POST",
      "/media/presign",
      { filename, contentType },
    );
    if (!data.uploadUrl || !data.publicUrl) {
      throw new ZernioError(500, "zernio presign response missing urls");
    }
    return { uploadUrl: data.uploadUrl, publicUrl: data.publicUrl };
  }

  /** Direct PUT of the file body to the presigned URL (no auth header). */
  async uploadMedia(uploadUrl: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!res.ok) {
      throw new ZernioError(res.status, `media upload failed (${res.status})`);
    }
  }

  /** Publish (or schedule) a post to one or more connected accounts. */
  async createPost(input: {
    content: string;
    mediaUrl?: string;
    targets: Array<{ platform: Platform; accountId: string }>;
    publishNow?: boolean;
    scheduledFor?: string;
    timezone?: string;
  }): Promise<{ remotePostId: string }> {
    const body: Record<string, unknown> = {
      content: input.content,
      platforms: input.targets.map((t) => ({
        platform: t.platform,
        accountId: t.accountId,
      })),
    };
    if (input.mediaUrl) {
      body.mediaItems = [{ url: input.mediaUrl, type: "video" }];
    }
    if (input.publishNow) body.publishNow = true;
    if (input.scheduledFor) {
      body.scheduledFor = input.scheduledFor;
      body.timezone = input.timezone ?? "UTC";
    }
    const data = await this.request<Record<string, unknown>>("POST", "/posts", body);
    const post = (data.post ?? data) as { _id?: string; id?: string };
    return { remotePostId: post._id ?? post.id ?? "unknown" };
  }

  /**
   * Accounts belonging to one profile. Uses the server-side filter when it
   * works; falls back to filtering on any profile field in the payload.
   */
  async accountsForProfile(profileId: string): Promise<ZernioAccount[]> {
    const accounts = await this.listAccounts(profileId);
    const tagged = accounts.filter(
      (a) => a.profileId === profileId || a.profile === profileId,
    );
    // If Zernio ignored the query param and items carry no profile field,
    // we cannot distinguish; return everything rather than nothing.
    if (tagged.length === 0 && accounts.some((a) => !a.profileId && !a.profile)) {
      return accounts;
    }
    return tagged;
  }
}
