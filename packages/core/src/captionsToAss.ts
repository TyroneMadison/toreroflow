/**
 * Captions and text overlays to one complete ASS subtitle file. Pure,
 * side-effect-free, deterministic, so the render worker and the checks share
 * one exact string.
 *
 * Documented libass approximations (the phone preview is the operator's
 * truth, ASS gets as close as libass allows):
 * - Background boxes (BorderStyle 3) are always square. "rounded" corners are
 *   a libass limitation, and a box replaces the letter outline and shadow.
 * - Glow, lineSpaceX/lineSpaceY, and outline distance have no ASS equivalent
 *   and are dropped.
 * - Left/right alignment anchors the text edge at the position point instead
 *   of centering the block the way the preview does.
 * - Slide up uses \move and ASS allows one per event, so slide in wins when
 *   both in and out are slide up.
 * - Emphasis and focus are \t scale/alpha sketches. Word and word pop show
 *   one word at a time. Karaoke on a plain text item falls back to word,
 *   real karaoke needs the caption accent color. Out animations on the
 *   splitting kinds (typewriter, word, word pop, karaoke) are ignored.
 */

import {
  CAPTION_TEMPLATES,
  type CaptionSettings,
  type TextItem,
  type TextStyle,
} from "./editDoc";
import type { CaptionChunk } from "./captionChunks";

/** "#RRGGBB" plus an alpha byte (0 solid, 255 clear) to ASS &HAABBGGRR&. */
export function hexToAss(hex: string, alpha = 0): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const rgb = m ? m[1] : "FFFFFF";
  const a = Math.max(0, Math.min(255, Math.round(alpha)))
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`.toUpperCase();
}

/** upper/title/asis, matching the preview's CSS text-transform. */
export function applyCase(text: string, mode: TextStyle["case"]): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "title") return text.replace(/(^|\s)(\S)/g, (_, sp: string, ch: string) => sp + ch.toUpperCase());
  return text;
}

/** Opacity percent (100 solid) to the ASS alpha byte (0 solid). */
function alphaByte(opacityPct: number): number {
  return Math.round(255 * (1 - Math.max(0, Math.min(100, opacityPct)) / 100));
}

/** Seconds to H:MM:SS.CC. */
function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** First family of a font stack, quotes stripped. */
function firstFamily(font: string): string {
  return font.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

/** x/y are percent offsets from the frame center, same as the preview. */
function posOf(x: number, y: number, w: number, h: number): { px: number; py: number } {
  return { px: Math.round(w * (0.5 + x / 100)), py: Math.round(h * (0.5 + y / 100)) };
}

function braces(text: string): string {
  return text.replace(/[{}]/g, (c) => `\\${c}`);
}

function escapeText(text: string): string {
  return braces(text).replace(/\n/g, "\\N");
}

function styleLine(name: string, s: TextStyle, secondary: string): string {
  const bg = s.background;
  const fields = [
    name,
    firstFamily(s.font),
    String(s.size),
    hexToAss(s.color),
    secondary,
    hexToAss(s.outline.on ? s.outline.color : "#000000"),
    bg.on
      ? hexToAss(bg.color, alphaByte(bg.opacity))
      : s.shadow.on
        ? hexToAss("#000000", alphaByte(s.shadow.opacity))
        : hexToAss("#000000"),
    s.bold ? "-1" : "0",
    s.italic ? "-1" : "0",
    "0",
    "0",
    "100",
    "100",
    String(s.letterSpace),
    "0",
    bg.on ? "3" : "1",
    // Boxed: Outline becomes box padding, size 0..100 maps to 0..20px.
    String(bg.on ? Math.round(bg.size / 5) : s.outline.on ? s.outline.size : 0),
    String(!bg.on && s.shadow.on ? s.shadow.distance : 0),
    String(s.align === "left" ? 4 : s.align === "right" ? 6 : 5),
    "0",
    "0",
    "0",
    "1",
  ];
  return `Style: ${fields.join(",")}`;
}

function dialogue(layer: number, start: number, end: number, style: string, text: string): string {
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

/** {\kNN} per word. The centisecond values always sum to the duration. */
function karaokeText(text: string, durSec: number): string {
  const lines = text.split("\n");
  const words = lines.flatMap((l) => l.split(" ").filter(Boolean));
  if (words.length === 0) return "";
  const total = Math.max(1, Math.round(durSec * 100));
  const base = Math.floor(total / words.length);
  let used = 0;
  let n = 0;
  const nextK = () => {
    n += 1;
    const k = n === words.length ? total - used : base;
    used += k;
    return k;
  };
  return lines
    .map((l) =>
      l
        .split(" ")
        .filter(Boolean)
        .map((w) => `{\\k${nextK()}}${braces(w)}`)
        .join(" "),
    )
    .join("\\N");
}

const POP_IN = "\\t(0,140,\\fscx108\\fscy108)\\t(140,240,\\fscx100\\fscy100)";

function textEvents(item: TextItem, style: string, w: number, h: number): string[] {
  const { px, py } = posOf(item.x, item.y, w, h);
  const hasPos = item.x !== 0 || item.y !== 0;
  const posTag = hasPos ? `{\\pos(${px},${py})}` : "";
  const D = Math.round(item.dur * 1000);
  const text = applyCase(item.content, item.style.case);
  const start = item.at;
  const end = item.at + item.dur;

  const splits =
    item.animIn === "typewriter" ||
    item.animIn === "word" ||
    item.animIn === "wordpop" ||
    item.animIn === "karaoke";
  if (splits) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      const out: string[] = [];
      if (item.animIn === "typewriter") {
        // Growing prefix, staggered starts.
        const step = Math.min(0.12, item.dur / words.length);
        words.forEach((_, i) => {
          const s = start + i * step;
          const e = i === words.length - 1 ? end : start + (i + 1) * step;
          out.push(dialogue(1, s, e, style, posTag + escapeText(words.slice(0, i + 1).join(" "))));
        });
      } else {
        // word, word pop, karaoke on a text: one word at a time.
        const step = item.dur / words.length;
        words.forEach((word, i) => {
          const tags = `${hasPos ? `\\pos(${px},${py})` : ""}${item.animIn === "wordpop" ? POP_IN : ""}`;
          const lead = tags ? `{${tags}}` : "";
          out.push(dialogue(1, start + i * step, start + (i + 1) * step, style, lead + braces(word)));
        });
      }
      return out;
    }
  }

  let tags = "";
  if (item.animIn === "slideup") tags += `\\move(${px},${py + 60},${px},${py},0,200)`;
  else if (item.animOut === "slideup") tags += `\\move(${px},${py},${px},${py - 60},${Math.max(0, D - 200)},${D})`;
  else if (hasPos) tags += `\\pos(${px},${py})`;
  const fadIn = item.animIn === "fade" ? 160 : 0;
  const fadOut = item.animOut === "fade" ? 160 : 0;
  if (fadIn || fadOut) tags += `\\fad(${fadIn},${fadOut})`;
  if (item.animIn === "pop") tags += POP_IN;
  if (item.animIn === "emphasis") tags += "\\t(0,200,\\fscx106\\fscy106)";
  if (item.animIn === "focus") tags += "\\alpha&H80&\\t(0,200,\\alpha&H00&)";
  if (item.animOut === "pop" || item.animOut === "emphasis")
    tags += `\\t(${Math.max(0, D - 200)},${D},\\fscx90\\fscy90)`;
  if (item.animOut === "focus") tags += `\\t(${Math.max(0, D - 200)},${D},\\alpha&H80&)`;
  const lead = tags ? `{${tags}}` : "";
  return [dialogue(1, start, end, style, lead + escapeText(text))];
}

/**
 * The whole ASS file: Script Info, one Style per distinct look (C for
 * captions, T1..Tn for text items), and every Dialogue event. Chunks and
 * text item times are OUTPUT time. Karaoke turns on when the caption style
 * has an accent color and the chosen template defines one.
 */
export function assFromDoc(input: {
  chunks: CaptionChunk[];
  texts: TextItem[];
  captions: CaptionSettings;
  playResX?: number;
  playResY?: number;
}): string {
  const w = input.playResX ?? 1080;
  const h = input.playResY ?? 1920;
  const cap = input.captions;

  const styleLines: string[] = [];
  const events: string[] = [];

  if (cap.enabled) {
    const template = CAPTION_TEMPLATES.find((t) => t.id === cap.template);
    const karaoke = Boolean(cap.style.accentColor) && Boolean(template?.style.accentColor);
    styleLines.push(styleLine("C", cap.style, hexToAss(karaoke ? cap.style.accentColor : cap.style.color)));
    const overrides = new Map(cap.breaks.map((b) => [b.chunkIndex, b.text]));
    const { px, py } = posOf(cap.style.x, cap.style.y, w, h);
    const posTag = cap.style.x !== 0 || cap.style.y !== 0 ? `{\\pos(${px},${py})}` : "";
    input.chunks.forEach((chunk, i) => {
      const text = applyCase(overrides.get(i) ?? chunk.text, cap.style.case);
      // An override with empty text removes that caption entirely.
      if (!text.trim()) return;
      const body = karaoke ? karaokeText(text, chunk.end - chunk.start) : escapeText(text);
      events.push(dialogue(0, chunk.start, chunk.end, "C", posTag + body));
    });
  }

  const styleNames = new Map<string, string>();
  for (const item of input.texts) {
    const key = JSON.stringify(item.style);
    let name = styleNames.get(key);
    if (!name) {
      name = `T${styleNames.size + 1}`;
      styleNames.set(key, name);
      styleLines.push(styleLine(name, item.style, hexToAss(item.style.color)));
    }
    events.push(...textEvents(item, name, w, h));
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
