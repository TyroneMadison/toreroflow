import type { MediaAssetInfo } from "./api";

/** YouTube's stable category ids; Autos first because that is the clientele. */
export const YT_CATEGORIES: Array<[string, string]> = [
  ["2", "Autos & Vehicles"],
  ["24", "Entertainment"],
  ["22", "People & Blogs"],
  ["26", "Howto & Style"],
  ["28", "Science & Technology"],
  ["27", "Education"],
  ["17", "Sports"],
  ["23", "Comedy"],
  ["10", "Music"],
  ["20", "Gaming"],
  ["19", "Travel & Events"],
  ["25", "News & Politics"],
  ["15", "Pets & Animals"],
  ["1", "Film & Animation"],
];

/**
 * The languages offered for a video's spoken language, BCP-47 tagged.
 *
 * A curated list rather than YouTube's full i18nLanguages call: that endpoint
 * needs a live request per open of the wizard for a list that never changes,
 * and this clientele speaks a handful of these. Add a line the day a client
 * needs one that is missing.
 */
export const YT_LANGUAGES: Array<[string, string]> = [
  ["en", "English"],
  ["es", "Spanish"],
  ["es-419", "Spanish (Latin America)"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["fil", "Filipino"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
  ["tr", "Turkish"],
  ["he", "Hebrew"],
  ["sv", "Swedish"],
];

/**
 * Whether this video is a horizontal, long-form YouTube upload.
 *
 * Judged by shape, not length: a two-minute 16:9 video belongs to the
 * long-form uploader while a four-minute vertical does not, whatever the
 * duration classifier says. Width strictly greater than height covers every
 * ratio on the wish list (16:9, 4:3, 1.85:1, 2:1, 2.35:1) without keeping a
 * list that a 21:9 export would fall through. Assets probed before dimensions
 * were recorded fall back to the duration-based format.
 */
export function isHorizontal(asset: Pick<MediaAssetInfo, "width" | "height" | "format" | "kind">): boolean {
  if (asset.kind === "carousel") return false;
  if (asset.width != null && asset.height != null && asset.width > 0 && asset.height > 0) {
    return asset.width > asset.height;
  }
  return asset.format === "long_form";
}

/**
 * The conventional name for a frame's shape, e.g. "16:9", or "1234x567" when
 * it is none of the named ones. Cosmetic: the Checks phase says what the file
 * is rather than making the operator do the division.
 */
export function ratioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "unknown";
  const r = width / height;
  const named: Array<[number, string]> = [
    [16 / 9, "16:9"],
    [4 / 3, "4:3"],
    [1.85, "1.85:1"],
    [2, "2:1"],
    [2.35, "2.35:1"],
    [21 / 9, "21:9"],
  ];
  for (const [value, label] of named) {
    if (Math.abs(r - value) < 0.03) return label;
  }
  return `${width}x${height}`;
}
