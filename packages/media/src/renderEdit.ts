/**
 * The render engine. buildRenderPlan is pure: doc + EDL + assets in, the full
 * ffmpeg argument list out, so the check can pin it without running ffmpeg.
 * renderEdit spawns ffmpeg on a plan and reports whole-percent progress.
 *
 * Renders from ORIGINAL sources. Per EDL segment: trim + setpts, per-clip fx
 * (eq color merged with universal color, colortemperature warmth, rotate,
 * audio volume), fit + pad to the output size, zoom items, then concat.
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
import { ZOOM, outputDuration, type EditDoc, type EdlSegment } from "@toreroflow/core";

export interface RenderAssetInfo {
  id: string;
  kind: string;
  path: string;
  durationSec: number;
  width: number;
  height: number;
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
}

/**
 * One zoompan for every zoom on a segment. Later items win, so each wraps
 * the previous expression as its fallback, mirroring the preview's
 * "last one wins" rule. The whole z expression is quoted so its commas
 * survive the graph parser.
 */
function zoompanFor(zooms: SegZoom[], segLen: number, fps: number, w: number, h: number): string {
  const T = `(on/${fps})`;
  let z = "1";
  const q = ZOOM.quickzoom;
  for (const item of zooms) {
    const S = ZOOM[item.kind].scale[item.size];
    const t0 = item.t0;
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
  return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
}

export function buildRenderPlan(input: RenderPlanInput): RenderPlan {
  const { doc, edl, assets, assPath, fontsDir, out } = input;
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
    list.push({ t0: Math.max(0, z.at - segStart[i]), kind: z.kind, size: z.size });
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
    const fx = doc.clipFx[seg.assetId];
    const b = doc.color.b + (fx?.color.b ?? 0);
    const c = doc.color.c + (fx?.color.c ?? 0);
    const s = doc.color.s + (fx?.color.s ?? 0);
    const w = doc.color.w + (fx?.color.w ?? 0);

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
    v.push(fit);
    const zooms = zoomsBySeg.get(i);
    if (zooms?.length) v.push(`fps=${F}`, zoompanFor(zooms, seg.srcOut - seg.srcIn, F, W, H));
    fc.push(`[${idx}:v]${v.join(",")}[v${i}]`);

    // ponytail: main clips are assumed to carry an audio stream; a silent
    // source would need an anullsrc fallback per segment if that ever ships.
    const a: string[] = [
      `atrim=start=${n(seg.srcIn)}:end=${n(seg.srcOut)}`,
      "asetpts=PTS-STARTPTS",
    ];
    const vol = fx?.volume ?? 100;
    if (vol !== 100) a.push(`volume=${n(vol / 100)}`);
    fc.push(`[${idx}:a]${a.join(",")}[a${i}]`);
  });

  fc.push(edl.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${edl.length}:v=1:a=1[vcat][acat]`);

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
  // that does not begin at the top of the take. ponytail: broll audio is still
  // not mixed in; the plan does not know whether a broll file has an audio
  // stream, and a missing [idx:a] pad kills the whole filtergraph, so wiring
  // it needs hasAudio probed into RenderAssetInfo first.
  let acur = "acat";
  if (doc.audio.length > 0) {
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
    });
    fc.push(
      "[acat]" +
        doc.audio.map((_, k) => `[au${k}]`).join("") +
        `amix=inputs=${doc.audio.length + 1}:duration=first:normalize=0[aout]`,
    );
    acur = "aout";
  }

  const args: string[] = ["-y", "-nostats", "-progress", "pipe:1"];
  for (const p of inputPaths) args.push("-i", p);
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
