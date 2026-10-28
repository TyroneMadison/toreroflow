/**
 * Layout + crop math shared by the preview and the renderer, so what the
 * operator frames in the phone preview is exactly what ffmpeg crops.
 * Pure and dependency-free. Phase 3 adds the auto reframe engine here; this
 * file already resolves its output (doc.shots) alongside manual overrides.
 *
 * Rect convention (see editDoc.ts): x/y are the crop center as an offset from
 * the source frame center, w/h the crop size, all fractions of the source
 * width and height. An output "panel" is a band of the output frame that one
 * crop fills: fill has one, split and screenshare stack two.
 */

import {
  DEFAULT_LAYOUT,
  type Aspect,
  type ClipFx,
  type ClipLayout,
  type EditDoc,
  type LayoutKind,
  type Rect,
} from "./editDoc";

/** Screenshare gives the screen this share of the output height, the face the rest. */
export const SCREENSHARE_TOP = 0.6;

export function aspectRatio(aspect: Aspect): number {
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

export interface Panel {
  /** Output-pixel band; x is always 0, panels span the full width. */
  y: number;
  w: number;
  h: number;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** The output bands for a layout, top to bottom, in output pixels (even sizes). */
export function panelsFor(kind: LayoutKind, W: number, H: number): Panel[] {
  if (kind === "split") {
    const top = even(H / 2);
    return [
      { y: 0, w: W, h: top },
      { y: top, w: W, h: H - top },
    ];
  }
  if (kind === "screenshare") {
    const top = even(H * SCREENSHARE_TOP);
    return [
      { y: 0, w: W, h: top },
      { y: top, w: W, h: H - top },
    ];
  }
  return [{ y: 0, w: W, h: H }];
}

/**
 * Forces a rect to a pixel aspect (panel w/h) on a source of aspect srcA,
 * keeping its center and as much of its height as fits, then clamps it inside
 * the frame. Every crop passes through here, so a hand-dragged rect can never
 * ask ffmpeg for pixels outside the source.
 */
export function fitRect(r: Rect, panelA: number, srcA: number): Rect {
  // In fraction units a rect's pixel aspect is (w*srcW)/(h*srcH) = (w/h)*srcA.
  const ratio = panelA / srcA; // required w/h in fraction units
  let h = Math.min(1, Math.max(0.02, r.h));
  let w = h * ratio;
  if (w > 1) {
    w = 1;
    h = w / ratio;
  }
  const x = Math.max(-0.5 + w / 2, Math.min(0.5 - w / 2, r.x));
  const y = Math.max(-0.5 + h / 2, Math.min(0.5 - h / 2, r.y));
  return { x, y, w, h };
}

/** The largest centered crop of a panel's aspect, offset horizontally by cx. */
function centered(panelA: number, srcA: number, cx = 0): Rect {
  return fitRect({ x: cx, y: 0, w: 1, h: 1 }, panelA, srcA);
}

/** Default crops before any manual drag or auto reframe. */
export function defaultCrops(kind: LayoutKind, W: number, H: number, srcA: number): Rect[] {
  const panels = panelsFor(kind, W, H);
  if (kind === "fit") return [];
  if (kind === "fill") return [centered(W / H, srcA)];
  if (kind === "split") {
    // Two speakers sit left and right on a wide two-shot.
    return panels.map((p, i) => centered(p.w / p.h, srcA, i === 0 ? -0.25 : 0.25));
  }
  // Screenshare: the whole screen up top, a face from the lower right below.
  const screen = centered(panels[0].w / panels[0].h, srcA);
  const face = fitRect({ x: 0.3, y: 0.2, w: 0.3, h: 0.45 }, panels[1].w / panels[1].h, srcA);
  return [screen, face];
}

export interface ResolvedLayout {
  /** "legacy" = no layout chosen: the v1 letterbox (or clipFx cover) path. */
  kind: LayoutKind | "legacy";
  crops: Rect[];
  fitBg: ClipLayout["fitBg"];
  bgColor?: string;
  /** Source span this layout holds for, so callers can split at changes. */
  start: number;
  end: number;
  /** True when a manual override decided it. */
  manual: boolean;
}

/**
 * The layout and crops in force at a source time of one main-track clip.
 * Precedence: a manual override covering t, then the clip's chosen layout
 * (using the auto shot's crops when the shot has the same layout), then the
 * auto shot, else legacy. Crops are already fitted to their panels.
 */
export function layoutAt(
  doc: Pick<EditDoc, "layout" | "shots" | "shotAdjust" | "output">,
  clipId: string | undefined,
  assetId: string,
  srcT: number,
  srcW: number,
  srcH: number,
  W: number,
  H: number,
): ResolvedLayout {
  const srcA = srcW > 0 && srcH > 0 ? srcW / srcH : W / H;
  const cl = (clipId && doc.layout?.[clipId]) || DEFAULT_LAYOUT;
  const adj = (doc.shotAdjust?.[assetId] ?? []).find((a) => srcT >= a.start && srcT < a.end);
  const shot = (doc.shots?.[assetId] ?? []).find((s) => srcT >= s.start && srcT < s.end);
  let kind: LayoutKind | "legacy" = "legacy";
  if (adj?.layout) kind = adj.layout;
  else if (cl.kind !== "auto") kind = cl.kind;
  else if (shot) kind = shot.layout;
  else if (adj?.crops?.length) kind = "fill";

  // The span this answer holds for: the tightest of the override / shot.
  let start = -Infinity;
  let end = Infinity;
  for (const s of [adj, shot]) {
    if (!s) continue;
    start = Math.max(start, s.start);
    end = Math.min(end, s.end);
  }
  // A boundary of the other list inside this span also changes the answer.
  for (const list of [doc.shotAdjust?.[assetId] ?? [], doc.shots?.[assetId] ?? []]) {
    for (const s of list) {
      if (s.start > srcT && s.start < end) end = s.start;
      if (s.end > srcT && s.end < end) end = s.end;
      if (s.end <= srcT && s.end > start) start = s.end;
      if (s.start <= srcT && s.start > start) start = s.start;
    }
  }
  if (kind === "legacy") {
    return { kind, crops: [], fitBg: cl.fitBg, bgColor: cl.bgColor, start, end, manual: false };
  }
  const panels = panelsFor(kind, W, H);
  const raw =
    adj?.crops && adj.crops.length >= (kind === "fit" ? 0 : panels.length)
      ? adj.crops
      : shot && shot.layout === kind && shot.crops.length >= panels.length
        ? shot.crops
        : defaultCrops(kind, W, H, srcA);
  const crops = kind === "fit" ? [] : panels.map((p, i) => fitRect(raw[i], p.w / p.h, srcA));
  return { kind, crops, fitBg: cl.fitBg, bgColor: cl.bgColor, start, end, manual: !!adj };
}

/**
 * The clip's own zoom/move applied inside the crop: zoom shrinks the window,
 * a move of x% shifts the picture right, so the window slides left by x% of
 * its own width. Clamped back inside the frame.
 */
export function applyClipFx(r: Rect, fx: Pick<ClipFx, "zoom" | "x" | "y"> | undefined, panelA: number, srcA: number): Rect {
  if (!fx) return r;
  const z = Math.max(1, fx.zoom ?? 1);
  const h = r.h / z;
  const w = r.w / z;
  // ponytail: zoom below 1 would need padding inside a layout; clamped to 1, pad later if asked.
  return fitRect({ x: r.x - ((fx.x ?? 0) / 100) * w, y: r.y - ((fx.y ?? 0) / 100) * h, w, h }, panelA, srcA);
}

/** A rect in source pixels, even and inside the frame, for ffmpeg crop. */
export function cropPx(r: Rect, srcW: number, srcH: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(srcW - (srcW % 2), even(r.w * srcW));
  const h = Math.min(srcH - (srcH % 2), even(r.h * srcH));
  const x = Math.max(0, Math.min(srcW - w, Math.round((0.5 + r.x) * srcW - w / 2)));
  const y = Math.max(0, Math.min(srcH - h, Math.round((0.5 + r.y) * srcH - h / 2)));
  return { x, y, w, h };
}

/**
 * CSS for showing a crop inside a panel box: the source video sized and
 * offset (in percent of the panel) so exactly the rect fills it. The preview
 * uses this, the renderer uses cropPx; both read the same rect.
 */
export function cropCss(r: Rect): { width: number; height: number; left: number; top: number } {
  const width = 100 / r.w;
  const height = 100 / r.h;
  return {
    width,
    height,
    left: -((0.5 + r.x - r.w / 2) / r.w) * 100,
    top: -((0.5 + r.y - r.h / 2) / r.h) * 100,
  };
}

/** Source-time boundaries in (a, b) where the layout may change. */
export function layoutBoundaries(
  doc: Pick<EditDoc, "shots" | "shotAdjust">,
  assetId: string,
  a: number,
  b: number,
): number[] {
  const set = new Set<number>();
  for (const list of [doc.shotAdjust?.[assetId] ?? [], doc.shots?.[assetId] ?? []]) {
    for (const s of list) {
      for (const t of [s.start, s.end]) if (t > a + 0.04 && t < b - 0.04) set.add(t);
    }
  }
  return [...set].sort((x, y) => x - y);
}
