// Real ffmpeg: a 4K 16:9 source becomes a 1080x1920 crop or a 1920x1080 fit,
// and the temp file never survives as the output name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { instagramCopy, probe } from "./ffmpeg";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "igcopy-"));
const src = path.join(dir, "src.mp4");
const made = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
  "-y", "-f", "lavfi", "-i", "testsrc=size=3840x2160:rate=30:duration=2",
  "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", src,
]);
assert.equal(made.status, 0, String(made.stderr));

const crop = path.join(dir, "ig-crop916.mp4");
await instagramCopy(src, crop, { crop916: true, videoKbps: 2000 });
const c = await probe(crop);
assert.deepEqual([c.width, c.height, c.videoCodec, c.audioCodec], [1080, 1920, "h264", "aac"]);

const fit = path.join(dir, "ig-fit.mp4");
await instagramCopy(src, fit, { crop916: false, videoKbps: 2000 });
const f = await probe(fit);
assert.deepEqual([f.width, f.height], [1920, 1080]);

assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes(".part")), []);
await fs.rm(dir, { recursive: true, force: true });
console.log("instagramCopy.check passed");
