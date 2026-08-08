import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { join } from "node:path";

// Resolved lazily so dotenv (loaded by the host app) runs first.
const ffmpegBin = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobeBin = (): string => process.env.FFPROBE_PATH ?? "ffprobe";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  /** Codec names as ffprobe reports them, empty when the stream is absent. */
  videoCodec: string;
  audioCodec: string;
  /** Video pixel format, e.g. "yuv420p". Browsers decode little else. */
  pixFmt: string;
}

export async function probe(path: string): Promise<ProbeResult> {
  const out = await run(ffprobeBin(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    path,
  ]);
  const data = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  return {
    durationSec: Number.parseFloat(data.format?.duration ?? "0") || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    videoCodec: video?.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
    pixFmt: video?.pix_fmt ?? "",
  };
}

/**
 * Whether a file can go straight into a `<video>` element as it is.
 *
 * The editor's preview needs something the webview can decode. Making that
 * copy costs about as long as the transcription does, and for footage exported
 * by a phone or by CapCut it is spent turning an H.264 MP4 into a slightly
 * larger H.264 MP4. Sources that genuinely need it are ProRes, HEVC, 10-bit,
 * anything above 1080 wide (where the point is smooth scrubbing rather than
 * decodability), and audio the webview will not take.
 *
 * Deliberately conservative: a false negative costs the encode that used to
 * happen every time anyway, while a false positive is a preview that will not
 * play at all.
 */
export function isBrowserReady(meta: ProbeResult): boolean {
  return (
    meta.videoCodec === "h264" &&
    meta.pixFmt === "yuv420p" &&
    meta.width > 0 &&
    meta.width <= 1080 &&
    (meta.audioCodec === "aac" || meta.audioCodec === "")
  );
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; word: string }[];
}

// Uploaded VIDEOS are published exactly as exported: no reframe, no caption
// burn-in. Carousel slides are the exception, conformed below, because both
// platforms force every item in a set to one aspect ratio and "the operator
// crops each slide deliberately" is the entire feature.

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Conform one carousel slide to the set's geometry.
 *
 * With a crop rect (from the builder's pan/zoom), that exact region is cut
 * and scaled. Without one, the slide is center-cropped to fill: scale up to
 * cover the target, then cut the middle, which needs no knowledge of the
 * source dimensions.
 *
 * The output extension picks the path: .jpg writes one frame (this is also
 * what turns a WebP into something Instagram accepts), .mp4 re-encodes to
 * H.264 with its audio kept. Videos in a carousel are short by nature, so a
 * re-encode is seconds, not minutes.
 */
export async function conformSlide(
  input: string,
  output: string,
  target: { width: number; height: number },
  crop: CropRect | null,
): Promise<void> {
  const vf = crop
    ? `crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)},scale=${target.width}:${target.height}`
    : `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height}`;
  const args = ["-y", "-i", input];
  if (output.endsWith(".jpg")) {
    args.push("-vf", vf, "-frames:v", "1", "-q:v", "2", output);
  } else {
    args.push(
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      output,
    );
  }
  await run(ffmpegBin(), args);
}

/**
 * Browser-safe editor proxy: H.264 at most 1080 wide, aspect preserved.
 * The preview plays this; the render always uses the original. Same encode
 * recipe as conformSlide's video branch, one notch lighter on quality
 * because a proxy is scrubbed, not published.
 */
export async function conformProxy(input: string, output: string): Promise<void> {
  await run(ffmpegBin(), [
    "-y", "-i", input,
    // Never upscale; trunc keeps both dimensions even for libx264.
    "-vf", "scale=trunc(min(1080\\,iw)/2)*2:-2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}

/** One image strip of `frames` tiles, 160px wide each, for the timeline lane. */
export async function filmstrip(input: string, output: string, frames = 10): Promise<void> {
  const { durationSec } = await probe(input);
  const fps = frames / Math.max(durationSec, 0.1);
  await run(ffmpegBin(), [
    "-y", "-i", input,
    "-vf", `fps=${fps},scale=160:-2,tile=${frames}x1`,
    "-frames:v", "1",
    "-q:v", "4",
    output,
  ]);
}

/**
 * The frames the analyzer looks at: `count` stills spread evenly across the
 * runtime, skipping the first and last 2 percent so a black lead-in or a
 * trailing fade never burns one of twelve chances to see the video.
 *
 * One pass, not `count` seeks: fps = (count - 1) / span puts frame 1 at 2
 * percent and the last frame at 98 percent. ffmpeg can emit an extra frame at
 * the boundary, so the count is enforced on the way out rather than trusted.
 */
export async function sampleFrames(
  input: string,
  outDir: string,
  count: number,
  durationSec: number,
): Promise<string[]> {
  const n = Math.max(1, Math.floor(count));
  const duration = Math.max(durationSec, 0);
  const start = duration * 0.02;
  const span = Math.max(duration * 0.96, 0.1);
  await fs.mkdir(outDir, { recursive: true });
  await run(ffmpegBin(), [
    "-y",
    "-ss", start.toFixed(3),
    "-i", input,
    // A hair past the span so the closing frame lands rather than being cut.
    "-t", (span + 0.05).toFixed(3),
    "-vf", `fps=${n > 1 ? (n - 1) / span : 1 / span},scale=640:-2`,
    "-q:v", "4",
    join(outDir, "frame-%02d.jpg"),
  ]);
  const names = (await fs.readdir(outDir)).filter((f) => /^frame-\d+\.jpg$/.test(f)).sort();
  return names.slice(0, n).map((f) => join(outDir, f));
}

export async function extractThumbnail(
  input: string,
  output: string,
  atSec: number,
): Promise<void> {
  await run(ffmpegBin(), [
    "-y",
    "-ss", atSec.toFixed(2),
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale=640:-2",
    "-q:v", "3",
    output,
  ]);
}
