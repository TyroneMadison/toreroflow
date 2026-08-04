import { spawn } from "node:child_process";

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
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  return {
    durationSec: Number.parseFloat(data.format?.duration ?? "0") || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
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
