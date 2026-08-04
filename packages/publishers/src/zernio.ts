import type { Platform } from "@toreroflow/core";

const BASE = "https://zernio.com/api/v1";

/**
 * What a post actually carries: one video, or a set of images.
 *
 * Never both. A carousel has no single video to fall back to, and sending a
 * video alongside images would leave the provider to decide what a client's
 * account receives. Images win where both somehow arrive.
 */
export function mediaItemsFor(input: {
  mediaUrl?: string;
  mediaThumbnail?: string;
  imageUrls?: string[];
}): Array<Record<string, unknown>> {
  if (input.imageUrls?.length) {
    return input.imageUrls.map((url) => ({ url, type: "image" }));
  }
  if (input.mediaUrl) {
    const item: Record<string, unknown> = { url: input.mediaUrl, type: "video" };
    if (input.mediaThumbnail) item.thumbnail = input.mediaThumbnail;
    return [item];
  }
  return [];
}

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
  /** Zernio returns either a bare id or a populated {_id, name} object. */
  profileId?: string | { _id: string; name?: string };
  profile?: string | { _id: string };
  status?: string;
  followersCount?: number;
  externalPostCount?: number;
  isActive?: boolean;
  metadata?: {
    profileData?: {
      username?: string;
      displayName?: string;
      profilePicture?: string;
    };
  };
}

/** Normalized profile id regardless of Zernio's populated/bare shape. */
export function zernioProfileId(account: ZernioAccount): string | null {
  const p = account.profileId ?? account.profile;
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof p._id === "string") return p._id;
  return null;
}

export interface HistoryWindow {
  fromDate: string;
  toDate: string;
}

const DAY_MS = 86_400_000;
/** Per-window fetch ceiling in analyticsHistory; a full window warns that older posts may be missing. */
const WINDOW_MAX = 2000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Contiguous 366-day windows walking backwards from `today`, newest
 * first. Zernio's /analytics accepts at most a 366-day fromDate..toDate
 * range and defaults to 90 days when the params are omitted, so deep
 * history is fetched one window at a time.
 */
export function historyWindows(today: Date, maxWindows = 10): HistoryWindow[] {
  const windows: HistoryWindow[] = [];
  let to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 0; i < maxWindows; i++) {
    const from = new Date(to.getTime() - 365 * DAY_MS);
    windows.push({ fromDate: isoDate(from), toDate: isoDate(to) });
    to = new Date(from.getTime() - DAY_MS);
  }
  return windows;
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

  /**
   * Disconnects one connected account, at the provider.
   *
   * Offboarding a client has to reach this. Removing them locally leaves their
   * Instagram still authorised to a workspace nobody is watching, which is
   * both a standing charge and an access nobody agreed to keep.
   */
  async disconnectAccount(accountId: string): Promise<void> {
    await this.request("DELETE", `/accounts/${accountId}`);
  }

  /**
   * Deletes a profile, the workspace backing one client.
   *
   * Connected accounts block this with a 400, so they are disconnected first.
   * That order matters and is the caller's job, because a half-finished
   * offboarding is worse than one that refused.
   */
  async deleteProfile(profileId: string): Promise<void> {
    await this.request("DELETE", `/profiles/${profileId}`);
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
   * Without dates Zernio serves its 90-day default window.
   */
  async analytics(
    max = 500,
    fromDate?: string,
    toDate?: string,
  ): Promise<Array<Record<string, unknown>>> {
    // Zernio caps limit at 100 and paginates via ?page=N.
    const pageSize = 100;
    const range =
      (fromDate ? `&fromDate=${fromDate}` : "") + (toDate ? `&toDate=${toDate}` : "");
    const out: Array<Record<string, unknown>> = [];
    for (let page = 1; out.length < max && page <= Math.ceil(max / pageSize); page++) {
      const data = await this.request<Record<string, unknown>>(
        "GET",
        `/analytics?limit=${pageSize}&page=${page}${range}`,
      );
      const arr = (data.analytics ?? data.posts ?? data.data ?? data) as unknown;
      const items = Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
      out.push(...items);

      /*
       * A short page is not the end of the data.
       *
       * Measured against the live account: page 1 of 13 returned 99 items on
       * a limit of 100, with 1,244 posts behind it. The old rule stopped at
       * any page shorter than the limit, so the deep ingest was silently
       * truncated to one page and the rolling store's older posts stopped
       * refreshing. The response carries its own pagination object, which is
       * authoritative when present; an empty page still ends the walk either
       * way, so a response without one cannot loop forever.
       */
      if (!items.length) break;
      const pg = data.pagination as { pages?: number } | undefined;
      if (typeof pg?.pages === "number" && page >= pg.pages) break;
    }
    return out;
  }

  /**
   * Everything Zernio can serve, walking historyWindows newest-first and
   * stopping at the first empty window. A window that fails after the
   * first stops the walk and returns what was already fetched; callers
   * upsert, so a short pull refreshes less rather than losing anything.
   * A first-window failure throws so total outages stay loud.
   */
  async analyticsHistory(maxWindows = 10): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const w of historyWindows(new Date(), maxWindows)) {
      let items: Array<Record<string, unknown>>;
      try {
        items = await this.analytics(WINDOW_MAX, w.fromDate, w.toDate);
      } catch (error) {
        if (!out.length) throw error;
        break;
      }
      if (!items.length) break;
      if (items.length >= WINDOW_MAX) {
        console.warn(
          `[zernio] analytics window ${w.fromDate}..${w.toDate} returned the ${items.length}-item cap, older posts in this window may be missing`,
        );
      }
      out.push(...items);
    }
    return out;
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
    /** Thumbnail for the media item (YouTube long-form covers). */
    mediaThumbnail?: string;
    /**
     * Images posted as one carousel, in order.
     *
     * Instagram takes at most 10 and gives every one the aspect ratio of the
     * first. Used instead of `mediaUrl`, never alongside it: a post is either
     * one video or a set of images.
     */
    imageUrls?: string[];
    targets: Array<{
      platform: Platform;
      accountId: string;
      /** Per-platform options, passed through verbatim. */
      platformSpecificData?: Record<string, unknown>;
    }>;
    /** TikTok's options live at the top level of the request body. */
    tiktokSettings?: Record<string, unknown>;
    publishNow?: boolean;
    scheduledFor?: string;
    timezone?: string;
  }): Promise<{ remotePostId: string }> {
    const body: Record<string, unknown> = {
      content: input.content,
      platforms: input.targets.map((t) => ({
        platform: t.platform,
        accountId: t.accountId,
        ...(t.platformSpecificData ? { platformSpecificData: t.platformSpecificData } : {}),
      })),
    };
    const items = mediaItemsFor(input);
    if (items.length) body.mediaItems = items;
    if (input.tiktokSettings) body.tiktokSettings = input.tiktokSettings;
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
    const tagged = accounts.filter((a) => zernioProfileId(a) === profileId);
    // If Zernio ignored the query param and items carry no profile field,
    // we cannot distinguish; return everything rather than nothing.
    if (tagged.length === 0 && accounts.some((a) => zernioProfileId(a) === null)) {
      return accounts;
    }
    return tagged;
  }
}
