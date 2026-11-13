/**
 * The brand kit font picker: a static list of Google Fonts families and the
 * weights each one ships, so the picker needs no Google Fonts API key and no
 * network. Families are what the Google Fonts CSS API takes
 * (fonts.googleapis.com/css2?family=Bebas+Neue). Add a family here when a
 * client needs one that is missing.
 */
export interface FontFamily {
  family: string;
  category: "sans-serif" | "serif" | "display" | "handwriting" | "monospace";
  weights: number[];
}

const span = (from: number, to: number) => Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);
const f = (family: string, category: FontFamily["category"], weights: number[]): FontFamily => ({ family, category, weights });

export const GOOGLE_FONTS: readonly FontFamily[] = [
  f("Inter", "sans-serif", span(100, 900)),
  f("Roboto", "sans-serif", [100, 300, 400, 500, 700, 900]),
  f("Open Sans", "sans-serif", span(300, 800)),
  f("Montserrat", "sans-serif", span(100, 900)),
  f("Poppins", "sans-serif", span(100, 900)),
  f("Lato", "sans-serif", [100, 300, 400, 700, 900]),
  f("Oswald", "sans-serif", span(200, 700)),
  f("Raleway", "sans-serif", span(100, 900)),
  f("Nunito", "sans-serif", span(200, 900)),
  f("Work Sans", "sans-serif", span(100, 900)),
  f("DM Sans", "sans-serif", span(100, 900)),
  f("Barlow", "sans-serif", span(100, 900)),
  f("Barlow Condensed", "sans-serif", span(100, 900)),
  f("Rubik", "sans-serif", span(300, 900)),
  f("Space Grotesk", "sans-serif", span(300, 700)),
  f("Manrope", "sans-serif", span(200, 800)),
  f("Archivo", "sans-serif", span(100, 900)),
  f("League Spartan", "sans-serif", span(100, 900)),
  f("Outfit", "sans-serif", span(100, 900)),
  f("Sora", "sans-serif", span(100, 800)),
  f("Lexend", "sans-serif", span(100, 900)),
  f("Kanit", "sans-serif", span(100, 900)),
  f("Roboto Condensed", "sans-serif", span(100, 900)),
  f("Source Sans 3", "sans-serif", span(200, 900)),
  f("PT Sans", "sans-serif", [400, 700]),
  f("Noto Sans", "sans-serif", span(100, 900)),
  f("Ubuntu", "sans-serif", [300, 400, 500, 700]),
  f("Josefin Sans", "sans-serif", span(100, 700)),
  f("Exo 2", "sans-serif", span(100, 900)),
  f("Saira Condensed", "sans-serif", span(100, 900)),
  f("Chakra Petch", "sans-serif", span(300, 700)),
  f("Bebas Neue", "display", [400]),
  f("Anton", "display", [400]),
  f("Archivo Black", "display", [400]),
  f("Teko", "display", span(300, 700)),
  f("Russo One", "display", [400]),
  f("Black Ops One", "display", [400]),
  f("Righteous", "display", [400]),
  f("Fjalla One", "display", [400]),
  f("Alfa Slab One", "display", [400]),
  f("Bungee", "display", [400]),
  f("Orbitron", "display", span(400, 900)),
  f("Lobster", "display", [400]),
  f("Playfair Display", "serif", span(400, 900)),
  f("Merriweather", "serif", [300, 400, 700, 900]),
  f("Lora", "serif", span(400, 700)),
  f("Libre Baskerville", "serif", [400, 700]),
  f("Cormorant Garamond", "serif", span(300, 700)),
  f("Permanent Marker", "handwriting", [400]),
  f("Pacifico", "handwriting", [400]),
  f("Caveat", "handwriting", span(400, 700)),
  f("Roboto Mono", "monospace", span(100, 700)),
];

const byName = new Map(GOOGLE_FONTS.map((x) => [x.family.toLowerCase(), x]));

export function findFont(family: string): FontFamily | undefined {
  return byName.get(family.trim().toLowerCase());
}

/** Why a kit's font choice is not available, or null when every one is. */
export function fontProblem(fonts: { family: string; weights: number[] }[]): string | null {
  for (const font of fonts) {
    const hit = findFont(font.family);
    if (!hit) return `"${font.family}" is not in the Google Fonts list`;
    const bad = font.weights.find((w) => !hit.weights.includes(w));
    if (bad !== undefined) return `${hit.family} has no ${bad} weight (has ${hit.weights.join(", ")})`;
  }
  return null;
}
