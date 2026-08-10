/**
 * Inlines video thumbnails into the report as data URIs.
 *
 * Instagram's CDN links carry an expiry (measured at roughly four days), so a
 * report that sits at a permanent URL would show broken images to a client
 * within a week if it merely linked them. Embedding also keeps the page
 * working offline and means the PDF renderer needs no network at print time.
 *
 * Failures are silent by design: a missing thumbnail leaves the card's
 * gradient in place, which looks intentional, whereas a broken image icon in
 * a client-facing document does not.
 */

const FETCH_TIMEOUT_MS = 8000;
/** Skip anything unreasonably large rather than bloat the page. */
const MAX_BYTES = 600_000;

/**
 * YouTube serves several sizes from one id, and they differ in shape as well
 * as resolution. `hqdefault` and `sddefault` are 4:3 with the 16:9 frame
 * letterboxed inside, so they render with black bars in a wide cover.
 * `mqdefault` is a true 16:9 crop at 320x180, which fills the card cleanly
 * and is ample for its size.
 */
export function normalizeThumbUrl(url: string): string {
  if (!url.includes("ytimg.com")) return url;
  return url.replace(
    /\/(default|hqdefault|mqdefault|sddefault|maxresdefault|standard)\.jpg/,
    "/mqdefault.jpg",
  );
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walks the report payload and replaces every `thumb` URL with a data URI.
 *
 * The same video appears across periods and sections, so results are cached
 * per URL and each image is fetched once.
 */
export async function embedThumbnails(
  payloads: Array<Record<string, unknown>>,
  log?: (msg: string) => void,
): Promise<{ embedded: number; failed: number }> {
  const cache = new Map<string, string | null>();
  let embedded = 0;
  let failed = 0;

  const resolve = async (raw: string): Promise<string | null> => {
    const url = normalizeThumbUrl(raw);
    if (cache.has(url)) return cache.get(url) ?? null;
    const data = await fetchAsDataUri(url);
    cache.set(url, data);
    if (data) embedded += 1;
    else failed += 1;
    return data;
  };

  for (const payload of payloads) {
    const top = payload.topContent as { items?: Array<Record<string, unknown>> } | undefined;
    for (const item of top?.items ?? []) {
      const raw = item.thumb;
      if (typeof raw === "string" && raw.startsWith("http")) {
        const data = await resolve(raw);
        if (data) item.thumb = data;
        else delete item.thumb;
      }
    }

    const platforms = payload.platforms as Array<Record<string, unknown>> | undefined;
    for (const p of platforms ?? []) {
      const tp = p.topPost as Record<string, unknown> | undefined;
      const raw = tp?.thumb;
      if (tp && typeof raw === "string" && raw.startsWith("http")) {
        const data = await resolve(raw);
        if (data) tp.thumb = data;
        else delete tp.thumb;
      }
    }

    // The Video Breakdown cards: the thumbnail IS the card background, and an
    // Instagram CDN link dies in about four days, so skipping these would rot
    // every card on the permanent page while the sections above stayed fine.
    const videos = payload.videos as Array<Record<string, unknown>> | undefined;
    for (const v of videos ?? []) {
      const raw = v.thumb;
      if (typeof raw === "string" && raw.startsWith("http")) {
        const data = await resolve(raw);
        if (data) v.thumb = data;
        else v.thumb = null;
      }
    }
  }

  log?.(`[reports] thumbnails embedded: ${embedded}, unavailable: ${failed}`);
  return { embedded, failed };
}
