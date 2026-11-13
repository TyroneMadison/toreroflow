/**
 * Layout + crop math shared by the preview and the renderer, so what the
 * operator frames in the phone preview is exactly what ffmpeg crops.
 * Pure and dependency-free. autoReframe (bottom of the file) turns a face
 * track + scene cuts into doc.shots; layoutAt resolves those alongside
 * manual overrides.
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
  type ReframeKey,
  type Shot,
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
  /**
   * Tracking keys of a moving-speaker fill shot, fitted like crops. crops[0]
   * is already the keyed rect at the asked time; the renderer turns these
   * into a crop x/y expression.
   */
  keys?: ReframeKey[];
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
  // Keys only drive an auto fill shot nobody has dragged: a manual crop is a
  // deliberate static frame, and split/screenshare stay static by design.
  const useKeys = kind === "fill" && !adj?.crops?.length && shot?.layout === "fill" && !!shot.keys?.length;
  if (useKeys && shot?.keys) {
    const pA = panels[0].w / panels[0].h;
    const keys = shot.keys.map((k) => {
      const r = fitRect({ ...crops[0], x: k.x, y: k.y }, pA, srcA);
      return { ...k, x: r.x, y: r.y };
    });
    const at = keyAt(keys, srcT);
    crops[0] = fitRect({ ...crops[0], x: at.x, y: at.y }, pA, srcA);
    return { kind, crops, fitBg: cl.fitBg, bgColor: cl.bgColor, start, end, manual: false, keys };
  }
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

/** The keyed crop center at source time t: held before the first key and after the last. */
export function keyAt(keys: ReframeKey[], t: number): { x: number; y: number } {
  if (keys.length === 0) return { x: 0, y: 0 };
  if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t < b.t) {
      const a = keys[i - 1];
      if (a.ease === "hold" || b.t <= a.t) return { x: a.x, y: a.y };
      const f = (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  const z = keys[keys.length - 1];
  return { x: z.x, y: z.y };
}

/* ------------------------------------------------------------------------ */
/* Auto reframe engine                                                       */
/* ------------------------------------------------------------------------ */

/** One detected face: top-left box as frame fractions, as /faces writes it. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** Mouth motion since the previous sample (0..1). */
  mouth: number;
}

/** The captions service /faces output. */
export interface FaceTrack {
  fps: number;
  w: number;
  h: number;
  frames: { t: number; faces: FaceBox[] }[];
}

/** Tuning, all in frame fractions or seconds; the spec's numbers are the defaults. */
export const REFRAME = {
  /** A face this far (center) from its last sighting is someone else. */
  linkDist: 0.08,
  /** A track missing this long ends. */
  linkGap: 1,
  /** A track must be in this share of a shot's samples to count there. */
  presence: 0.3,
  /** Center std below this across the whole source is "holds still". */
  fakeStill: 0.006,
  /** Mouth p90 below this is "never moves its mouth" (YuNet patch delta). */
  fakeMouth: 0.0015,
  /** A face is active when its mouth variance is at least this share of the shot's top talker. */
  activeShare: 0.35,
  /** Moving speaker: center travel beyond this share of the frame width. */
  moveSpan: 0.15,
  deadZone: 0.04,
  maxSpeed: 0.25,
  ema: 0.15,
  /** Face center sits this far from the top of a split crop (headroom). */
  headroom: 0.4,
};

interface Track {
  id: number;
  t: number[];
  cx: number[];
  cy: number[];
  w: number[];
  h: number[];
  score: number[];
  mouth: number[];
  fake: boolean;
}

/** Greedy nearest-center linking, sample to sample. */
function linkTracks(track: FaceTrack): Track[] {
  const all: Track[] = [];
  let open: Track[] = [];
  for (const fr of track.frames) {
    open = open.filter((tr) => fr.t - tr.t[tr.t.length - 1] <= REFRAME.linkGap);
    const taken = new Set<Track>();
    const faces = [...fr.faces].sort((a, b) => b.score - a.score);
    for (const f of faces) {
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      let best: Track | undefined;
      let bd = Infinity;
      for (const tr of open) {
        if (taken.has(tr)) continue;
        const k = tr.t.length - 1;
        const d = Math.hypot(tr.cx[k] - cx, tr.cy[k] - cy);
        if (d < bd && d <= Math.max(REFRAME.linkDist, tr.w[k] * 0.6)) {
          bd = d;
          best = tr;
        }
      }
      if (!best) {
        best = { id: all.length, t: [], cx: [], cy: [], w: [], h: [], score: [], mouth: [], fake: false };
        all.push(best);
        open.push(best);
      }
      taken.add(best);
      best.t.push(fr.t);
      best.cx.push(cx);
      best.cy.push(cy);
      best.w.push(f.w);
      best.h.push(f.h);
      best.score.push(f.score);
      best.mouth.push(f.mouth);
    }
  }
  return all;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
const p90 = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

/**
 * isFake: a face that never moves its mouth and holds still across the whole
 * source (posters, photos, a face on a screen). Judged per linked track over
 * every sample it appears in, not per shot, so a listener who talks later in
 * the source is real.
 */
function markFakes(tracks: Track[]): void {
  for (const tr of tracks) {
    const still = std(tr.cx) < REFRAME.fakeStill && std(tr.cy) < REFRAME.fakeStill;
    tr.fake = tr.t.length >= 3 && still && p90(tr.mouth) < REFRAME.fakeMouth;
  }
}

interface ShotFace {
  tr: Track;
  idx: number[];
  faceness: number;
  motion: number;
  activeness: number;
  cx: number;
  cy: number;
  h: number;
}

/** Real faces present in [a, b), with faceness, activeness (z-scored motion) and mean center. */
function facesIn(tracks: Track[], a: number, b: number, samples: number): ShotFace[] {
  const out: ShotFace[] = [];
  for (const tr of tracks) {
    if (tr.fake) continue;
    const idx: number[] = [];
    tr.t.forEach((t, i) => {
      if (t >= a && t < b) idx.push(i);
    });
    if (idx.length < Math.max(1, samples * REFRAME.presence)) continue;
    const m = idx.map((i) => tr.mouth[i]);
    out.push({
      tr,
      idx,
      faceness: mean(idx.map((i) => tr.score[i])),
      // Variance of mouth motion plus its level: a talker's patch both
      // churns and swings, a listener's sits near the codec noise floor.
      motion: std(m) + mean(m),
      activeness: 0,
      cx: mean(idx.map((i) => tr.cx[i])),
      cy: mean(idx.map((i) => tr.cy[i])),
      h: mean(idx.map((i) => tr.h[i])),
    });
  }
  const mu = mean(out.map((f) => f.motion));
  const sd = std(out.map((f) => f.motion)) || 1;
  for (const f of out) f.activeness = out.length > 1 ? (f.motion - mu) / sd : 1;
  return out.sort((x, y) => y.motion - x.motion);
}

/**
 * Smooth tracking keys for a moving speaker: EMA (alpha) on the raw center,
 * a dead zone so small sways never move the camera, and a pan speed cap.
 * Keys are rect-center offsets (x - 0.5), thinned to real changes.
 */
export function trackingKeys(ts: number[], xs: number[], y: number): ReframeKey[] {
  if (!ts.length) return [];
  let ema = xs[0];
  let cam = xs[0];
  const keys: ReframeKey[] = [{ t: ts[0], x: cam - 0.5, y, zoom: 1, ease: "linear" }];
  for (let i = 1; i < ts.length; i++) {
    const dt = Math.max(1e-3, ts[i] - ts[i - 1]);
    ema += REFRAME.ema * (xs[i] - ema);
    const off = ema - cam;
    if (Math.abs(off) > REFRAME.deadZone) {
      // Move toward the target until it sits on the edge of the dead zone.
      const want = off - Math.sign(off) * REFRAME.deadZone;
      const step = Math.max(-REFRAME.maxSpeed * dt, Math.min(REFRAME.maxSpeed * dt, want));
      cam += step;
    }
    const last = keys[keys.length - 1];
    if (Math.abs(cam - 0.5 - last.x) >= 0.004) {
      keys.push({ t: ts[i], x: cam - 0.5, y, zoom: 1, ease: "linear" });
    }
  }
  const lastT = ts[ts.length - 1];
  if (keys[keys.length - 1].t < lastT) keys.push({ t: lastT, x: cam - 0.5, y, zoom: 1, ease: "linear" });
  return keys.map((k) => ({ ...k, t: Math.round(k.t * 1000) / 1000, x: Math.round(k.x * 1e4) / 1e4 }));
}

export interface ReframeOptions {
  /** Output panel size, for crop widths. */
  W: number;
  H: number;
}

/**
 * Face track + scene cuts + output size -> one Shot per camera shot.
 * Static crop per shot (an edit, not a robot camera); keys only when the
 * active face travels more than moveSpan of the frame inside one shot.
 */
export function autoReframe(track: FaceTrack, cuts: number[], duration: number, opts: ReframeOptions): Shot[] {
  const { W, H } = opts;
  const srcA = track.w > 0 && track.h > 0 ? track.w / track.h : 16 / 9;
  const tracks = linkTracks(track);
  markFakes(tracks);
  const bounds = [0, ...cuts.filter((c) => c > 0.05 && c < duration - 0.05).sort((a, b) => a - b), duration];
  const step = 1 / (track.fps || 5);
  const shots: Shot[] = [];
  const fillA = W / H;
  const fillW = fitRect({ x: 0, y: 0, w: 1, h: 1 }, fillA, srcA).w;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    if (b - a < 0.04) continue;
    const samples = Math.max(1, Math.round((b - a) / step));
    const faces = facesIn(tracks, a, b, samples);
    const r3 = (v: number) => Math.round(v * 1e4) / 1e4;
    const base = { start: r3(a), end: r3(b), auto: true as const };
    if (!faces.length) {
      shots.push({ ...base, layout: "fit", crops: [] });
      continue;
    }
    const top = faces[0];
    const actives = faces.filter((f) => f.motion >= top.motion * REFRAME.activeShare && f.motion > 0);
    const two = actives.length >= 2 ? [actives[0], actives[1]].sort((x, y) => x.cx - y.cx) : null;
    if (two && Math.abs(two[1].cx - two[0].cx) > fillW) {
      // Wide two-shot, both talking: two face-centered crops stacked.
      const panels = panelsFor("split", W, H);
      const crops = two.map((f, i) => {
        const pA = panels[i].w / panels[i].h;
        const h = Math.min(1, f.h * 3.2);
        // Face center sits `headroom` from the crop's top edge.
        return fitRect({ x: f.cx - 0.5, y: f.cy - 0.5 + (0.5 - REFRAME.headroom) * h, w: h, h }, pA, srcA);
      });
      shots.push({ ...base, layout: "split", crops });
      continue;
    }
    // ponytail: no screen/text detector, so screenshare = one small face in
    // a corner of a wide frame (the usual webcam-over-slides shot). A real
    // text-region detector would replace this guess.
    const corner = faces.length === 1 && top.h < 0.14 && (Math.abs(top.cx - 0.5) > 0.3 || Math.abs(top.cy - 0.5) > 0.3);
    if (corner) {
      const panels = panelsFor("screenshare", W, H);
      const screen = fitRect({ x: 0, y: 0, w: 1, h: 1 }, panels[0].w / panels[0].h, srcA);
      const fh = Math.min(1, top.h * 3);
      const face = fitRect({ x: top.cx - 0.5, y: top.cy - 0.5, w: fh, h: fh }, panels[1].w / panels[1].h, srcA);
      shots.push({ ...base, layout: "screenshare", crops: [screen, face] });
      continue;
    }
    const xs = top.idx.map((i) => top.tr.cx[i]);
    const crop = fitRect({ x: top.cx - 0.5, y: 0, w: 1, h: 1 }, fillA, srcA);
    if (Math.max(...xs) - Math.min(...xs) > REFRAME.moveSpan) {
      const ts = top.idx.map((i) => top.tr.t[i]);
      const keys = trackingKeys(ts, xs, 0).map((key) => {
        const r = fitRect({ ...crop, x: key.x }, fillA, srcA);
        return { ...key, x: r3(r.x) };
      });
      shots.push({ ...base, layout: "fill", crops: [{ ...crop, x: keys[0].x }], keys });
      continue;
    }
    shots.push({ ...base, layout: "fill", crops: [crop] });
  }
  return shots;
}

/** Whole-source facts the Layout panel shows next to the shots. */
export function faceStats(track: FaceTrack): { faces: number; fakes: number } {
  const tracks = linkTracks(track).filter((t) => t.t.length >= 3);
  markFakes(tracks);
  return { faces: tracks.filter((t) => !t.fake).length, fakes: tracks.filter((t) => t.fake).length };
}
