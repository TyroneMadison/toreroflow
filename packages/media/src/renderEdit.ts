/**
 * The render engine. buildRenderPlan is pure: doc + EDL + assets in, the full
 * ffmpeg argument list out, so the check can pin it without running ffmpeg.
 * renderEdit spawns ffmpeg on a plan and reports whole-percent progress.
 *
 * Renders from ORIGINAL sources. Per EDL segment: trim + setpts, per-clip fx
 * (eq color merged with universal color, colortemperature warmth, rotate,
 * audio volume), fit + pad to the output size (or, when the clip was zoomed
 * or moved, the preview's cover + scale + translate via fxFrame), zoom items,
 * then concat.
 * Overlays (broll, graphics) ride on top with enable windows, audio items
 * are delayed and amixed, captions arrive as one ASS file via the subtitles
 * filter last.
 *
 * Zoom approach: crop's w/h expressions are evaluated once at filter config,
 * so an animated zoom cannot be built from crop alone, and per-frame scale
 * expressions are fragile across ffmpeg builds. Each segment that carries a
 * zoom is therefore normalized to the output fps and run through zoompan
 * (d=1, s=WxH) with a z expression clocked by on/fps, which is segment-local
 * seconds after the fps normalize. zoompan's integer x/y rounding can show a
 * tiny jitter on slow push-ins; accepted, it matches the preview closely.
 */

import { spawn } from "node:child_process";
import {
  ZOOM,
  applyClipFx,
  cropPx,
  layoutAt,
  layoutBoundaries,
  outputDuration,
  panelsFor,
  enhanceChain,
  faceCenterAt,
  pointInFrame,
  transitionJoins,
  type EditDoc,
  type EmojiOverlay,
  type FaceTrack,
  type EdlSegment,
} from "@toreroflow/core";

export interface RenderAssetInfo {
  id: string;
  kind: string;
  path: string;
  durationSec: number;
  width: number;
  height: number;
  /**
   * Probed by the worker. Undefined means "assume yes", which is what every
   * plan built before this field existed did, so old callers render the same.
   */
  hasAudio?: boolean;
}

export interface RenderOutput {
  /** Where ffmpeg writes the file; the args must name it, so it lives here. */
  path: string;
  width: number;
  height: number;
  fps: number;
  format: "mp4" | "mov";
  videoBitrateK: number;
}

export interface RenderPlanInput {
  doc: EditDoc;
  edl: EdlSegment[];
  assets: RenderAssetInfo[];
  assPath: string | null;
  /** Passed to subtitles=fontsdir so libass finds the bundled fonts. */
  fontsDir?: string;
  out: RenderOutput;
  /** Phase 7: face tracks by asset id, so face zooms aim at the real face. */
  faceTracks?: Record<string, FaceTrack>;
  /** Phase 7: colour emoji (caption emojis + stickers) and where the PNGs live. */
  emoji?: { dir: string; overlays: EmojiOverlay[] };
  /** Phase 7: output-time spans of censored words (bleeped or muted per doc.censor). */
  censorSpans?: { start: number; end: number }[];
}

export interface RenderPlan {
  args: string[];
  totalOutSec: number;
}

/** Numbers in filter strings: at most 3 decimals, no trailing zeros. */
const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * Filter-graph level-1 escaping for a path option value: forward slashes
 * (libass accepts them on Windows), then escape the characters the graph
 * parser treats as structure.
 */
const escapePath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/([':,;[\] ])/g, "\\$1");

interface SegZoom {
  t0: number;
  kind: "pushin" | "punchin" | "quickzoom";
  size: "s" | "m" | "l";
  /** Phase 5: explicit scale curve, seconds from t0; wins over kind. */
  curve?: { t: number; scale: number }[];
  anchor?: "face" | "center";
}

/** Where a face sits in a talking-head frame, as a fraction of height. */
export const FACE_Y = 0.38;

/**
 * One zoompan for every zoom on a segment. Later items win, so each wraps
 * the previous expression as its fallback, mirroring the preview's
 * "last one wins" rule. The whole z expression is quoted so its commas
 * survive the graph parser.
 */
function zoompanFor(
  zooms: SegZoom[],
  segLen: number,
  fps: number,
  w: number,
  h: number,
  face?: { x: number; y: number } | null,
): string {
  const T = `(on/${fps})`;
  let z = "1";
  const q = ZOOM.quickzoom;
  for (const item of zooms) {
    const S = ZOOM[item.kind].scale[item.size];
    const t0 = item.t0;
    const c = item.curve;
    if (c && c.length > 1) {
      // Piecewise linear through the points, 1 outside the curve.
      let inner = n(c[c.length - 1].scale);
      for (let k = c.length - 1; k >= 1; k--) {
        const a = c[k - 1];
        const b = c[k];
        const span = Math.max(0.001, b.t - a.t);
        inner = `if(lt(${T},${n(t0 + b.t)}),${n(a.scale)}+${n(b.scale - a.scale)}*(${T}-${n(t0 + a.t)})/${n(span)},${inner})`;
      }
      z = `if(between(${T},${n(t0 + c[0].t)},${n(t0 + c[c.length - 1].t)}),${inner},${z})`;
      continue;
    }
    if (item.kind === "pushin") {
      // Linear ramp 1 -> S from t0 to the segment end.
      const dur = Math.max(0.001, segLen - t0);
      z = `if(gte(${T},${n(t0)}),1+${n(S - 1)}*min((${T}-${n(t0)})/${n(dur)},1),${z})`;
    } else if (item.kind === "punchin") {
      z = `if(gte(${T},${n(t0)}),${n(S)},${z})`;
    } else {
      // quickzoom: ramp in, hold, ramp out.
      const tIn = t0 + q.inSec;
      const tHold = tIn + q.holdSec;
      const tEnd = tHold + q.outSec;
      z =
        `if(between(${T},${n(t0)},${n(tEnd)}),` +
        `if(lt(${T},${n(tIn)}),1+${n(S - 1)}*(${T}-${n(t0)})/${n(q.inSec)},` +
        `if(lt(${T},${n(tHold)}),${n(S)},` +
        `${n(S)}-${n(S - 1)}*(${T}-${n(tHold)})/${n(q.outSec)})),${z})`;
    }
  }
  // Face anchor: the real face centre (faces.json, mapped into the frame at
  // the zoom's start) when the worker passed a track; else the fixed
  // upper-middle point where a reframed face usually sits.
  // ponytail: one anchor per segment, not per frame.
  const faceZoom = zooms.some((zz) => zz.anchor === "face");
  const fx = faceZoom && face ? face.x : 0.5;
  const fy = faceZoom ? (face ? face.y : FACE_Y) : 0.5;
  const xExpr = fx === 0.5 ? "iw/2-(iw/zoom/2)" : `iw*${n(fx)}-(iw/zoom*${n(fx)})`;
  const yExpr = fy === 0.5 ? "ih/2-(ih/zoom/2)" : `ih*${n(fy)}-(ih/zoom*${n(fy)})`;
  return `zoompan=z='${z}':x='${xExpr}':y='${yExpr}':d=1:s=${w}x${h}:fps=${fps}`;
}

/**
 * The preview's per-clip framing (CSS object-fit cover, then scale(zoom),
 * then translate(x%, y%) of the stage) as filters, so export equals preview.
 * Cover-scale to the zoomed size, pad by one frame on every side when the
 * picture can expose an edge (zoom under 1 or any move), then crop the output
 * window shifted opposite the move. Offsets clamp to one frame, which is
 * already fully off screen.
 */
export function fxFrame(zoom: number, xPct: number, yPct: number, W: number, H: number): string[] {
  const z = Math.max(0.1, zoom);
  const dx = Math.max(-W, Math.min(W, (xPct / 100) * W));
  const dy = Math.max(-H, Math.min(H, (yPct / 100) * H));
  const sw = Math.max(2, Math.round((W * z) / 2) * 2);
  const sh = Math.max(2, Math.round((H * z) / 2) * 2);
  const out = [`scale=w=${sw}:h=${sh}:force_original_aspect_ratio=increase:force_divisible_by=2`];
  if (z < 1 || dx !== 0 || dy !== 0) out.push(`pad=w=iw+${2 * W}:h=ih+${2 * H}:x=${W}:y=${H}`);
  out.push(`crop=${W}:${H}:x='(iw-${W})/2${dx > 0 ? "-" : "+"}${n(Math.abs(dx))}':y='(ih-${H})/2${dy > 0 ? "-" : "+"}${n(Math.abs(dy))}'`);
  out.push("setsar=1");
  return out;
}

/** Splits EDL segments at layout boundaries (shots, manual overrides). */
export function splitAtLayouts(doc: EditDoc, edl: EdlSegment[]): EdlSegment[] {
  const hasAny = Object.keys(doc.shots ?? {}).length > 0 || Object.keys(doc.shotAdjust ?? {}).length > 0;
  if (!hasAny) return edl;
  const outList: EdlSegment[] = [];
  for (const seg of edl) {
    let a = seg.srcIn;
    for (const t of layoutBoundaries(doc, seg.assetId, seg.srcIn, seg.srcOut)) {
      outList.push({ ...seg, srcIn: a, srcOut: t });
      a = t;
    }
    outList.push({ ...seg, srcIn: a, srcOut: seg.srcOut });
  }
  // ponytail: a zoom binds to the piece it starts in, so a push-in that
  // crosses a layout change ramps over that piece only. Fine for now.
  return outList;
}

/**
 * Filter statements for one segment under a layout. head is "[idx:v]trim,...";
 * the result ends in [label]. fill crops one rect; split/screenshare crop two
 * rects and vstack them; fit lays the whole frame over a blurred cover, black
 * or a color.
 */
export function layoutFilters(
  lay: ReturnType<typeof layoutAt>,
  fx: EditDoc["clipFx"][string] | undefined,
  head: string,
  label: string,
  tail: string[],
  sw: number,
  sh: number,
  W: number,
  H: number,
  srcIn = 0,
): string[] {
  const srcA = sw / sh;
  const end = tail.length ? `,${tail.join(",")}` : "";
  if (lay.kind === "fit") {
    const fg = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
    if (lay.fitBg === "blur") {
      return [
        `${head},split=2[${label}f][${label}b]`,
        `[${label}b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[${label}bg]`,
        `[${label}f]${fg}[${label}fg]`,
        `[${label}bg][${label}fg]overlay=(W-w)/2:(H-h)/2,setsar=1${end}[${label}]`,
      ];
    }
    const color = lay.fitBg === "color" && lay.bgColor ? `0x${lay.bgColor.replace(/^#/, "")}` : "black";
    return [`${head},${fg},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1${end}[${label}]`];
  }
  const panels = panelsFor(lay.kind as Exclude<typeof lay.kind, "legacy">, W, H);
  const crop = (k: number) => {
    const p = panels[k];
    const r = k === 0 ? applyClipFx(lay.crops[k], fx, p.w / p.h, srcA) : lay.crops[k];
    const c = cropPx(r, sw, sh);
    return `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${p.w}:${p.h},setsar=1`;
  };
  if (panels.length === 1 && lay.keys?.length) {
    // Moving speaker: a fixed-size window whose x/y follow the keys,
    // piecewise linear in source time (the piece's t restarts at 0).
    const p = panels[0];
    const at = (k: { x: number; y: number }) =>
      cropPx(applyClipFx({ ...lay.crops[0], x: k.x, y: k.y }, fx, p.w / p.h, srcA), sw, sh);
    const c0 = at(lay.keys[0]);
    const expr = (axis: "x" | "y") => {
      const ks = lay.keys!;
      let e = String(at(ks[ks.length - 1])[axis]);
      for (let k = ks.length - 1; k >= 1; k--) {
        const a = ks[k - 1];
        const b = ks[k];
        const va = at(a)[axis];
        const vb = at(b)[axis];
        const T = `(t+${n(srcIn)})`;
        const seg =
          a.ease === "hold" || b.t <= a.t || va === vb
            ? String(va)
            : `${va}+(${vb - va})*(${T}-${n(a.t)})/${n(b.t - a.t)}`;
        e = `if(lt(${T},${n(b.t)}),${seg},${e})`;
      }
      return `if(lt((t+${n(srcIn)}),${n(ks[0].t)}),${at(ks[0])[axis]},${e})`;
    };
    return [`${head},crop=${c0.w}:${c0.h}:x='${expr("x")}':y='${expr("y")}',scale=${p.w}:${p.h},setsar=1${end}[${label}]`];
  }
  if (panels.length === 1) return [`${head},${crop(0)}${end}[${label}]`];
  return [
    `${head},split=2[${label}p0][${label}p1]`,
    `[${label}p0]${crop(0)}[${label}q0]`,
    `[${label}p1]${crop(1)}[${label}q1]`,
    `[${label}q0][${label}q1]vstack=inputs=2${end}[${label}]`,
  ];
}

export function buildRenderPlan(input: RenderPlanInput): RenderPlan {
  const { doc, assets, assPath, fontsDir, out } = input;
  // Split segments where a shot or manual layout override changes, so each
  // piece renders with one layout. With no shots or overrides this is the
  // input EDL untouched, which keeps the v1 golden plan byte-identical.
  const edl = splitAtLayouts(doc, input.edl);
  if (edl.length === 0) throw new Error("cannot render an empty edit");

  const byId = new Map(assets.map((a) => [a.id, a]));
  const pathOf = (assetId: string): string => {
    const a = byId.get(assetId);
    if (!a) throw new Error(`asset ${assetId} missing from the plan input`);
    return a.path;
  };

  // One -i per unique path: EDL first-appearance order, then broll, graphics, audio.
  const inputPaths: string[] = [];
  const inputIdxByPath = new Map<string, number>();
  const inputIdx = (assetId: string): number => {
    const p = pathOf(assetId);
    let i = inputIdxByPath.get(p);
    if (i === undefined) {
      i = inputPaths.length;
      inputPaths.push(p);
      inputIdxByPath.set(p, i);
    }
    return i;
  };
  for (const seg of edl) inputIdx(seg.assetId);
  for (const b of doc.broll) inputIdx(b.assetId);
  for (const g of doc.graphics) inputIdx(g.assetId);
  for (const a of doc.audio) inputIdx(a.assetId);

  const segStart: number[] = [];
  {
    let t = 0;
    for (const s of edl) {
      segStart.push(t);
      t += s.srcOut - s.srcIn;
    }
  }

  // Bind each zoom to the last segment whose output start <= at (preview rule).
  const zoomsBySeg = new Map<number, SegZoom[]>();
  for (const z of doc.zooms) {
    let i = -1;
    for (let k = edl.length - 1; k >= 0; k--) {
      if (z.at >= segStart[k]) {
        i = k;
        break;
      }
    }
    if (i < 0) continue;
    const list = zoomsBySeg.get(i) ?? [];
    list.push({
      t0: Math.max(0, z.at - segStart[i]),
      kind: z.kind,
      size: z.size,
      ...(z.curve ? { curve: z.curve } : {}),
      ...(z.anchor ? { anchor: z.anchor } : {}),
    });
    zoomsBySeg.set(i, list);
  }

  const W = out.width;
  const H = out.height;
  const F = out.fps;
  // Fit + pad every segment to the exact output size BEFORE concat, because
  // concat requires matching frame sizes; sources are 9:16 but mismatches
  // must not break the render. setsar guards against odd source SARs.
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const evenPx = (px: number): number => Math.max(2, Math.round(px / 2) * 2);

  const fc: string[] = [];

  edl.forEach((seg, i) => {
    const idx = inputIdx(seg.assetId);
    const fx = doc.clipFx[seg.clipId ?? seg.assetId];
    const b = doc.color.b + (fx?.color?.b ?? 0);
    const c = doc.color.c + (fx?.color?.c ?? 0);
    const s = doc.color.s + (fx?.color?.s ?? 0);
    const w = doc.color.w + (fx?.color?.w ?? 0);

    const v: string[] = [
      `trim=start=${n(seg.srcIn)}:end=${n(seg.srcOut)}`,
      "setpts=PTS-STARTPTS",
    ];
    // Same v/200 mapping as the preview's CSS filter; eq brightness is an
    // additive offset, close enough at these ranges.
    if (b || c || s) {
      v.push(`eq=brightness=${n(b / 200)}:contrast=${n(1 + c / 200)}:saturation=${n(1 + s / 200)}`);
    }
    // Warmth: neutral 6500K, +-100 sweeps 4500K (warm) to 8500K (cool).
    if (w) v.push(`colortemperature=temperature=${Math.round(6500 - w * 20)}`);
    if (fx?.rotate) v.push(`rotate=${n(fx.rotate)}*PI/180`);
    const src = byId.get(seg.assetId);
    const lay = layoutAt(doc, seg.clipId, seg.assetId, seg.srcIn, src?.width ?? W, src?.height ?? H, W, H);
    const zooms = zoomsBySeg.get(i);
    let face: { x: number; y: number } | null = null;
    const track = input.faceTracks?.[seg.assetId];
    if (track && zooms?.some((z) => z.anchor === "face")) {
      const t0 = Math.min(...zooms.filter((z) => z.anchor === "face").map((z) => z.t0));
      const c = faceCenterAt(track, seg.srcIn + t0);
      const srcA = (src?.width || W) / (src?.height || H);
      // Single-panel fills map through their crop; fit and legacy through the
      // letterbox; split/screenshare keep the fixed point.
      if (c && (lay.kind === "fill" || lay.kind === "fit" || lay.kind === "legacy")) {
        face = pointInFrame(c, lay.kind === "fill" ? lay.crops[0] : null, srcA, W / H);
      }
    }
    const zoomTail = zooms?.length ? [`fps=${F}`, zoompanFor(zooms, seg.srcOut - seg.srcIn, F, W, H, face)] : [];
    if (lay.kind === "legacy") {
      const fxMoved = !!fx && ((fx.zoom ?? 1) !== 1 || (fx.x ?? 0) !== 0 || (fx.y ?? 0) !== 0);
      if (fxMoved) v.push(...fxFrame(fx.zoom ?? 1, fx.x ?? 0, fx.y ?? 0, W, H));
      else v.push(fit);
      v.push(...zoomTail);
      fc.push(`[${idx}:v]${v.join(",")}[v${i}]`);
    } else {
      const sw = src?.width || W;
      const sh = src?.height || H;
      fc.push(...layoutFilters(lay, fx, `[${idx}:v]${v.join(",")}`, `v${i}`, zoomTail, sw, sh, W, H, seg.srcIn));
    }

    // A main clip with no audio stream gets generated silence for exactly its
    // segment, so concat still has an audio pad to pair and the render lives.
    if (byId.get(seg.assetId)?.hasAudio === false) {
      fc.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(seg.srcOut - seg.srcIn)}[a${i}]`);
      return;
    }
    const a: string[] = [
      `atrim=start=${n(seg.srcIn)}:end=${n(seg.srcOut)}`,
      "asetpts=PTS-STARTPTS",
    ];
    const vol = fx?.volume ?? 100;
    if (vol !== 100) a.push(`volume=${n(vol / 100)}`);
    fc.push(`[${idx}:a]${a.join(",")}[a${i}]`);
  });

  const joins = transitionJoins(doc.transitions, edl);
  if (joins.length === 0) {
    fc.push(edl.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${edl.length}:v=1:a=1[vcat][acat]`);
  } else {
    // Phase 7 transitions, duration-preserving: segments between joins are
    // concatenated into runs, normalized to one fps/format (xfade needs it),
    // then each run joins the next with the outgoing side frozen for dur
    // (tpad clone) and an xfade at the join's output time. Output length,
    // and so caption timing, never moves. Audio stays a plain concat.
    // ponytail: the outgoing picture holds still during the transition.
    const starts = [0, ...joins.map((j) => j.seg), edl.length];
    const runs: string[] = [];
    for (let k = 0; k + 1 < starts.length; k++) {
      const from = starts[k];
      const to = starts[k + 1];
      const label = `r${k}`;
      const parts = Array.from({ length: to - from }, (_, m) => `[v${from + m}]`).join("");
      const head = to - from === 1 ? parts : `${parts}concat=n=${to - from}:v=1:a=0,`;
      fc.push(`${head}fps=${F},format=yuv420p,setsar=1[${label}]`);
      runs.push(label);
    }
    let cur = runs[0];
    joins.forEach((j, k) => {
      const next = k === joins.length - 1 ? "vcat" : `x${k}`;
      fc.push(`[${cur}]tpad=stop_mode=clone:stop_duration=${n(j.dur)}[p${k}]`);
      fc.push(`[p${k}][${runs[k + 1]}]xfade=transition=${j.xfade}:duration=${n(j.dur)}:offset=${n(j.at)}[${next}]`);
      cur = next;
    });
    fc.push(edl.map((_, i) => `[a${i}]`).join("") + `concat=n=${edl.length}:v=0:a=1[acat]`);
  }

  // Overlays: broll first, then graphics on top. x/y are percent offsets
  // from center (the preview's calc(50% + x%)), scale is a fraction of the
  // stage width. A single-frame image input works because overlay's default
  // eof_action=repeat holds the frame and enable gates visibility.
  const overlays: { label: string; x: number; y: number; at: number; dur: number }[] = [];
  doc.broll.forEach((item, k) => {
    const idx = inputIdx(item.assetId);
    const chain: string[] = [
      `trim=start=0:end=${n(item.dur)}`,
      "setpts=PTS-STARTPTS",
      `scale=${evenPx(W * item.scale)}:-2`,
    ];
    if (item.fadeIn > 0 || item.fadeOut > 0) {
      chain.push("format=yuva420p");
      if (item.fadeIn > 0) chain.push(`fade=t=in:st=0:d=${n(item.fadeIn)}:alpha=1`);
      if (item.fadeOut > 0) {
        chain.push(
          `fade=t=out:st=${n(Math.max(0, item.dur - item.fadeOut))}:d=${n(item.fadeOut)}:alpha=1`,
        );
      }
    }
    chain.push(`setpts=PTS+${n(item.at)}/TB`);
    const label = `ob${k}`;
    fc.push(`[${idx}:v]${chain.join(",")}[${label}]`);
    overlays.push({ label, x: item.x, y: item.y, at: item.at, dur: item.dur });
  });
  doc.graphics.forEach((item, k) => {
    const idx = inputIdx(item.assetId);
    const chain: string[] = [`scale=${evenPx(W * item.scale)}:-2`, "format=yuva420p"];
    if (item.opacity < 100) chain.push(`colorchannelmixer=aa=${n(item.opacity / 100)}`);
    if (item.rotate) {
      const rad = `${n(item.rotate)}*PI/180`;
      chain.push(`rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black@0`);
    }
    chain.push(`setpts=PTS+${n(item.at)}/TB`);
    const label = `og${k}`;
    fc.push(`[${idx}:v]${chain.join(",")}[${label}]`);
    overlays.push({ label, x: item.x, y: item.y, at: item.at, dur: item.dur });
  });

  // Signed offset term, so a negative never prints as "+-0.2*W".
  const off = (pct: number, dim: string): string =>
    `${pct < 0 ? "-" : "+"}${n(Math.abs(pct) / 100)}*${dim}`;
  let vcur = "vcat";
  overlays.forEach((o, k) => {
    const next = `vo${k}`;
    fc.push(
      `[${vcur}][${o.label}]overlay=x=(W-w)/2${off(o.x, "W")}:y=(H-h)/2${off(o.y, "H")}` +
        `:enable='between(t,${n(o.at)},${n(o.at + o.dur)})'[${next}]`,
    );
    vcur = next;
  });

  // Phase 7 colour emoji (caption emojis, stickers): one single-frame PNG input
  // each, scaled to size, gated by enable. Inputs come after every v1 input
  // so plans without emoji keep their input order.
  const emojiInputs: string[] = [];
  (input.emoji?.overlays ?? []).forEach((e, k) => {
    const idx = inputPaths.length + emojiInputs.length;
    emojiInputs.push(`${input.emoji!.dir.replace(/\\/g, "/")}/${e.file}`);
    fc.push(`[${idx}:v]scale=${e.size}:${e.size},format=rgba[em${k}]`);
    const next = `ve${k}`;
    fc.push(`[${vcur}][em${k}]overlay=x=${e.x}:y=${e.y}:enable='between(t,${n(e.start)},${n(e.end)})'[${next}]`);
    vcur = next;
  });

  // Phase 7 progress bar: a solid strip sliding in from the left, its right
  // edge at W * t / total, so it is full exactly at the end.
  const pb = doc.overlays?.progress;
  if (pb?.on) {
    const total = outputDuration(edl);
    const ph = Math.max(2, Math.round((pb.height * H) / 1920 / 2) * 2);
    fc.push(`color=c=0x${pb.color.replace(/^#/, "")}:s=${W}x${ph}:r=${F}:d=${n(total)}[pbar]`);
    fc.push(
      `[${vcur}][pbar]overlay=x='-W+W*t/${n(Math.max(0.001, total))}':y=${pb.position === "top" ? 0 : "H-h"}:eof_action=pass[vpb]`,
    );
    vcur = "vpb";
  }

  // Global fps after concat, subtitles last so captions and texts sit above
  // everything at final output timing.
  const post: string[] = [`fps=${F}`];
  if (assPath) {
    post.push(
      `subtitles=filename=${escapePath(assPath)}` +
        (fontsDir ? `:fontsdir=${escapePath(fontsDir)}` : ""),
    );
  }
  fc.push(`[${vcur}]${post.join(",")}[vout]`);

  // Audio items: trimmed, volume, shifted with adelay, mixed over the clip
  // audio without renormalizing. srcIn is where the item starts in its SOURCE
  // file: detached clip audio carries it so the sound lines up with footage
  // that does not begin at the top of the take. B-roll sound joins the same
  // mix, but only when the worker probed an audio stream on that file
  // (hasAudio true): a missing [idx:a] pad kills the whole filtergraph.
  const mixLabels: string[] = [];
  doc.audio.forEach((item, k) => {
    const idx = inputIdx(item.assetId);
    const from = item.srcIn ?? 0;
    const chain: string[] = [
      `atrim=start=${n(from)}:end=${n(from + item.dur)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (item.volume !== 100) chain.push(`volume=${n(item.volume / 100)}`);
    chain.push(`adelay=${Math.max(0, Math.round(item.at * 1000))}:all=1`);
    fc.push(`[${idx}:a]${chain.join(",")}[au${k}]`);
    mixLabels.push(`[au${k}]`);
  });
  doc.broll.forEach((item, k) => {
    if (item.volume <= 0 || byId.get(item.assetId)?.hasAudio !== true) return;
    const idx = inputIdx(item.assetId);
    const chain: string[] = [`atrim=start=0:end=${n(item.dur)}`, "asetpts=PTS-STARTPTS"];
    if (item.volume !== 100) chain.push(`volume=${n(item.volume / 100)}`);
    if (item.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${n(item.fadeIn)}`);
    if (item.fadeOut > 0) {
      chain.push(`afade=t=out:st=${n(Math.max(0, item.dur - item.fadeOut))}:d=${n(item.fadeOut)}`);
    }
    chain.push(`adelay=${Math.max(0, Math.round(item.at * 1000))}:all=1`);
    fc.push(`[${idx}:a]${chain.join(",")}[ab${k}]`);
    mixLabels.push(`[ab${k}]`);
  });
  let acur = "acat";
  // Phase 7 enhance speech (highpass, denoise, loudnorm back at 48k) and the
  // censor: listed words muted on the voice track, plus a sine bleep that
  // only sounds inside those spans.
  const enh = enhanceChain(doc.enhance);
  const spans = doc.censor && doc.censor.audio !== "off" ? (input.censorSpans ?? []) : [];
  if (enh.length || spans.length) {
    const chain = [...enh];
    if (enh.length) chain.push("aresample=48000");
    const inSpan = spans.map((sp) => `between(t,${n(sp.start)},${n(sp.end)})`).join("+");
    if (spans.length) chain.push(`volume=0:enable='${inSpan}'`);
    fc.push(`[acat]${chain.join(",")}[aclean]`);
    acur = "aclean";
    if (spans.length && doc.censor!.audio === "bleep") {
      const total = outputDuration(edl);
      fc.push(
        `sine=frequency=1000:sample_rate=48000:duration=${n(total)},volume=0.25,volume=0:enable='not(${inSpan})',aformat=channel_layouts=stereo[bleep]`,
      );
      mixLabels.push("[bleep]");
    }
  }
  if (mixLabels.length > 0) {
    fc.push(
      `[${acur}]` + mixLabels.join("") + `amix=inputs=${mixLabels.length + 1}:duration=first:normalize=0[aout]`,
    );
    acur = "aout";
  }

  const args: string[] = ["-y", "-nostats", "-progress", "pipe:1"];
  for (const p of inputPaths) args.push("-i", p);
  for (const p of emojiInputs) args.push("-i", p);
  args.push("-filter_complex", fc.join(";"), "-map", "[vout]", "-map", `[${acur}]`);
  const kbps = out.videoBitrateK;
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", `${kbps}k`,
    "-maxrate", `${Math.round(kbps * 1.5)}k`,
    "-bufsize", `${kbps * 2}k`,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
  );
  if (out.format === "mp4") args.push("-movflags", "+faststart", "-f", "mp4");
  else args.push("-f", "mov");
  args.push(out.path);

  return { args, totalOutSec: outputDuration(edl) };
}

/**
 * Runs a plan. Progress comes from -progress pipe:1 lines; out_time_ms is
 * microseconds despite the name (an ffmpeg quirk, it equals out_time_us).
 * Emits whole percents, deduplicated, clamped to 0..100.
 */
export function renderEdit(opts: {
  plan: RenderPlan;
  ffmpegBin?: string;
  onProgress?: (pct: number) => void;
}): Promise<void> {
  const bin = opts.ffmpegBin ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const { plan, onProgress } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, plan.args, { windowsHide: true });
    let errTail = "";
    child.stderr.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });
    let lineBuf = "";
    let lastPct = -1;
    const emit = (pct: number) => {
      const whole = Math.max(0, Math.min(100, Math.round(pct)));
      if (whole !== lastPct) {
        lastPct = whole;
        onProgress?.(whole);
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      lineBuf += d.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        const m = /^out_time_ms=(\d+)/.exec(line);
        if (m && plan.totalOutSec > 0) emit((Number(m[1]) / 1e6 / plan.totalOutSec) * 100);
        else if (line === "progress=end") emit(100);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${errTail.slice(-800)}`));
    });
  });
}
