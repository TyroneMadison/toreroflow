import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed links for everything under /files/.
 *
 * The storage directory holds invoices with the agency's EIN on them, tax
 * exports with a year of revenue, client videos, and the game plans written for
 * each brand. Until now it was served by fastifyStatic with no auth hook in
 * front of it at all, which was fine while the only way to reach it was
 * 127.0.0.1 and is a data leak the moment the API answers on a public domain.
 *
 * Signed URLs rather than a bearer token, because the three things that fetch
 * these files cannot send a header:
 *
 *   - <img> and <video> in the desktop webview set their own requests
 *   - openExternal hands the URL to the operating system's browser, which has
 *     never seen the app's token
 *   - a report PDF opened from a link has the same problem
 *
 * A query string travels through all three. The cost is that a signed link is
 * a bearer credential for one file until it expires, which is why the expiry
 * is days rather than months and why the signature covers the path: a link to
 * an invoice cannot be edited into a link to a video.
 */

/**
 * How long a link stays good.
 *
 * Long enough that a game plan opened in a browser tab still loads tomorrow,
 * short enough that a URL copied out of a log or a browser history stops
 * working well before anyone finds it. The desktop mints links fresh on every
 * screen load, so this is not a session length.
 */
export const FILE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expiries are rounded up to the hour.
 *
 * Without this every call would mint a slightly different URL, and a different
 * URL is a cache miss: every thumbnail on the calendar would be refetched on
 * every render. Rounding means a file signed twice in the same hour gets the
 * same link, so the webview caches it, while the link still rotates through the
 * day. Content that changes under a stable key adds its own `v` parameter,
 * which is outside the signature and therefore free to vary.
 */
const EXPIRY_GRANULARITY_MS = 60 * 60 * 1000;

/** Query parameter names, short because these end up in visible URLs. */
const EXPIRY_PARAM = "e";
const SIGNATURE_PARAM = "s";

/**
 * The storage key, normalised the way the signature and the file lookup both
 * have to see it.
 *
 * A leading slash, a doubled slash or a %2F escape would otherwise let the
 * same file be addressed two ways: one that was signed and one that was not.
 */
function canonical(storageKey: string): string {
  return decodeURIComponent(storageKey).replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function sign(storageKey: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${canonical(storageKey)}:${expiresAt}`)
    .digest("base64url");
}

/**
 * A path under /files/ that will be accepted, valid until it is not.
 *
 * Returns the path only, not the origin: the desktop already prefixes its own
 * API address, and hardcoding one here would break the moment the app talks to
 * the cloud instead of localhost.
 */
export function signedFilePath(
  storageKey: string,
  secret: string,
  now: number = Date.now(),
): string {
  const key = canonical(storageKey);
  const expiresAt =
    Math.ceil((now + FILE_LINK_TTL_MS) / EXPIRY_GRANULARITY_MS) * EXPIRY_GRANULARITY_MS;
  const params = new URLSearchParams({
    [EXPIRY_PARAM]: String(expiresAt),
    [SIGNATURE_PARAM]: sign(key, expiresAt, secret),
  });
  // The key is a path, so its slashes stay slashes; only the segments are
  // escaped. encodeURIComponent would turn the whole thing into one segment.
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `/files/${encoded}?${params.toString()}`;
}

export type FileLinkVerdict = "ok" | "unsigned" | "expired" | "bad-signature";

/**
 * Whether a request for a file may be served.
 *
 * Constant-time comparison, because a signature check that returns early on
 * the first wrong byte tells an attacker how much of a guess was right.
 */
export function verifyFileLink(
  storageKey: string,
  query: { e?: unknown; s?: unknown },
  secret: string,
  now: number = Date.now(),
): FileLinkVerdict {
  const expiresRaw = typeof query.e === "string" ? query.e : "";
  const provided = typeof query.s === "string" ? query.s : "";
  if (!expiresRaw || !provided) return "unsigned";

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return "bad-signature";

  const expected = sign(storageKey, expiresAt, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Compare before checking the clock. Length-mismatched buffers cannot go to
  // timingSafeEqual, and answering "expired" to an unsigned guess would say
  // whether the path exists.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad-signature";
  if (now > expiresAt) return "expired";
  return "ok";
}
