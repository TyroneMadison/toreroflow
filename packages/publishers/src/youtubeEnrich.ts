import { GoogleAuthError } from "./youtubeAnalytics";

/**
 * Applying the long-form wizard's metadata to a published video.
 *
 * The fields here are the ones Zernio has no wire for (tags, license,
 * embedding, language, recording date, paid promotion), so they are stored on
 * the target at schedule time and laid onto the video through the channel
 * owner's own OAuth once the publish confirms. Full context in
 * docs/longform-capability-map.md.
 *
 * The dangerous part is videos.update itself: it REPLACES every mutable
 * property of every part named in the request. Send part=snippet with only
 * tags and the video's title is gone; send part=status with only embeddable
 * and a public video can end up reverted. So the current resource is always
 * fetched first and the update is a merge over it, and that merge is a pure
 * function with its own checks, because "the enrichment wiped a client's
 * title" is not a bug report anyone should ever write.
 */

const BASE = "https://www.googleapis.com/youtube/v3";

/** What the wizard stored for later application. */
export interface EnrichFields {
  tags?: string[];
  license?: "standard" | "creativeCommon";
  embeddable?: boolean;
  /** YYYY-MM-DD from the wizard's date input. */
  recordingDate?: string;
  defaultLanguage?: string;
  paidPromotion?: boolean;
}

/**
 * Pulls the enrichable fields out of a target's stored options, or null when
 * the video has nothing waiting. Null is the common case: every short-form
 * post ever scheduled has none of these.
 */
export function enrichFieldsFrom(options: unknown): EnrichFields | null {
  const yt = (options as { youtube?: Record<string, unknown> } | null)?.youtube;
  if (!yt || typeof yt !== "object") return null;
  const out: EnrichFields = {};
  if (Array.isArray(yt.tags) && yt.tags.length) {
    out.tags = yt.tags.filter((t): t is string => typeof t === "string");
  }
  if (yt.license === "standard" || yt.license === "creativeCommon") out.license = yt.license;
  if (typeof yt.embeddable === "boolean") out.embeddable = yt.embeddable;
  if (typeof yt.recordingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(yt.recordingDate)) {
    out.recordingDate = yt.recordingDate;
  }
  if (typeof yt.defaultLanguage === "string" && yt.defaultLanguage) {
    out.defaultLanguage = yt.defaultLanguage;
  }
  if (typeof yt.paidPromotion === "boolean") out.paidPromotion = yt.paidPromotion;
  return Object.keys(out).length ? out : null;
}

/**
 * The YouTube video id inside a watch URL, or null.
 *
 * Needed because the target's remotePostId is Zernio's id, not YouTube's; the
 * platform's own id reaches us either through the confirm poll or, for the
 * catch-up sweep, only as the public URL Zernio reported.
 */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,20})/.exec(
      url,
    );
  return m ? m[1]! : null;
}

/** The slice of the video resource the merge reads and rewrites. */
export interface VideoResource {
  snippet?: {
    title?: string;
    description?: string;
    categoryId?: string;
    tags?: string[];
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status?: Record<string, unknown> & {
    privacyStatus?: string;
    publishAt?: string;
    license?: string;
    embeddable?: boolean;
  };
  recordingDetails?: { recordingDate?: string };
  paidProductPlacementDetails?: { hasPaidProductPlacement?: boolean };
}

/**
 * The update body and the parts it names, merged over the live resource.
 *
 * Rules, each one a scar from how videos.update works:
 *  - A part is named only when a field in it actually changes. Naming a part
 *    "for completeness" widens the blast radius of a mistake for nothing.
 *  - The snippet always carries the fetched title, description and categoryId,
 *    because update replaces the whole part and title/categoryId are required.
 *  - The status is the fetched status with our fields laid over it, minus
 *    publishAt on anything not private: YouTube refuses a publishAt on a
 *    video that is already public, and the fetched copy can still carry the
 *    one it was scheduled with.
 *  - The recording date becomes midnight UTC of the chosen day, because the
 *    API takes a datetime and the wizard deliberately asks only for the day.
 */
export function mergeVideoUpdate(
  videoId: string,
  current: VideoResource,
  fields: EnrichFields,
): { parts: string[]; body: Record<string, unknown> } {
  const parts: string[] = [];
  const body: Record<string, unknown> = { id: videoId };

  if (fields.tags !== undefined || fields.defaultLanguage !== undefined) {
    parts.push("snippet");
    body.snippet = {
      ...current.snippet,
      title: current.snippet?.title ?? "",
      categoryId: current.snippet?.categoryId ?? "22",
      ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
      ...(fields.defaultLanguage !== undefined
        ? { defaultLanguage: fields.defaultLanguage }
        : {}),
    };
  }

  if (fields.license !== undefined || fields.embeddable !== undefined) {
    parts.push("status");
    const status: Record<string, unknown> = {
      ...current.status,
      ...(fields.license !== undefined
        ? { license: fields.license === "standard" ? "youtube" : "creativeCommon" }
        : {}),
      ...(fields.embeddable !== undefined ? { embeddable: fields.embeddable } : {}),
    };
    if (status.privacyStatus !== "private") delete status.publishAt;
    body.status = status;
  }

  if (fields.recordingDate !== undefined) {
    parts.push("recordingDetails");
    body.recordingDetails = { recordingDate: `${fields.recordingDate}T00:00:00Z` };
  }

  if (fields.paidPromotion !== undefined) {
    parts.push("paidProductPlacementDetails");
    body.paidProductPlacementDetails = { hasPaidProductPlacement: fields.paidPromotion };
  }

  return { parts, body };
}

async function googleJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body; the raw text becomes the message below
  }
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } } | null)?.error?.message ??
      text.slice(0, 200) ??
      `google request failed (${res.status})`;
    // 401/403 are consent problems (revoked, or a token minted before the
    // write scope existed), which no retry fixes; only a fresh authorization.
    throw new GoogleAuthError(res.status, message, res.status === 401 || res.status === 403);
  }
  return data as T;
}

/**
 * Fetch, merge, update. Returns the parts applied, [] when nothing needed
 * doing, and throws GoogleAuthError when the credential cannot do it, so the
 * caller can tell "reconnect the channel" apart from "try again tonight".
 */
export async function applyVideoMetadata(
  accessToken: string,
  videoId: string,
  fields: EnrichFields,
): Promise<string[]> {
  const list = await googleJson<{ items?: VideoResource[] }>(
    `${BASE}/videos?id=${encodeURIComponent(videoId)}&part=snippet,status,recordingDetails,paidProductPlacementDetails`,
    accessToken,
  );
  const current = list.items?.[0];
  if (!current) {
    throw new GoogleAuthError(404, `video ${videoId} is not visible to this channel's credential`);
  }

  const { parts, body } = mergeVideoUpdate(videoId, current, fields);
  if (!parts.length) return [];

  await googleJson(`${BASE}/videos?part=${parts.join(",")}`, accessToken, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return parts;
}
