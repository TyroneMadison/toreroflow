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
  slideItems?: Array<{ url: string; type: "image" | "video" }>;
}): Array<Record<string, unknown>> {
  // A mixed carousel names each item's type explicitly, because a video
  // slide declared an image is refused by the platform at publish time.
  if (input.slideItems?.length) {
    return input.slideItems.map((i) => ({ url: i.url, type: i.type }));
  }
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
    /**
     * Zernio's machine-readable error code, when the body carried one.
     *
     * Branching on the human message is how a provider's copy edit becomes our
     * outage. The audio catalog is the first caller that has to tell one 400
     * from another, and it asks for the code.
     */
    public code?: string,
  ) {
    super(message);
  }
}

/** Zernio's code for "this account was not connected through Facebook Login". */
const AUDIO_NEEDS_FACEBOOK = "instagram_audio_requires_facebook_login";

/** One track from Instagram's catalog. */
export interface AudioAsset {
  audioId: string;
  title: string;
  /** Artist for licensed music, the creator's handle for an original sound. */
  artist: string | null;
  /** Track length in seconds, when the catalogue gives one. */
  durationSec: number | null;
  /** Preview audio, expires in roughly 1.5 days. Never store it. */
  previewUrl: string | null;
}

export type AudioCatalogResult =
  | { available: true; tracks: AudioAsset[] }
  | { available: false; reason: "facebook_login_required" };

/**
 * Pulls tracks out of whatever envelope the catalogue arrived in.
 *
 * Zernio is inconsistent about this across endpoints, which zernioProfileId
 * below already works around for a different field. The docs do not name the
 * array for this one and no account of ours could reach it to find out, so
 * every plausible envelope is tried rather than guessing one and shipping a
 * picker that silently renders nothing.
 */
export function audioAssets(data: unknown): AudioAsset[] {
  const d = data as Record<string, unknown> | null;
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(d?.data)
      ? d.data
      : Array.isArray(d?.audio)
        ? d.audio
        : Array.isArray(d?.audios)
          ? d.audios
          : Array.isArray(d?.results)
            ? d.results
            : Array.isArray(d?.items)
              ? d.items
              : // A single-asset fetch returns the object itself, wrapped or bare.
                d && typeof d === "object" && (d.audioId || (d.audio as Record<string, unknown>)?.audioId)
                ? [d.audioId ? d : d.audio]
                : [];
  const out: AudioAsset[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    const id = item.audioId ?? item.id ?? item._id;
    if (typeof id !== "string" || !id) continue;
    const duration = item.durationSec ?? item.duration ?? item.durationMs;
    const secs =
      typeof duration === "number"
        ? // durationMs is the only field that could be milliseconds; a track is
          // never 40 minutes long, so a large number is ms rather than seconds.
          item.durationMs !== undefined || duration > 2400
          ? Math.round(duration / 1000)
          : duration
        : null;
    out.push({
      audioId: id,
      title: typeof item.title === "string" ? item.title : (item.name as string) || "Untitled",
      artist:
        typeof item.artist === "string"
          ? item.artist
          : typeof item.creator === "string"
            ? item.creator
            : typeof item.artistName === "string"
              ? item.artistName
              : null,
      durationSec: secs,
      previewUrl:
        typeof item.downloadUrl === "string"
          ? item.downloadUrl
          : typeof item.previewUrl === "string"
            ? item.previewUrl
            : null,
    });
  }
  return out;
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

/** One inline button inside an auto-DM. Meta renders at most three. */
export interface DmButton {
  /** `phone` is Facebook only; Instagram refuses it. */
  type: "url" | "postback" | "phone";
  /** 20 characters max, enforced by Meta rather than by us. */
  title: string;
  url?: string;
  payload?: string;
  phone?: string;
}

/**
 * What an automation has done. Zernio reports this under two different shapes:
 * the list endpoint sends the full set, while create/get send a three-field
 * summary with different names. Both are normalized by automationStats below,
 * because a screen that reads `triggered` off a create response would show a
 * blank counter that looks like a broken automation rather than a fresh one.
 */
export interface AutomationStats {
  triggered: number;
  dmsSent: number;
  dmsFailed: number;
  uniqueContacts: number;
  /** CTR denominator: DMs that carried a tracked link, not every DM sent. */
  trackedSends: number;
  linkClicks: number;
  uniqueClicks: number;
  /** Messenger only. Instagram emits no delivery receipt, so this stays 0 there. */
  delivered: number;
  read: number;
}

/** A comment-to-DM automation, as Zernio holds it. */
export interface CommentAutomation {
  id: string;
  name: string;
  platform: "instagram" | "facebook";
  trigger: "comment" | "story_reply";
  accountId: string | null;
  /** The platform's own media id. Null for an automation covering every post. */
  platformPostId: string | null;
  postTitle: string | null;
  keywords: string[];
  matchMode: "exact" | "contains" | "word";
  excludeKeywords: string[];
  dmMessage: string;
  buttons: DmButton[];
  commentReply: string | null;
  /** Whether the keywords also answer someone who DMs them instead of commenting. */
  alsoMatchInDms: boolean;
  linkTracking: boolean;
  isActive: boolean;
  stats: AutomationStats;
  createdAt: string | null;
}

/** One trigger, and what became of the DM it was supposed to send. */
export interface AutomationLog {
  id: string;
  commenterId: string | null;
  commenterName: string | null;
  commentText: string | null;
  /** Which door fired. Absent on rows written before Zernio added the field. */
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
  /** Instagram only, and only once the participant has messaged the account. */
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

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Reads either stats shape Zernio sends.
 *
 * The list endpoint sends `triggered`/`dmsSent`/`dmsFailed` plus click and
 * receipt counters; create and get send `totalTriggered`/`totalSent`/
 * `totalFailed` and nothing else. The missing counters are reported as zero
 * rather than guessed, and a fresh automation genuinely has none.
 */
export function automationStats(raw: unknown): AutomationStats {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    triggered: num(s.triggered ?? s.totalTriggered),
    dmsSent: num(s.dmsSent ?? s.totalSent),
    dmsFailed: num(s.dmsFailed ?? s.totalFailed),
    uniqueContacts: num(s.uniqueContacts),
    trackedSends: num(s.trackedSends),
    linkClicks: num(s.linkClicks),
    uniqueClicks: num(s.uniqueClicks),
    delivered: num(s.delivered),
    read: num(s.read),
  };
}

/** Normalizes one automation, whichever endpoint it arrived from. */
export function commentAutomation(raw: unknown): CommentAutomation {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    platform: a.platform === "facebook" ? "facebook" : "instagram",
    trigger: a.trigger === "story_reply" ? "story_reply" : "comment",
    accountId: str(a.accountId),
    platformPostId: str(a.platformPostId),
    postTitle: str(a.postTitle),
    keywords: strs(a.keywords),
    matchMode:
      a.matchMode === "exact" || a.matchMode === "word" ? a.matchMode : "contains",
    excludeKeywords: strs(a.excludeKeywords),
    dmMessage: String(a.dmMessage ?? ""),
    buttons: Array.isArray(a.buttons) ? (a.buttons as DmButton[]) : [],
    commentReply: str(a.commentReply),
    alsoMatchInDms: a.alsoMatchInDms === true,
    // Zernio defaults link tracking on, so an absent field means on.
    linkTracking: a.linkTracking !== false,
    isActive: a.isActive !== false,
    stats: automationStats(a.stats),
    createdAt: str(a.createdAt),
  };
}

/** What creating or updating an automation accepts. */
export interface CommentAutomationInput {
  profileId: string;
  accountId: string;
  name: string;
  dmMessage: string;
  keywords?: string[];
  matchMode?: "exact" | "contains" | "word";
  excludeKeywords?: string[];
  platformPostId?: string;
  postTitle?: string;
  buttons?: DmButton[];
  commentReply?: string;
  alsoMatchInDms?: boolean;
  linkTracking?: boolean;
  clickTag?: string;
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
      const code =
        typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string"
          ? (data as { code: string }).code
          : undefined;
      throw new ZernioError(res.status, message, code);
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

  /**
   * Hosted OAuth page URL for connecting one platform to a profile.
   *
   * `facebookLogin` sends an Instagram connect through Facebook's dialog
   * instead of Instagram's own. The two produce accounts that publish
   * identically, so nothing before this cared which one ran; the audio catalog
   * is the first feature Meta gates on it, and an account connected the
   * ordinary way simply cannot reach it (see instagramAudio below).
   */
  async connectUrl(
    platform: Platform,
    profileId: string,
    opts?: { facebookLogin?: boolean },
  ): Promise<string> {
    const query = `profileId=${encodeURIComponent(profileId)}${
      opts?.facebookLogin ? "&loginMethod=facebook_login" : ""
    }`;
    const data = await this.request<{ authUrl?: string; url?: string }>(
      "GET",
      `/connect/${platform}?${query}`,
    );
    const url = data.authUrl ?? data.url;
    if (!url) throw new ZernioError(500, "zernio connect response missing authUrl");
    return url;
  }

  /**
   * Search Instagram's catalog of audio cleared for third-party publishing.
   *
   * Omit `q` for what is trending. `audioType` splits licensed music from
   * other creators' original sounds; they are different catalogues behind one
   * endpoint.
   *
   * Returns unavailable rather than throwing when the account cannot reach the
   * catalogue, because that is a fact about the connection and not a failure
   * of the request. Meta serves audio only to Instagram accounts connected
   * through Facebook Login, and an account connected the ordinary way publishes
   * reels perfectly well while every audio call 400s. Both of ours were in that
   * state when this was written, so the unavailable path is the one that runs
   * until an account is reconnected, and it has to be a state the UI can draw
   * rather than an error it has to catch.
   */
  async instagramAudio(
    accountId: string,
    opts: { audioType: "music" | "original_sound"; q?: string },
  ): Promise<AudioCatalogResult> {
    const query = new URLSearchParams({ audioType: opts.audioType });
    if (opts.q?.trim()) query.set("q", opts.q.trim());
    try {
      const data = await this.request<unknown>(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/instagram/audio?${query}`,
      );
      return { available: true, tracks: audioAssets(data) };
    } catch (error) {
      if (error instanceof ZernioError && error.code === AUDIO_NEEDS_FACEBOOK) {
        return { available: false, reason: "facebook_login_required" };
      }
      throw error;
    }
  }

  /**
   * Re-read one track, which is how a stored audioId is checked before use.
   *
   * Preview URLs expire in about a day and a half, and a scheduled post can
   * outlive that by a week, so the preview a picker stored is stale long before
   * the post runs. Returns null when the track is gone from the catalogue.
   */
  async instagramAudioById(accountId: string, audioId: string): Promise<AudioAsset | null> {
    try {
      const data = await this.request<unknown>(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/instagram/audio/${encodeURIComponent(audioId)}`,
      );
      return audioAssets(data)[0] ?? null;
    } catch (error) {
      if (error instanceof ZernioError && (error.status === 404 || error.code === AUDIO_NEEDS_FACEBOOK)) {
        return null;
      }
      throw error;
    }
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
    /** Mixed image/video carousel items, in order, each with its type. */
    slideItems?: Array<{ url: string; type: "image" | "video" }>;
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
   * What actually happened to a post, per platform.
   *
   * createPost returning an id means the provider ACCEPTED the post, not that
   * a platform published it. The two were treated as the same thing, and the
   * gap is not academic: a client's Reel was accepted twice, failed inside the
   * provider both times with "Publishing failed due to max retries reached",
   * and the calendar showed Posted with a green tick for three days.
   *
   * Statuses seen in the wild: "published", "failed", "pending", "processing".
   * Anything unrecognised is reported verbatim rather than mapped, so a new one
   * shows up as itself instead of being quietly called a success.
   */
  async postStatus(remotePostId: string): Promise<{
    status: string;
    platforms: Array<{
      platform: string;
      accountId: string | null;
      status: string;
      error: string | null;
      url: string | null;
    }>;
  }> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/posts/${encodeURIComponent(remotePostId)}`,
    );
    const post = ((data.post ?? data) ?? {}) as Record<string, unknown>;
    const entries = Array.isArray(post.platforms)
      ? (post.platforms as Array<Record<string, unknown>>)
      : [];
    return {
      status: typeof post.status === "string" ? post.status : "unknown",
      platforms: entries.map((e) => {
        // accountId arrives either as a bare id or as the populated account.
        const acct = e.accountId;
        const accountId =
          typeof acct === "string"
            ? acct
            : typeof (acct as { _id?: unknown })?._id === "string"
              ? ((acct as { _id: string })._id)
              : null;
        return {
          platform: typeof e.platform === "string" ? e.platform : "unknown",
          accountId,
          status: typeof e.status === "string" ? e.status : "unknown",
          error:
            typeof e.errorMessage === "string"
              ? e.errorMessage
              : typeof e.error === "string"
                ? e.error
                : null,
          url: typeof e.platformPostUrl === "string" ? e.platformPostUrl : null,
        };
      }),
    };
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

  // ---------------------------------------------------------------------------
  // Comment-to-DM automations.
  //
  // Zernio runs these itself: it holds Meta's comment webhook, matches the
  // keyword and sends the DM. Nothing here executes an automation, and there is
  // no webhook for us to receive. We author them and read back what they did,
  // which is why none of this is mirrored into our database.
  // ---------------------------------------------------------------------------

  /** Every automation on one client's profile, with its counters. */
  async listCommentAutomations(profileId: string): Promise<CommentAutomation[]> {
    const data = await this.request<{ automations?: unknown }>(
      "GET",
      `/comment-automations?profileId=${encodeURIComponent(profileId)}`,
    );
    return Array.isArray(data.automations) ? data.automations.map(commentAutomation) : [];
  }

  /**
   * Creates one, then re-reads it from the list before handing it back.
   *
   * Measured against the live API: the create response omits accountId and
   * postTitle even when both were sent, while the list carries them. So the
   * object create returns describes a campaign that looks account-less and
   * unscoped, and anything trusting it would decide this campaign belongs to
   * no video. syncDmStats reads the list and was never exposed, but a caller
   * reasonably reading the create response would be, and that is the kind of
   * difference nobody finds until a client's DM counts are quietly missing.
   *
   * One extra read on a rare action to make the return value mean what it says.
   * Falls back to the create response if the re-read cannot find it, because a
   * campaign that was created is still created.
   */
  async createCommentAutomation(input: CommentAutomationInput): Promise<CommentAutomation> {
    const data = await this.request<{ automation?: unknown }>(
      "POST",
      "/comment-automations",
      input,
    );
    const created = commentAutomation(data.automation);
    if (!created.id) return created;
    const listed = await this.listCommentAutomations(input.profileId);
    return listed.find((c) => c.id === created.id) ?? created;
  }

  async updateCommentAutomation(
    automationId: string,
    patch: Partial<Omit<CommentAutomationInput, "profileId" | "accountId">> & {
      isActive?: boolean;
    },
  ): Promise<CommentAutomation> {
    const data = await this.request<{ automation?: unknown }>(
      "PATCH",
      `/comment-automations/${encodeURIComponent(automationId)}`,
      patch,
    );
    return commentAutomation(data.automation);
  }

  async deleteCommentAutomation(automationId: string): Promise<void> {
    await this.request("DELETE", `/comment-automations/${encodeURIComponent(automationId)}`);
  }

  /**
   * Who triggered an automation and whether their DM arrived.
   *
   * This is the lead list: every row is a person who commented the keyword,
   * with the handle needed to find them in the inbox.
   */
  async automationLogs(
    automationId: string,
    opts: { limit?: number; skip?: number } = {},
  ): Promise<AutomationLog[]> {
    const query = new URLSearchParams({ limit: String(Math.min(opts.limit ?? 50, 200)) });
    if (opts.skip) query.set("skip", String(opts.skip));
    const data = await this.request<{ logs?: unknown }>(
      "GET",
      `/comment-automations/${encodeURIComponent(automationId)}/logs?${query}`,
    );
    const rows = Array.isArray(data.logs) ? data.logs : [];
    return rows.map((raw) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      const source = l.source;
      return {
        id: String(l.id ?? ""),
        commenterId: str(l.commenterId),
        commenterName: str(l.commenterName),
        commentText: str(l.commentText),
        source:
          source === "comment" || source === "story_reply" || source === "dm" ? source : null,
        status: (str(l.status) ?? "sent") as AutomationLog["status"],
        error: str(l.error),
        createdAt: str(l.createdAt),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Inbox. Read-through: Zernio is the store, we never copy a thread locally.
  // ---------------------------------------------------------------------------

  /** Open threads on a profile, newest activity first. */
  async conversations(
    profileId: string,
    opts: { platform?: string; accountId?: string; limit?: number } = {},
  ): Promise<InboxConversation[]> {
    const query = new URLSearchParams({
      profileId,
      limit: String(Math.min(opts.limit ?? 50, 100)),
    });
    if (opts.platform) query.set("platform", opts.platform);
    if (opts.accountId) query.set("accountId", opts.accountId);
    const data = await this.request<{ conversations?: unknown; data?: unknown }>(
      "GET",
      `/inbox/conversations?${query}`,
    );
    const rows = data.conversations ?? data.data;
    if (!Array.isArray(rows)) return [];
    return rows.map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      const ig = (c.instagramProfile ?? null) as InboxConversation["instagramProfile"];
      return {
        id: String(c.id ?? ""),
        platform: String(c.platform ?? ""),
        accountId: String(c.accountId ?? ""),
        accountUsername: str(c.accountUsername),
        participantId: str(c.participantId),
        participantName: str(c.participantName),
        participantPicture: str(c.participantPicture),
        lastMessage: str(c.lastMessage),
        updatedTime: str(c.updatedTime),
        unreadCount: num(c.unreadCount),
        instagramProfile: ig && typeof ig === "object" ? ig : null,
      };
    });
  }

  /**
   * One thread, oldest message first.
   *
   * Attachment URLs on Instagram and Facebook expire, so they are handed
   * straight to the screen and never stored; attachmentUrl below re-reads one
   * when an old message has to be drawn again.
   */
  async conversationMessages(
    conversationId: string,
    accountId: string,
    limit = 50,
  ): Promise<InboxMessage[]> {
    const query = new URLSearchParams({ accountId, limit: String(Math.min(limit, 100)) });
    const data = await this.request<{ messages?: unknown }>(
      "GET",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
    );
    const rows = Array.isArray(data.messages) ? data.messages : [];
    return rows.map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const attachments = Array.isArray(m.attachments) ? m.attachments : [];
      return {
        id: String(m.id ?? ""),
        message: String(m.message ?? ""),
        senderId: str(m.senderId),
        senderName: str(m.senderName),
        direction: m.direction === "outgoing" ? "outgoing" : "incoming",
        createdAt: str(m.createdAt),
        attachments: attachments.map((a) => {
          const at = (a ?? {}) as Record<string, unknown>;
          return { type: str(at.type), url: str(at.url) };
        }),
      };
    });
  }

  /** Reply in a thread as the connected account. */
  async sendMessage(
    conversationId: string,
    input: { accountId: string; message: string; buttons?: DmButton[] },
  ): Promise<void> {
    await this.request(
      "POST",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      input,
    );
  }

  /**
   * A working URL for an attachment whose original has expired.
   *
   * Meta's media links die within days, so a thread reopened next week draws
   * broken images unless each one is re-read at display time. Returns null when
   * the attachment is gone rather than throwing, because one dead image should
   * not take down the thread around it.
   */
  async attachmentUrl(
    conversationId: string,
    messageId: string,
    index: number,
    accountId: string,
  ): Promise<string | null> {
    try {
      const data = await this.request<{ url?: unknown }>(
        "GET",
        `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(
          messageId,
        )}/attachments/${index}?accountId=${encodeURIComponent(accountId)}&format=json`,
      );
      return str(data.url);
    } catch (error) {
      if (error instanceof ZernioError && error.status === 404) return null;
      throw error;
    }
  }
}
