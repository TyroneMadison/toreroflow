/** Swatches for Trello label colors, shared by the Ready queue and Settings. */
export const LABEL_SWATCH: Record<string, string> = {
  red: "#E5484D",
  black: "#3a3d44",
  yellow: "#E8B931",
  green: "#4BCE97",
  orange: "#FAA53D",
  purple: "#9F8FEF",
  blue: "#579DFF",
  sky: "#6CC3E0",
  lime: "#94C748",
  pink: "#E774BB",
};

/** Trello color names folded to their base ("black_dark" -> "black"). */
export function baseColor(c: string | null | undefined): string | null {
  if (!c) return null;
  const b = c.toLowerCase().replace(/_(dark|light)$/, "");
  return b === "gray" || b === "grey" ? "black" : b === "gold" ? "yellow" : b;
}

/** Plain names for the colors people actually say. */
export const COLOR_NAME: Record<string, string> = { black: "gray/black", yellow: "yellow/gold" };
