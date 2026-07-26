const BASE = "https://www.googleapis.com/youtube/v3";

export class YouTubeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface YouTubeVideo {
  platformVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  url: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  durationSec: number | null;
}

/** ISO 8601 duration ("PT4M13S") to seconds. */
export function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total =
    (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
  return total > 0 ? total : null;
}

/**
 * Reads a channel's full public catalogue through the YouTube Data API.
 *
 * Only an API key is needed, not OAuth, because everything used here is
 * public channel data. View counts are lifetime totals straight from
 * YouTube, which is what makes all-time rankings possible; the publishing
 * provider only keeps a recent window.
 */
export class YouTubeProvider {
  constructor(private readonly apiKey: string) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, key: this.apiKey }).toString();
    const res = await fetch(`${BASE}${path}?${qs}`);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body; fall through to the error path
    }
    if (!res.ok) {
      const reason =
        typeof data === "object" && data !== null && "error" in data
          ? String(
              (data as { error?: { message?: string } }).error?.message ??
                `youtube request failed (${res.status})`,
            )
          : text.slice(0, 200) || `youtube request failed (${res.status})`;
      throw new YouTubeError(res.status, reason);
    }
    return data as T;
  }

  /**
   * Resolve a handle ("@name", "name") or channel id to the channel id and
   * its uploads playlist. Handles are tried first via the handle-aware
   * lookup, then the legacy username field, then search as a last resort.
   */
  async resolveChannel(
    handleOrId: string,
  ): Promise<{ channelId: string; uploadsPlaylistId: string; title: string }> {
    const handle = handleOrId.trim().replace(/^@/, "");
    type ChannelResp = {
      items?: Array<{
        id: string;
        snippet?: { title?: string };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }>;
    };

    const attempts: Array<Record<string, string>> = [
      // A raw channel id starts with UC and is 24 chars.
      ...(/^UC[\w-]{22}$/.test(handle) ? [{ part: "snippet,contentDetails", id: handle }] : []),
      { part: "snippet,contentDetails", forHandle: `@${handle}` },
      { part: "snippet,contentDetails", forUsername: handle },
    ];

    for (const params of attempts) {
      try {
        const data = await this.get<ChannelResp>("/channels", params);
        const item = data.items?.[0];
        const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
        if (item && uploads) {
          return { channelId: item.id, uploadsPlaylistId: uploads, title: item.snippet?.title ?? handle };
        }
      } catch (err) {
        // An unknown parameter on older API surfaces is not fatal; try the next.
        if (err instanceof YouTubeError && err.status !== 400) throw err;
      }
    }

    // Fall back to search, which costs more quota but copes with vanity URLs.
    const search = await this.get<{ items?: Array<{ id?: { channelId?: string } }> }>("/search", {
      part: "snippet",
      type: "channel",
      q: handle,
      maxResults: "1",
    });
    const found = search.items?.[0]?.id?.channelId;
    if (!found) throw new YouTubeError(404, `no YouTube channel found for "${handleOrId}"`);
    const data = await this.get<ChannelResp>("/channels", {
      part: "snippet,contentDetails",
      id: found,
    });
    const item = data.items?.[0];
    const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
    if (!item || !uploads) throw new YouTubeError(404, "channel has no uploads playlist");
    return { channelId: item.id, uploadsPlaylistId: uploads, title: item.snippet?.title ?? handle };
  }

  /** Every video id in the uploads playlist, newest first. */
  async listVideoIds(uploadsPlaylistId: string, max = 5000): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.get<{
        items?: Array<{ contentDetails?: { videoId?: string } }>;
        nextPageToken?: string;
      }>("/playlistItems", {
        part: "contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of data.items ?? []) {
        const id = item.contentDetails?.videoId;
        if (id) ids.push(id);
      }
      pageToken = data.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids;
  }

  /** Statistics and metadata, batched 50 ids per request. */
  async getVideos(ids: string[]): Promise<YouTubeVideo[]> {
    const out: YouTubeVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const data = await this.get<{
        items?: Array<{
          id: string;
          snippet?: {
            title?: string;
            publishedAt?: string;
            thumbnails?: Record<string, { url?: string }>;
          };
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
          contentDetails?: { duration?: string };
        }>;
      }>("/videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") });

      for (const v of data.items ?? []) {
        const thumbs = v.snippet?.thumbnails ?? {};
        const thumb =
          thumbs.maxres?.url ?? thumbs.standard?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;
        out.push({
          platformVideoId: v.id,
          title: v.snippet?.title ?? "(untitled)",
          thumbnailUrl: thumb,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          publishedAt: v.snippet?.publishedAt ?? new Date(0).toISOString(),
          views: Number(v.statistics?.viewCount ?? 0) || 0,
          likes: Number(v.statistics?.likeCount ?? 0) || 0,
          comments: Number(v.statistics?.commentCount ?? 0) || 0,
          durationSec: parseIsoDuration(v.contentDetails?.duration),
        });
      }
    }
    return out;
  }

  /** Whole catalogue for a handle or channel id, in one call. */
  async allVideosForChannel(handleOrId: string): Promise<{
    channelId: string;
    channelTitle: string;
    videos: YouTubeVideo[];
  }> {
    const { channelId, uploadsPlaylistId, title } = await this.resolveChannel(handleOrId);
    const ids = await this.listVideoIds(uploadsPlaylistId);
    const videos = await this.getVideos(ids);
    return { channelId, channelTitle: title, videos };
  }
}
