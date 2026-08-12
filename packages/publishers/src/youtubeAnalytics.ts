/**
 * Direct YouTube access: the channel owner's own OAuth, and the Analytics API
 * that only that OAuth can reach.
 *
 * This is a different product from `youtube.ts` beside it, which reads public
 * catalogue data with an API key. Views, likes and comments are public and
 * come from there. Shares, watch time and subscribers gained are not public at
 * all, and no API key on earth returns them: they need the channel owner to
 * authorize, once, through a link the app generates.
 *
 * What that unlocks, measured against the live account before any of this was
 * written: shares arrived on 0 of 243 YouTube posts through the provider, and
 * watch time and subscribers gained on none of any platform's 800. Subscribers
 * gained is the improvements-list item that has had no answer anywhere until
 * now.
 *
 * Nothing here can post, delete or modify anything. Both scopes are readonly
 * and the request paths are all GETs against reporting endpoints.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

/**
 * Read only, and both of them.
 *
 * yt-analytics.readonly is the one that matters; youtube.readonly is what lets
 * us ask which channel just authorized, so the credential can be matched to the
 * right account instead of trusting whoever clicked.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export class GoogleAuthError extends Error {
  constructor(
    public status: number,
    message: string,
    /** True when the client withdrew consent. Only a fresh authorization fixes it. */
    public revoked = false,
  ) {
    super(message);
  }
}

/** What every call needs. The refresh grant needs nothing more than this. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** What the authorization round trip needs on top. */
export interface GoogleCredentials extends GoogleClient {
  /** Must match a URI registered in the Google console, character for character. */
  redirectUri: string;
}

/**
 * The consent URL the channel owner opens.
 *
 * `access_type=offline` with `prompt=consent` is what produces a refresh token,
 * and the second half is not optional: Google returns a refresh token only on
 * the FIRST authorization for a given client and account, and sends none at all
 * on every subsequent one unless consent is forced. Without it, a client who
 * reconnects after a revoke hands back an access token good for an hour and
 * nothing that survives it, and the sync dies quietly the next morning.
 */
export function googleAuthUrl(creds: GoogleCredentials, state: string): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function tokenRequest(
  body: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; scope?: string; expires_in?: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON body; the error path below reports the raw text instead.
  }
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : "";
    const detail =
      typeof data.error_description === "string"
        ? data.error_description
        : text.slice(0, 200) || `google token request failed (${res.status})`;
    // invalid_grant on a refresh means the client revoked access, changed their
    // password, or the token went unused past its expiry. Every one of those
    // needs a human to authorize again, so it is worth telling apart from a
    // network blip that a retry would fix.
    throw new GoogleAuthError(res.status, detail, code === "invalid_grant");
  }
  return data as { access_token: string; refresh_token?: string; scope?: string };
}

export interface GoogleGrant {
  refreshToken: string;
  accessToken: string;
  scopes: string[];
}

/** Trade the code Google put on the callback URL for a lasting credential. */
export async function exchangeCode(
  creds: GoogleCredentials,
  code: string,
): Promise<GoogleGrant> {
  const data = await tokenRequest({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
    grant_type: "authorization_code",
  });
  if (!data.refresh_token) {
    // Reachable when prompt=consent is dropped, or the account already granted
    // this client and Google decided we did not need telling twice. Failing
    // loudly here is the only way it does not become a mystery next week.
    throw new GoogleAuthError(
      200,
      "Google returned no refresh token. Remove Toreroflow at myaccount.google.com/permissions and authorize again.",
    );
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    scopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : [],
  };
}

/**
 * An access token, minted from the stored refresh token.
 *
 * Access tokens last an hour, which is why none is ever stored: a column
 * holding one is stale more often than not, and refreshing on demand is both
 * simpler and always right. This is also why there is no token refresh cron
 * job; there is nothing for it to keep alive.
 *
 * Takes the client only, not the full credentials. Google's refresh grant does
 * not carry a redirect_uri, so the process doing the refreshing does not need
 * to know one, which is what keeps the worker out of the redirect's business
 * entirely.
 */
export async function accessTokenFrom(
  creds: GoogleClient,
  refreshToken: string,
): Promise<string> {
  const data = await tokenRequest({
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "refresh_token",
  });
  return data.access_token;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Fall through to the error path with the raw body.
  }
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String(
            (data as { error?: { message?: string } }).error?.message ??
              `google request failed (${res.status})`,
          )
        : text.slice(0, 200) || `google request failed (${res.status})`;
    throw new GoogleAuthError(res.status, message);
  }
  return data as T;
}

export interface AuthorizedChannel {
  channelId: string;
  title: string;
}

/**
 * Which channel just authorized.
 *
 * Asked rather than assumed. A client with several Google accounts picks one on
 * the consent screen, and picking the wrong one is the single most likely thing
 * to go wrong in this whole flow. Reading the id back means the mismatch is
 * caught at the callback and named, instead of producing a connection that
 * quietly syncs somebody else's channel into this client's numbers.
 */
export async function authorizedChannel(accessToken: string): Promise<AuthorizedChannel> {
  const data = await getJson<{
    items?: Array<{ id?: string; snippet?: { title?: string } }>;
  }>(`${DATA_API}/channels?part=snippet&mine=true`, accessToken);
  const item = data.items?.[0];
  if (!item?.id) {
    throw new GoogleAuthError(
      404,
      "That Google account has no YouTube channel. Authorize with the account that owns the channel.",
    );
  }
  return { channelId: item.id, title: item.snippet?.title ?? "" };
}

/* ---- the Analytics report ---- */

/**
 * How many video ids ride one report request.
 *
 * The filter accepts up to 500, but a report keyed on the video dimension
 * returns at most 200 rows, so asking about more than 200 videos would silently
 * drop the rest. The smaller of the two limits is the real one.
 */
export const REPORT_BATCH = 200;

/** The metrics asked for, in one place so the parser and the request agree. */
export const REPORT_METRICS = [
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
] as const;

export interface VideoAnalytics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  estimatedMinutesWatched: number | null;
  averageViewDuration: number | null;
  averageViewPercentage: number | null;
  subscribersGained: number | null;
}

export interface AnalyticsReport {
  columnHeaders?: Array<{ name?: string }>;
  rows?: unknown[][];
}

/**
 * A report body to one entry per video.
 *
 * Read by column NAME rather than by position. The API documents the order it
 * returns metrics in and has never changed it, but a positional parse that is
 * wrong is wrong silently: shares would be read as watch time, land in the
 * store, and print on a client's report as a plausible number. The header row
 * is right there, so there is no reason to guess.
 *
 * A row whose video dimension is missing is dropped rather than guessed at.
 */
export function parseReport(report: AnalyticsReport): Map<string, VideoAnalytics> {
  const headers = (report.columnHeaders ?? []).map((h) => h?.name ?? "");
  const videoIndex = headers.indexOf("video");
  const out = new Map<string, VideoAnalytics>();
  if (videoIndex < 0) return out;

  const at = (row: unknown[], name: string): number | null => {
    const i = headers.indexOf(name);
    if (i < 0) return null;
    const v = row[i];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  for (const row of report.rows ?? []) {
    const id = row[videoIndex];
    if (typeof id !== "string" || !id) continue;
    out.set(id, {
      views: at(row, "views"),
      likes: at(row, "likes"),
      comments: at(row, "comments"),
      shares: at(row, "shares"),
      estimatedMinutesWatched: at(row, "estimatedMinutesWatched"),
      averageViewDuration: at(row, "averageViewDuration"),
      averageViewPercentage: at(row, "averageViewPercentage"),
      subscribersGained: at(row, "subscribersGained"),
    });
  }
  return out;
}

/** The store fields one video's analytics contributes. */
export interface PlatformMetricFields {
  shares?: number;
  follows?: number;
  avgWatchSec?: number | null;
  totalWatchSec?: number | null;
}

/**
 * One video's report entry to the fields written on its store row.
 *
 * Only the fields YouTube's own API answers for. Views, likes and comments are
 * deliberately absent even though the report returns them: the Data API
 * catalogue sync already writes those as lifetime totals straight from YouTube,
 * while the Analytics figures cover a date range and lag roughly two days
 * behind. Two sources for one number is how a video's view count starts moving
 * backwards.
 *
 * Zero handling follows ZERO_IS_UNMEASURED in packages/core, which is a ruling
 * rather than a preference:
 *
 *  - watch time of zero on a video with views is a metric YouTube has not
 *    computed yet, not a video nobody watched, so it stores as absent
 *  - shares and subscribers gained of zero are real results. Plenty of videos
 *    genuinely gain no subscribers, and printing "Subscribers gained 0" for
 *    them is the honest thing to do
 */
export function toStoreFields(a: VideoAnalytics): PlatformMetricFields {
  const fields: PlatformMetricFields = {};
  if (a.shares != null) fields.shares = a.shares;
  if (a.subscribersGained != null) fields.follows = a.subscribersGained;
  if (a.averageViewDuration != null && a.averageViewDuration > 0) {
    fields.avgWatchSec = a.averageViewDuration;
  }
  if (a.estimatedMinutesWatched != null && a.estimatedMinutesWatched > 0) {
    fields.totalWatchSec = a.estimatedMinutesWatched * 60;
  }
  return fields;
}

/** YYYY-MM-DD in UTC, the only date format the Analytics API accepts. */
export function reportDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Split ids into request-sized batches. */
export function batches<T>(items: readonly T[], size = REPORT_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Lifetime analytics for a batch of the channel's own videos.
 *
 * `ids=channel==MINE` scopes the whole report to the authorizing channel, so
 * this cannot read anyone else's data even if it were handed someone else's
 * video id.
 *
 * The window runs from the earliest video asked about to today. Today's end is
 * the honest one to use despite the API's roughly two-day processing lag: the
 * figures are cumulative, so a lagging edge means the newest videos are counted
 * slightly low for two days and then catch up by themselves.
 */
export async function videoAnalytics(
  accessToken: string,
  videoIds: readonly string[],
  startDate: Date,
  endDate: Date,
): Promise<Map<string, VideoAnalytics>> {
  if (!videoIds.length) return new Map();
  const params = new URLSearchParams({
    ids: "channel==MINE",
    startDate: reportDate(startDate),
    endDate: reportDate(endDate),
    dimensions: "video",
    metrics: REPORT_METRICS.join(","),
    filters: `video==${videoIds.join(",")}`,
    maxResults: String(REPORT_BATCH),
  });
  const report = await getJson<AnalyticsReport>(`${ANALYTICS_API}?${params.toString()}`, accessToken);
  return parseReport(report);
}
