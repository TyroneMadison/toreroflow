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

// Videos are published exactly as exported, so there is no reframe and no
// caption burn-in. ffmpeg is kept only for probing and thumbnails.

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
