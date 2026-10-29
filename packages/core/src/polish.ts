/**
 * Phase 7 polish and effects: transitions, lower thirds, hook presets,
 * censor, looks, progress bar, stickers, safe zones, colour emoji files,
 * custom font names, the face anchor and rounded ASS boxes. Pure and
 * deterministic, so the render worker, the API and the desktop preview all
 * compute the same numbers.
 */

import type { CaptionSettings, ColorAdjust, EditDoc, Rect, TextItem, TextStyle } from "./editDoc";
import type { FaceTrack } from "./reframe";

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export interface TransitionPreset {
  id: string;
  label: string;
  /** ffmpeg xfade transition name (all present in ffmpeg 5.1, the image's). */
  xfade: string;
  /** How the preview approximates it (see transitionCss). */
  preview: "fade" | "dip-black" | "dip-white" | "zoom" | "blur" | "left" | "right" | "up" | "down";
}

export const TRANSITIONS: TransitionPreset[] = [
  { id: "crossfade", label: "Cross fade", xfade: "fade", preview: "fade" },
  { id: "crosszoom", label: "Cross zoom", xfade: "zoomin", preview: "zoom" },
  { id: "dissolve", label: "Dissolve", xfade: "dissolve", preview: "fade" },
  { id: "blur", label: "Blur", xfade: "hblur", preview: "blur" },
  { id: "pushleft", label: "Push left", xfade: "slideleft", preview: "left" },
  { id: "pushright", label: "Push right", xfade: "slideright", preview: "right" },
  { id: "slideup", label: "Slide up", xfade: "slideup", preview: "up" },
  { id: "slidedown", label: "Slide down", xfade: "slidedown", preview: "down" },
  { id: "dipblack", label: "Dip black", xfade: "fadeblack", preview: "dip-black" },
  { id: "dipwhite", label: "Flash", xfade: "fadewhite", preview: "dip-white" },
  { id: "fadegrays", label: "Fade grey", xfade: "fadegrays", preview: "fade" },
  { id: "wipeleft", label: "Wipe left", xfade: "wipeleft", preview: "left" },
  { id: "wiperight", label: "Wipe right", xfade: "wiperight", preview: "right" },
  { id: "wipeup", label: "Wipe up", xfade: "wipeup", preview: "up" },
  { id: "wipedown", label: "Wipe down", xfade: "wipedown", preview: "down" },
  { id: "smoothleft", label: "Smooth left", xfade: "smoothleft", preview: "left" },
  { id: "smoothright", label: "Smooth right", xfade: "smoothright", preview: "right" },
  { id: "smoothup", label: "Smooth up", xfade: "smoothup", preview: "up" },
  { id: "smoothdown", label: "Smooth down", xfade: "smoothdown", preview: "down" },
  { id: "circleopen", label: "Circle open", xfade: "circleopen", preview: "zoom" },
  { id: "circleclose", label: "Circle close", xfade: "circleclose", preview: "zoom" },
  { id: "circlecrop", label: "Circle crop", xfade: "circlecrop", preview: "dip-black" },
  { id: "rectcrop", label: "Box crop", xfade: "rectcrop", preview: "dip-black" },
  { id: "radial", label: "Radial", xfade: "radial", preview: "fade" },
  { id: "pixelize", label: "Pixelize", xfade: "pixelize", preview: "blur" },
  { id: "distance", label: "Distance", xfade: "distance", preview: "fade" },
  { id: "horzopen", label: "Open wide", xfade: "horzopen", preview: "zoom" },
  { id: "vertopen", label: "Open tall", xfade: "vertopen", preview: "zoom" },
  { id: "diagtl", label: "Diagonal", xfade: "diagtl", preview: "left" },
  { id: "slice", label: "Slice", xfade: "hlslice", preview: "left" },
  { id: "squeeze", label: "Squeeze", xfade: "squeezeh", preview: "zoom" },
];

export const TRANSITION_DUR = { min: 0.1, max: 1.5, def: 0.4 } as const;

export interface TransitionPick {
  kind: string;
  dur: number;
}

/**
 * auto: the preset placed at every join between two main-track clips
 * ("none" = no auto). joins: per-join override keyed by the INCOMING clip's
 * id; null removes the auto transition there. Jump cuts inside one clip are
 * never transitioned, they are the edit's rhythm.
 */
export interface TransitionSettings {
  auto: string;
  dur: number;
  joins?: Record<string, TransitionPick | null>;
}

export interface TransitionJoin {
  /** Index of the incoming segment in the EDL given. */
  seg: number;
  /** Output time the incoming segment starts at. */
  at: number;
  xfade: string;
  preset: string;
  dur: number;
}

export function transitionPreset(id: string): TransitionPreset | undefined {
  return TRANSITIONS.find((t) => t.id === id);
}

/**
 * Every transition in an EDL. Duration-preserving: the outgoing side holds
 * its last frame for dur while the incoming side plays, so output length and
 * caption timing never move. dur is clamped to the incoming segment.
 */
export function transitionJoins(
  settings: TransitionSettings | undefined,
  edl: { clipId?: string; assetId: string; srcIn: number; srcOut: number }[],
): TransitionJoin[] {
  if (!settings) return [];
  const out: TransitionJoin[] = [];
  let t = 0;
  for (let i = 0; i < edl.length; i++) {
    const len = edl[i].srcOut - edl[i].srcIn;
    if (i > 0) {
      const prev = edl[i - 1];
      const cur = edl[i];
      const prevKey = prev.clipId ?? prev.assetId;
      const curKey = cur.clipId ?? cur.assetId;
      if (prevKey !== curKey) {
        const override = settings.joins?.[curKey];
        const pick: TransitionPick | null =
          override === null
            ? null
            : override ?? (settings.auto !== "none" ? { kind: settings.auto, dur: settings.dur } : null);
        const preset = pick ? transitionPreset(pick.kind) : undefined;
        if (pick && preset) {
          const dur = Math.max(TRANSITION_DUR.min, Math.min(pick.dur, TRANSITION_DUR.max, len * 0.9));
          if (len * 0.9 >= TRANSITION_DUR.min) {
            out.push({ seg: i, at: Math.round(t * 1000) / 1000, xfade: preset.xfade, preset: preset.id, dur });
          }
        }
      }
    }
    t += len;
  }
  return out;
}

/**
 * Preview approximation of a transition at progress p (0..1) on the incoming
 * picture: CSS opacity/transform/filter plus an optional dip colour layer.
 * ponytail: the preview has one <video>, so the outgoing frame is not drawn;
 * the incoming side animates over black. The export is the real xfade.
 */
export function transitionCss(
  presetId: string,
  p: number,
): { opacity?: number; transform?: string; filter?: string; dip?: { color: string; opacity: number } } {
  const q = Math.max(0, Math.min(1, p));
  const kind = transitionPreset(presetId)?.preview ?? "fade";
  const r = (v: number) => Math.round(v * 1000) / 1000;
  switch (kind) {
    case "fade":
      return { opacity: r(q) };
    case "dip-black":
    case "dip-white":
      return { dip: { color: kind === "dip-black" ? "#000000" : "#ffffff", opacity: r(1 - q) } };
    case "zoom":
      return { opacity: r(q), transform: `scale(${r(1.25 - 0.25 * q)})` };
    case "blur":
      return { opacity: r(q), filter: `blur(${r((1 - q) * 12)}px)` };
    case "left":
      return { transform: `translateX(${r((1 - q) * 100)}%)` };
    case "right":
      return { transform: `translateX(${r(-(1 - q) * 100)}%)` };
    case "up":
      return { transform: `translateY(${r((1 - q) * 100)}%)` };
    case "down":
      return { transform: `translateY(${r(-(1 - q) * 100)}%)` };
  }
}

/** The transition active at output time t, with its progress, if any. */
export function transitionAt(joins: TransitionJoin[], t: number): { join: TransitionJoin; p: number } | null {
  for (const j of joins) {
    if (t >= j.at && t < j.at + j.dur) return { join: j, p: (t - j.at) / j.dur };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lower thirds + hook presets                                         */
/* ------------------------------------------------------------------ */

export interface LowerThird {
  id: string;
  at: number;
  dur: number;
  kind: "nametitle" | "location";
  name: string;
  title?: string;
  from: "left" | "right" | "bottom" | "fade";
  accent: string;
  font?: string;
}

export const LOWER_THIRD_DUR = 3.5;

function baseStyle(over: Partial<TextStyle> & Pick<TextStyle, "size" | "color">): TextStyle {
  return {
    font: "Montserrat",
    bold: true,
    italic: false,
    lineSpaceX: 0,
    lineSpaceY: 0,
    letterSpace: 0,
    x: 0,
    y: 0,
    case: "asis",
    align: "center",
    shadow: { on: false, opacity: 50, intensity: 50, distance: 2 },
    outline: { on: false, size: 3, color: "#000000", distance: 0 },
    glow: { on: false, intensity: 0, spread: 0, color: "#ffffff" },
    background: { on: false, shape: "rounded", opacity: 100, size: 50, color: "#000000" },
    ...over,
  };
}

/** Readable text on an accent: dark on light colours, white on dark. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return lum > 150 ? "#111111" : "#ffffff";
}

const ANIM_FROM: Record<LowerThird["from"], TextItem["animIn"]> = {
  left: "slideup",
  right: "slideup",
  bottom: "slideup",
  fade: "fade",
};

/**
 * A lower third as text items: the name on an accent rounded box and the
 * title (or nothing, for a location) under it on a dark box, both in the
 * lower-left third. Text items, so render and preview reuse the text path.
 * ponytail: left/right entries use the same slide-up the text path has;
 * a horizontal \move is a later polish.
 */
export function lowerThirdTexts(lt: LowerThird): TextItem[] {
  const animIn = ANIM_FROM[lt.from];
  const font = lt.font ?? "Montserrat";
  const name: TextItem = {
    id: `__lt_${lt.id}_n`,
    at: lt.at,
    dur: lt.dur,
    content: lt.name,
    x: -22,
    y: 22,
    style: baseStyle({
      font,
      size: 54,
      color: textOn(lt.accent),
      x: -22,
      y: 22,
      background: { on: true, shape: "rounded", opacity: 100, size: 50, color: lt.accent },
    }),
    animIn,
    animOut: "fade",
  };
  const items = [name];
  if (lt.kind === "nametitle" && lt.title?.trim()) {
    items.push({
      id: `__lt_${lt.id}_t`,
      at: lt.at + 0.15,
      dur: Math.max(0.3, lt.dur - 0.15),
      content: lt.title,
      x: -22,
      y: 26.5,
      style: baseStyle({
        font,
        bold: false,
        size: 40,
        color: "#ffffff",
        x: -22,
        y: 26.5,
        background: { on: true, shape: "rounded", opacity: 80, size: 40, color: "#111111" },
      }),
      animIn,
      animOut: "fade",
    });
  }
  return items;
}

export interface HookPreset {
  id: string;
  label: string;
  style: Partial<TextStyle>;
}

/** Mock-up 20 hook styles, applied over the current hook style. */
export const HOOK_PRESETS: HookPreset[] = [
  {
    id: "whitebox",
    label: "White box",
    style: {
      color: "#111111",
      bold: true,
      outline: { on: false, size: 3, color: "#000000", distance: 0 },
      background: { on: true, shape: "rounded", opacity: 100, size: 60, color: "#ffffff" },
    },
  },
  {
    id: "coralbar",
    label: "Coral bar",
    style: {
      color: "#ffffff",
      bold: true,
      outline: { on: false, size: 3, color: "#000000", distance: 0 },
      background: { on: true, shape: "square", opacity: 100, size: 50, color: "#ff6b5b" },
    },
  },
  {
    id: "outline",
    label: "Outline",
    style: {
      color: "#ffffff",
      bold: true,
      outline: { on: true, size: 6, color: "#000000", distance: 0 },
      background: { on: false, shape: "rounded", opacity: 100, size: 50, color: "#000000" },
    },
  },
  {
    id: "yellow",
    label: "Yellow",
    style: {
      color: "#ffd400",
      bold: true,
      outline: { on: true, size: 5, color: "#000000", distance: 0 },
      background: { on: false, shape: "rounded", opacity: 100, size: 50, color: "#000000" },
    },
  },
];

export function applyHookPreset(style: TextStyle, id: string): TextStyle {
  const p = HOOK_PRESETS.find((h) => h.id === id);
  return p ? { ...style, ...p.style } : style;
}

/* ------------------------------------------------------------------ */
/* Censor                                                              */
/* ------------------------------------------------------------------ */

export interface CensorSettings {
  /** Mask listed words in captions with dashes. */
  mask: boolean;
  audio: "bleep" | "mute" | "off";
  /** The word list in force (the client's list, snapshotted on toggle). */
  words: string[];
}

const bare = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** "shit," -> "s---,": first letter kept, punctuation kept. */
export function maskWord(word: string): string {
  let seen = false;
  return word.replace(/[A-Za-z0-9']/g, (c) => {
    if (!seen) {
      seen = true;
      return c;
    }
    return "-";
  });
}

/** True when a spoken word matches the list (case and punctuation blind; "*" suffix = prefix). */
export function isCensored(word: string, list: string[]): boolean {
  const b = bare(word);
  if (!b) return false;
  for (const raw of list) {
    const l = bare(raw.replace(/\*$/, ""));
    if (!l) continue;
    if (raw.trim().endsWith("*") ? b.startsWith(l) : b === l) return true;
  }
  return false;
}

/** Merged output-time spans of censored words, padded a little. */
export function censorSpans(
  words: { word: string; start: number; end: number }[],
  list: string[],
  pad = 0.04,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const w of words) {
    if (!isCensored(w.word, list)) continue;
    const s = Math.max(0, w.start - pad);
    const e = w.end + pad;
    const last = spans[spans.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else spans.push({ start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 });
  }
  for (const sp of spans) sp.end = Math.round(sp.end * 1000) / 1000;
  return spans;
}

/** Caption text with listed words masked, word by word. */
export function maskText(text: string, list: string[]): string {
  return text
    .split(/(\s+)/)
    .map((part) => (/\s/.test(part) || !isCensored(part, list) ? part : maskWord(part)))
    .join("");
}

/** Normalised client word list: trimmed, lowercased, unique, capped. */
export function cleanWordList(words: unknown): string[] {
  if (!Array.isArray(words)) return [];
  const out: string[] = [];
  for (const w of words) {
    if (typeof w !== "string") continue;
    const t = w.trim().toLowerCase().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 200) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Looks, enhance, progress bar, stickers, safe zones                  */
/* ------------------------------------------------------------------ */

export interface Look {
  id: string;
  label: string;
  color: ColorAdjust;
}

/**
 * Named looks as universal colour settings, so the preview's CSS filter and
 * the render's eq/colortemperature already agree on them.
 */
export const LOOKS: Look[] = [
  { id: "warm", label: "Warm studio", color: { b: 4, c: 8, s: 10, w: 30 } },
  { id: "neutral", label: "Clean neutral", color: { b: 2, c: 6, s: 0, w: 0 } },
  { id: "moody", label: "Moody", color: { b: -8, c: 22, s: -25, w: -10 } },
  { id: "gloss", label: "Dud Rents gloss", color: { b: 6, c: 18, s: 28, w: 8 } },
];

export interface EnhanceSettings {
  on: boolean;
  /** Integrated loudness target, LUFS. */
  lufs: number;
}

/** The enhance-speech audio chain (demucs runs separately, before render). */
export function enhanceChain(e: EnhanceSettings | undefined): string[] {
  if (!e?.on) return [];
  const I = Math.max(-24, Math.min(-9, Math.round(e.lufs)));
  return ["highpass=f=80", "afftdn=nf=-25", `loudnorm=I=${I}:TP=-1.5:LRA=11`];
}

export interface ProgressBar {
  on: boolean;
  color: string;
  position: "bottom" | "top";
  /** Thickness in output pixels at 1920 tall. */
  height: number;
}

export interface Sticker {
  id: string;
  emoji: string;
  at: number;
  dur: number;
  /** Percent offsets from centre, like text items. */
  x: number;
  y: number;
  /** Size as a fraction of output width. */
  scale: number;
}

export const STICKER_PACK = ["🔥", "💯", "👀", "✅", "💸", "⏰", "😂", "🤯", "🚀", "❤️", "👇", "⭐"];

export interface OverlaySettings {
  progress?: ProgressBar;
  stickers?: Sticker[];
}

export type SafePlatform = "tiktok" | "reels" | "shorts" | "facebook";

/**
 * Areas each app's UI covers on a 9:16 frame, percent of width/height.
 * Approximate public guidance; red in the preview overlay.
 */
export const SAFE_ZONES: Record<SafePlatform, { label: string; covered: Rect[] }> = {
  tiktok: {
    label: "TikTok",
    covered: [
      { x: 0, y: 0, w: 100, h: 8 },
      { x: 0, y: 80, w: 100, h: 20 },
      { x: 86, y: 38, w: 14, h: 42 },
    ],
  },
  reels: {
    label: "Reels",
    covered: [
      { x: 0, y: 0, w: 100, h: 7 },
      { x: 0, y: 81, w: 100, h: 19 },
      { x: 87, y: 50, w: 13, h: 31 },
    ],
  },
  shorts: {
    label: "Shorts",
    covered: [
      { x: 0, y: 0, w: 100, h: 7 },
      { x: 0, y: 78, w: 100, h: 22 },
      { x: 86, y: 48, w: 14, h: 30 },
    ],
  },
  facebook: {
    label: "Facebook",
    covered: [
      { x: 0, y: 0, w: 100, h: 9 },
      { x: 0, y: 79, w: 100, h: 21 },
      { x: 85, y: 50, w: 15, h: 29 },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* Phase 7 doc fields                                                  */
/* ------------------------------------------------------------------ */

/** All optional, so a v2 doc without them renders exactly as before. */
export interface PolishFields {
  transitions?: TransitionSettings;
  lowerThirds?: LowerThird[];
  censor?: CensorSettings;
  look?: string;
  enhance?: EnhanceSettings;
  overlays?: OverlaySettings;
  /** Desktop-only preview overlay; never rendered. */
  safeZone?: SafePlatform | null;
}

export type PolishDoc = EditDoc;

/** Lower thirds of a doc as text items (empty when none). */
export function lowerThirdItems(doc: PolishFields): TextItem[] {
  return (doc.lowerThirds ?? []).flatMap(lowerThirdTexts);
}

/* ------------------------------------------------------------------ */
/* Colour emoji                                                        */
/* ------------------------------------------------------------------ */

/** Twemoji file name for an emoji: hex codepoints, FE0F dropped unless ZWJ. */
export function emojiFile(e: string): string {
  const cps = [...e].map((c) => c.codePointAt(0)!.toString(16));
  const zwj = cps.includes("200d");
  return (zwj ? cps : cps.filter((c) => c !== "fe0f")).join("-") + ".png";
}

export interface EmojiOverlay {
  file: string;
  start: number;
  end: number;
  /** Top-left in output pixels. */
  x: number;
  y: number;
  size: number;
}

/**
 * Caption emojis as colour images, a row centred just above the caption
 * block (libass draws monochrome only). Preview and render both place them
 * here from this function. Block height is lines * size * 1.2.
 */
export function captionEmojiOverlays(
  chunks: { start: number; end: number; text: string; emojis?: string[] }[],
  cap: Pick<CaptionSettings, "enabled" | "style">,
  W: number,
  H: number,
): EmojiOverlay[] {
  if (!cap.enabled) return [];
  const st = cap.style;
  const size = Math.round(st.size * 1.15);
  const gap = Math.round(size * 0.12);
  const cy = H * (0.5 + st.y / 100);
  const cx = W * (0.5 + st.x / 100);
  const out: EmojiOverlay[] = [];
  for (const ch of chunks) {
    const list = ch.emojis ?? [];
    if (list.length === 0 || !ch.text.trim()) continue;
    const words = ch.text.split(/\s+/).filter(Boolean).length;
    const lines = Math.max(1, Math.min(st.lines, Math.ceil(words / st.wordsPerLine)));
    const top = cy - (lines * st.size * 1.2) / 2 - gap - size;
    const rowW = list.length * size + (list.length - 1) * gap;
    list.forEach((e, k) => {
      out.push({
        file: emojiFile(e),
        start: ch.start,
        end: ch.end,
        x: Math.round(cx - rowW / 2 + k * (size + gap)),
        y: Math.round(top),
        size,
      });
    });
  }
  return out;
}

/** Stickers as the same overlays (centre at x/y percent offsets). */
export function stickerOverlays(stickers: Sticker[] | undefined, W: number, H: number): EmojiOverlay[] {
  return (stickers ?? []).map((s) => {
    const size = Math.max(16, Math.round(W * s.scale));
    return {
      file: emojiFile(s.emoji),
      start: s.at,
      end: s.at + s.dur,
      x: Math.round(W * (0.5 + s.x / 100) - size / 2),
      y: Math.round(H * (0.5 + s.y / 100) - size / 2),
      size,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Rounded boxes (ASS vector drawing)                                  */
/* ------------------------------------------------------------------ */

/** Average advance per em by font family; libass has no metrics API here. */
const ADVANCE: Record<string, number> = { anton: 0.46, montserrat: 0.62, bebas: 0.42 };

/**
 * Estimated rendered width of one line. ponytail: an average advance per
 * font, not real glyph metrics; the box pads generously so it reads right.
 */
export function estimateTextWidth(text: string, style: Pick<TextStyle, "font" | "size" | "bold" | "letterSpace" | "case">): number {
  const fam = style.font.toLowerCase();
  const key = Object.keys(ADVANCE).find((k) => fam.includes(k));
  let adv = key ? ADVANCE[key] : 0.58;
  if (style.bold) adv *= 1.05;
  const upper = style.case === "upper" || text === text.toUpperCase();
  if (upper) adv *= 1.12;
  const chars = [...text].length;
  return chars * style.size * adv + Math.max(0, chars - 1) * style.letterSpace;
}

/** An ASS \p1 path for a w x h rounded rectangle, top-left at 0,0. */
export function roundedRectPath(w: number, h: number, r: number): string {
  const W = Math.round(w);
  const Hh = Math.round(h);
  const R = Math.max(0, Math.min(Math.round(r), Math.floor(Math.min(W, Hh) / 2)));
  const k = Math.round(R * 0.448); // cubic control offset (1 - 0.552) * R
  return [
    `m ${R} 0`,
    `l ${W - R} 0`,
    `b ${W - k} 0 ${W} ${k} ${W} ${R}`,
    `l ${W} ${Hh - R}`,
    `b ${W} ${Hh - k} ${W - k} ${Hh} ${W - R} ${Hh}`,
    `l ${R} ${Hh}`,
    `b ${k} ${Hh} 0 ${Hh - k} 0 ${Hh - R}`,
    `l 0 ${R}`,
    `b 0 ${k} ${k} 0 ${R} 0`,
  ].join(" ");
}

/** Box size around a text block: widest line, line count, padding from bg.size. */
export function roundedBoxSize(text: string, style: TextStyle): { w: number; h: number; r: number } {
  const lines = text.split("\n");
  const widest = Math.max(...lines.map((l) => estimateTextWidth(l, style)));
  const pad = Math.round(style.size * (0.2 + style.background.size / 250));
  const w = widest + pad * 2;
  const h = lines.length * style.size * 1.2 + pad * 1.4;
  return { w: Math.round(w), h: Math.round(h), r: Math.round(Math.min(h / 2, style.size * 0.45)) };
}

/* ------------------------------------------------------------------ */
/* Face anchor                                                         */
/* ------------------------------------------------------------------ */

/**
 * The dominant face centre (source fractions) nearest time t: the sample
 * closest in time within 1.5s, its largest face. Null when none.
 */
export function faceCenterAt(track: FaceTrack | null | undefined, t: number): { x: number; y: number } | null {
  if (!track || track.frames.length === 0) return null;
  let best: FaceTrack["frames"][number] | null = null;
  let bestD = Infinity;
  for (const f of track.frames) {
    if (f.faces.length === 0) continue;
    const d = Math.abs(f.t - t);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  if (!best || bestD > 1.5) return null;
  const face = best.faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  // Boxes are source fractions when <= 1, else pixels of track.w x track.h.
  const px = face.x > 1 || face.w > 1;
  const cx = px ? (face.x + face.w / 2) / track.w : face.x + face.w / 2;
  const cy = px ? (face.y + face.h / 2) / track.h : face.y + face.h / 2;
  return { x: cx, y: cy };
}

/**
 * A source-fraction point to a fraction of the output frame. crop (a reframe
 * Rect: size in source fractions, x/y centre offsets) for reframed layouts; null = the legacy letterbox fit. Clamped
 * to 0.15..0.85 so a zoom never drives into an edge.
 */
export function pointInFrame(
  p: { x: number; y: number },
  crop: Rect | null,
  srcA: number,
  outA: number,
): { x: number; y: number } {
  let x: number;
  let y: number;
  if (crop) {
    // Rect x/y are centre offsets from 0.5 (reframe.ts cropPx).
    x = (p.x - (0.5 + crop.x - crop.w / 2)) / crop.w;
    y = (p.y - (0.5 + crop.y - crop.h / 2)) / crop.h;
  } else if (srcA > outA) {
    // Wider source: letterboxed top and bottom.
    const hFrac = outA / srcA;
    x = p.x;
    y = 0.5 + (p.y - 0.5) * hFrac;
  } else {
    const wFrac = srcA / outA;
    x = 0.5 + (p.x - 0.5) * wFrac;
    y = p.y;
  }
  const c = (v: number) => Math.round(Math.max(0.15, Math.min(0.85, v)) * 1000) / 1000;
  return { x: c(x), y: c(y) };
}

/* ------------------------------------------------------------------ */
/* Custom fonts                                                        */
/* ------------------------------------------------------------------ */

/**
 * Family name from a TTF/OTF name table (nameID 16 typographic family, else
 * 1). Returns null for anything that is not a parseable sfnt.
 */
export function fontFamilyName(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = dv.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const numTables = dv.getUint16(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    const t = String.fromCharCode(buf[rec], buf[rec + 1], buf[rec + 2], buf[rec + 3]);
    if (t === "name") nameOff = dv.getUint32(rec + 8);
  }
  if (nameOff < 0 || nameOff + 6 > buf.length) return null;
  const count = dv.getUint16(nameOff + 2);
  const strOff = nameOff + dv.getUint16(nameOff + 4);
  const found: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = dv.getUint16(r);
    const nameId = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = strOff + dv.getUint16(r + 10);
    if ((nameId !== 1 && nameId !== 16) || off + len > buf.length) continue;
    let s = "";
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(off + k));
    } else {
      for (let k = 0; k < len; k++) s += String.fromCharCode(buf[off + k]);
    }
    s = s.trim();
    if (s && (!found[nameId] || platform === 3)) found[nameId] = s;
  }
  return found[16] ?? found[1] ?? null;
}

/** Safe stored file name for an uploaded font. */
export function fontFileName(original: string): string | null {
  const m = /^(.*)\.(ttf|otf)$/i.exec(original.trim());
  if (!m) return null;
  const base = m[1].replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base ? `${base}.${m[2].toLowerCase()}` : null;
}
