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

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Bold pop caption style (spec Section 9): heavy white text, thick black
 * outline, bottom-centered on the 9:16 canvas. More styles arrive later.
 */
export function buildAss(segments: TranscriptSegment[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: BoldPop,Arial,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = segments
    .filter((s) => s.text.trim())
    .map(
      (s) =>
        `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},BoldPop,,0,0,0,,${s.text
          .trim()
          .replace(/\n/g, "\\N")}`,
    )
    .join("\n");
  return header + lines + "\n";
}

/** Escape a path for use inside an ffmpeg filter argument on Windows. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Reframe to a 1080x1920 vertical canvas (cover + center crop) and burn the
 * ASS captions when provided.
 */
export async function renderVertical(
  input: string,
  output: string,
  assPath?: string,
): Promise<void> {
  const filters = ["scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920"];
  if (assPath) filters.push(`ass='${filterPath(assPath)}'`);
  await run(ffmpegBin(), [
    "-y",
    "-i", input,
    "-vf", filters.join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
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
