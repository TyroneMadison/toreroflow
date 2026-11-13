import { spawn } from "node:child_process";
import { peaksFromPcm } from "@toreroflow/core";

const ffmpegBin = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";

/**
 * Audio peaks for the timeline's waveform lane: 50 values per second, 0..100.
 * Decodes to 8 kHz mono s16 straight into memory (16 KB per second, so a
 * one-hour source is ~58 MB transient) and reduces with core's peaksFromPcm.
 * A file with no audio stream yields [] rather than an error.
 */
export function waveformPeaks(input: string, perSec = 50): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBin(),
      ["-nostdin", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        if (/does not contain any stream|matches no streams/i.test(err)) return resolve([]);
        return reject(new Error(`ffmpeg waveform exited ${code}: ${err.slice(-300)}`));
      }
      const buf = Buffer.concat(chunks);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      resolve(peaksFromPcm(pcm, 8000, perSec));
    });
  });
}
