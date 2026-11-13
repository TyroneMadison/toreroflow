/**
 * Creator channel links for the Ideas area. A link is whatever the operator
 * pasted; this turns it into a platform, a handle and one normalised form so
 * the same channel typed two ways is cached once.
 */

export const CREATOR_LINK_CAP = 15;

export type CreatorPlatform = "youtube" | "instagram" | "tiktok" | "other";

export interface CreatorLink {
  /** Normalised, e.g. "youtube.com/@carguy". */
  url: string;
  platform: CreatorPlatform;
  /** "@carguy", or the channel id for /channel/ links. */
  handle: string;
}

export function parseCreatorLink(raw: string): CreatorLink | null {
  let t = raw.trim();
  if (!t) return null;
  if (/^@[\w.\-]+$/.test(t)) return { url: `youtube.com/${t.toLowerCase()}`, platform: "youtube", handle: t };
  t = t.replace(/^https?:\/\//i, "").replace(/^(www\.|m\.)/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const [host, ...rest] = t.split("/");
  const h = (host ?? "").toLowerCase();
  const first = rest[0] ?? "";
  if (h === "youtube.com" || h === "youtu.be") {
    if (first.startsWith("@")) return { url: `youtube.com/${first.toLowerCase()}`, platform: "youtube", handle: first };
    if ((first === "channel" || first === "c" || first === "user") && rest[1]) {
      return { url: `youtube.com/${first}/${rest[1]}`, platform: "youtube", handle: rest[1] };
    }
    return null;
  }
  if (h === "instagram.com" && first) {
    return { url: `instagram.com/${first.toLowerCase()}`, platform: "instagram", handle: `@${first.replace(/^@/, "")}` };
  }
  if (h === "tiktok.com" && first) {
    const name = first.replace(/^@/, "");
    return { url: `tiktok.com/@${name.toLowerCase()}`, platform: "tiktok", handle: `@${name}` };
  }
  if (h.includes(".") && first) return { url: `${h}/${rest.join("/")}`, platform: "other", handle: first };
  return null;
}

/** Tidies a list: trims, drops blanks and duplicates (same normalised link), caps at CREATOR_LINK_CAP (15). */
export function cleanCreatorLinks(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const t = raw.trim().slice(0, 300);
    if (!t) continue;
    const key = parseCreatorLink(t)?.url ?? t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= CREATOR_LINK_CAP) break;
  }
  return out;
}

/**
 * Rough model cost in US cents, from token counts. Deliberately on the high
 * side so the per-run cap stops a run early rather than late.
 */
export const SUPERGEN_PRICE = { inputPerM: 1500, outputPerM: 7500 };

export function costCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * SUPERGEN_PRICE.inputPerM + outputTokens * SUPERGEN_PRICE.outputPerM) / 1_000_000,
  );
}

/** Super generate per-run cap bounds, in cents. */
export const SUPERGEN_CAP_MIN = 10;
export const SUPERGEN_CAP_MAX = 5000;
export const SUPERGEN_CAP_DEFAULT = 200;
