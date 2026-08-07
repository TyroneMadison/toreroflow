/**
 * EditDoc v1, the Studio edit document. Pure data + immutable operations,
 * dependency-free and side-effect-free, compiled for node and browser both.
 *
 * cuts are SOURCE-time ranges per asset. Overlays (texts, broll, graphics,
 * audio) and zooms sit at OUTPUT time so they stick to the final cut.
 * edl.ts maps between the two.
 */

export interface EditAssetRef {
  assetId: string;
}

export interface CutRange {
  start: number;
  end: number;
}

export interface ShadowStyle {
  on: boolean;
  opacity: number;
  intensity: number;
  distance: number;
}

export interface OutlineStyle {
  on: boolean;
  size: number;
  color: string;
  distance: number;
}

export interface GlowStyle {
  on: boolean;
  intensity: number;
  spread: number;
  color: string;
}

export interface BackgroundStyle {
  on: boolean;
  shape: "rounded" | "square" | "fit" | "full";
  opacity: number;
  size: number;
  color: string;
}

export interface TextStyle {
  font: string;
  bold: boolean;
  italic: boolean;
  color: string;
  size: number;
  lineSpaceX: number;
  lineSpaceY: number;
  letterSpace: number;
  x: number;
  y: number;
  case: "upper" | "title" | "asis";
  align: "left" | "center" | "right";
  shadow: ShadowStyle;
  outline: OutlineStyle;
  glow: GlowStyle;
  background: BackgroundStyle;
}

export interface CaptionStyle extends TextStyle {
  wordsPerLine: 1 | 2 | 3 | 4 | 5;
  lines: 1 | 2;
  accentColor: string;
}

export type TextAnim =
  | "none"
  | "pop"
  | "karaoke"
  | "emphasis"
  | "word"
  | "wordpop"
  | "typewriter"
  | "focus"
  | "slideup"
  | "fade";

export interface TextItem {
  id: string;
  at: number;
  dur: number;
  content: string;
  x: number;
  y: number;
  style: TextStyle;
  animIn: TextAnim;
  animOut: TextAnim;
}

export interface BrollItem {
  id: string;
  assetId: string;
  at: number;
  dur: number;
  x: number;
  y: number;
  scale: number;
  shape: "full" | "rounded" | "circle";
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export interface GraphicItem {
  id: string;
  assetId: string;
  at: number;
  dur: number;
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
}

export interface AudioItem {
  id: string;
  assetId: string;
  at: number;
  dur: number;
  volume: number;
  kind: "music" | "voiceover";
}

export interface ZoomItem {
  id: string;
  at: number;
  kind: "pushin" | "punchin" | "quickzoom";
  size: "s" | "m" | "l";
}

export interface ColorAdjust {
  b: number;
  c: number;
  s: number;
  w: number;
}

export interface ClipFx {
  zoom: number;
  x: number;
  y: number;
  rotate: number;
  volume: number;
  color: ColorAdjust;
}

export interface CaptionBreak {
  chunkIndex: number;
  text: string;
}

export interface CaptionSettings {
  enabled: boolean;
  template: string;
  style: CaptionStyle;
  breaks: CaptionBreak[];
}

export interface ExportSettings {
  name: string;
  resolution: 720 | 1080 | 1440;
  fps: 30 | 60;
  format: "mp4" | "mov";
  bitrate: "lower" | "recommended" | "higher" | number;
}

export interface EditDoc {
  v: 1;
  clips: EditAssetRef[];
  cuts: Record<string, CutRange[]>;
  splits: Record<string, number[]>;
  wordEdits: Record<string, Record<number, string>>;
  broll: BrollItem[];
  graphics: GraphicItem[];
  audio: AudioItem[];
  texts: TextItem[];
  zooms: ZoomItem[];
  clipFx: Record<string, ClipFx>;
  color: ColorAdjust;
  captions: CaptionSettings;
  export: ExportSettings;
}

/** Zoom constants shared by preview CSS and render math. */
export const ZOOM = {
  pushin: { scale: { s: 1.06, m: 1.12, l: 1.2 } },
  punchin: { scale: { s: 1.15, m: 1.3, l: 1.5 } },
  quickzoom: { scale: { s: 1.2, m: 1.4, l: 1.6 }, inSec: 0.15, holdSec: 0.6, outSec: 0.15 },
} as const;

/** Fonts bundled into the server image, the only ones templates may use. */
export const FONTS = [
  "Anton",
  "Montserrat",
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
];

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: "Montserrat",
  bold: true,
  italic: false,
  color: "#FFFFFF",
  size: 48,
  lineSpaceX: 0,
  lineSpaceY: 0,
  letterSpace: 0,
  x: 0,
  y: 0,
  case: "asis",
  align: "center",
  shadow: { on: false, opacity: 60, intensity: 50, distance: 4 },
  outline: { on: true, size: 6, color: "#000000", distance: 0 },
  glow: { on: false, intensity: 50, spread: 50, color: "#FFFFFF" },
  background: { on: false, shape: "rounded", opacity: 80, size: 50, color: "#000000" },
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  ...DEFAULT_TEXT_STYLE,
  y: 30,
  wordsPerLine: 3,
  lines: 1,
  accentColor: "#FF6F61",
};

export interface CaptionTemplate {
  id: string;
  label: string;
  style: Partial<CaptionStyle>;
}

const outlineOff: OutlineStyle = { on: false, size: 6, color: "#000000", distance: 0 };
const shadowOn: ShadowStyle = { on: true, opacity: 60, intensity: 50, distance: 4 };
const shadowOff: ShadowStyle = { on: false, opacity: 60, intensity: 50, distance: 4 };
const backgroundOff: BackgroundStyle = { on: false, shape: "rounded", opacity: 80, size: 50, color: "#000000" };

export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  { id: "none", label: "No Captions", style: {} },
  {
    id: "classic",
    label: "Classic",
    style: {
      font: "Montserrat",
      bold: true,
      italic: false,
      color: "#FFFFFF",
      case: "asis",
      outline: { on: true, size: 6, color: "#000000", distance: 0 },
      shadow: shadowOff,
      background: backgroundOff,
    },
  },
  {
    id: "boxed",
    label: "Boxed",
    style: {
      font: "Montserrat",
      bold: true,
      italic: false,
      color: "#FFFFFF",
      outline: outlineOff,
      shadow: shadowOff,
      background: { on: true, shape: "full", opacity: 100, size: 50, color: "#000000" },
    },
  },
  {
    id: "editorial",
    label: "Editorial",
    style: {
      font: "Liberation Serif",
      bold: false,
      italic: false,
      color: "#FFFFFF",
      case: "title",
      outline: outlineOff,
      shadow: shadowOn,
      background: backgroundOff,
    },
  },
  {
    id: "aesthetic",
    label: "Aesthetic",
    style: {
      font: "Montserrat",
      bold: false,
      italic: true,
      color: "#FFFFFF",
      letterSpace: 2,
      outline: outlineOff,
      shadow: shadowOn,
      background: backgroundOff,
    },
  },
  {
    id: "luxe",
    label: "Luxe",
    style: {
      font: "Liberation Serif",
      bold: false,
      italic: false,
      color: "#F2E7C9",
      case: "upper",
      letterSpace: 4,
      outline: outlineOff,
      shadow: shadowOn,
      background: backgroundOff,
      accentColor: "#D9B65C",
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    style: {
      font: "Montserrat",
      bold: false,
      italic: false,
      color: "#FFFFFF",
      size: 40,
      outline: outlineOff,
      shadow: shadowOff,
      background: backgroundOff,
    },
  },
  {
    id: "clean",
    label: "Clean",
    style: {
      font: "Montserrat",
      bold: true,
      italic: false,
      color: "#FF6F61",
      case: "upper",
      outline: { on: true, size: 4, color: "#000000", distance: 0 },
      shadow: shadowOn,
      background: backgroundOff,
    },
  },
  {
    id: "simple",
    label: "Simple",
    style: {
      font: "Liberation Sans",
      bold: false,
      italic: false,
      color: "#FFFFFF",
      outline: { on: true, size: 4, color: "#000000", distance: 0 },
      shadow: shadowOff,
      background: backgroundOff,
    },
  },
  {
    id: "trendy",
    label: "Trendy",
    style: {
      font: "Anton",
      bold: true,
      italic: false,
      color: "#FFFFFF",
      case: "upper",
      letterSpace: 1,
      outline: { on: true, size: 6, color: "#000000", distance: 0 },
      shadow: shadowOn,
      background: backgroundOff,
      accentColor: "#FF6F61",
    },
  },
  {
    id: "highlight",
    label: "Highlight",
    style: {
      font: "Montserrat",
      bold: true,
      italic: true,
      color: "#FFFFFF",
      outline: outlineOff,
      shadow: shadowOn,
      background: backgroundOff,
      accentColor: "#FF6F61",
    },
  },
  {
    id: "bold",
    label: "Bold",
    style: {
      font: "Anton",
      bold: true,
      italic: false,
      color: "#FFFFFF",
      size: 56,
      case: "upper",
      outline: { on: true, size: 8, color: "#000000", distance: 0 },
      shadow: shadowOff,
      background: backgroundOff,
    },
  },
];

/** JSON-safe deep clone so no default or template object is ever shared with a doc. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyDoc(clipAssetIds: string[]): EditDoc {
  return {
    v: 1,
    clips: clipAssetIds.map((assetId) => ({ assetId })),
    cuts: {},
    splits: {},
    wordEdits: {},
    broll: [],
    graphics: [],
    audio: [],
    texts: [],
    zooms: [],
    clipFx: {},
    color: { b: 0, c: 0, s: 0, w: 0 },
    captions: {
      enabled: true,
      template: "classic",
      style: clone(DEFAULT_CAPTION_STYLE),
      breaks: [],
    },
    export: { name: "", resolution: 1080, fps: 30, format: "mp4", bitrate: "recommended" },
  };
}

/**
 * Sort by start, merge overlapping and adjacent ranges, clamp to
 * [0, duration] when a duration is passed. Never mutates the input.
 */
export function normalizeCuts(cuts: CutRange[], duration?: number): CutRange[] {
  const clamped = cuts
    .map((c) => ({
      start: Math.max(0, c.start),
      end: duration === undefined ? c.end : Math.min(c.end, duration),
    }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const out: CutRange[] = [];
  for (const c of clamped) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) {
      if (c.end > last.end) out[out.length - 1] = { start: last.start, end: c.end };
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

/** New doc with the asset's cut list replaced; an empty list drops the key. */
function withCuts(doc: EditDoc, assetId: string, list: CutRange[]): EditDoc {
  const cuts = { ...doc.cuts };
  if (list.length === 0) delete cuts[assetId];
  else cuts[assetId] = list;
  return { ...doc, cuts };
}

export function addCut(doc: EditDoc, assetId: string, range: CutRange, duration?: number): EditDoc {
  const list = normalizeCuts([...(doc.cuts[assetId] ?? []), { ...range }], duration);
  return withCuts(doc, assetId, list);
}

/** Removes every cut that overlaps the range (shared endpoints do not count). */
export function removeCutsOverlapping(doc: EditDoc, assetId: string, range: CutRange): EditDoc {
  const list = (doc.cuts[assetId] ?? []).filter(
    (c) => !(c.start < range.end && c.end > range.start),
  );
  return withCuts(doc, assetId, list);
}

/**
 * A word is removed when its [start, end] is fully inside a cut. Toggling a
 * removed word carves exactly that range back out of the containing cut,
 * toggling a kept word adds exactly that range as a cut.
 */
export function toggleWordRemoved(
  doc: EditDoc,
  assetId: string,
  wordStart: number,
  wordEnd: number,
): EditDoc {
  const cuts = doc.cuts[assetId] ?? [];
  const holder = cuts.find((c) => c.start <= wordStart && c.end >= wordEnd);
  if (!holder) return addCut(doc, assetId, { start: wordStart, end: wordEnd });
  const list: CutRange[] = [];
  for (const c of cuts) {
    if (c !== holder) {
      list.push(c);
      continue;
    }
    if (wordStart > c.start) list.push({ start: c.start, end: wordStart });
    if (wordEnd < c.end) list.push({ start: wordEnd, end: c.end });
  }
  return withCuts(doc, assetId, normalizeCuts(list));
}

/** A split marks a boundary at a source time. It is not a cut. */
export function splitAt(doc: EditDoc, assetId: string, srcTime: number): EditDoc {
  const existing = doc.splits[assetId] ?? [];
  if (existing.includes(srcTime)) return doc;
  return {
    ...doc,
    splits: { ...doc.splits, [assetId]: [...existing, srcTime].sort((a, b) => a - b) },
  };
}

/**
 * Applies a caption template: sets captions.template, enables captions
 * (except "none"), and overrides only the style fields the template defines.
 * Breaks and everything else are untouched. Unknown ids return the doc as is.
 */
export function applyTemplate(doc: EditDoc, templateId: string): EditDoc {
  const tpl = CAPTION_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return doc;
  return {
    ...doc,
    captions: {
      ...doc.captions,
      enabled: templateId !== "none",
      template: templateId,
      style: clone({ ...doc.captions.style, ...tpl.style }),
    },
  };
}
