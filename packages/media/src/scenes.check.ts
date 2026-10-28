import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSceneCuts, sceneCuts } from "./ffmpeg";

const log = [
  "[Parsed_showinfo_2 @ 0x1] n:   0 pts:  61440 pts_time:4.8     duration: 512",
  "[Parsed_showinfo_2 @ 0x1] n:   1 pts:  62000 pts_time:4.9 ",
  "[Parsed_showinfo_2 @ 0x1] n:   2 pts: 128000 pts_time:10.0004",
  "frame=  300 fps=0.0 q=-0.0 size=N/A time=00:00:12.00",
].join("\n");
assert.deepEqual(parseSceneCuts(log), [4.8, 10], "cuts parsed, a burst inside 0.5 s kept once");
assert.deepEqual(parseSceneCuts(""), [], "no cuts");

// Real ffmpeg: red for 2 s then blue for 2 s is one cut at 2 s.
const dir = mkdtempSync(join(tmpdir(), "tf-scenes-"));
try {
  const src = join(dir, "src.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:d=2:r=25",
    "-f", "lavfi", "-i", "color=blue:s=320x180:d=2:r=25",
    "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", src,
  ]);
  const cuts = await sceneCuts(src);
  assert.equal(cuts.length, 1, `one cut, got ${JSON.stringify(cuts)}`);
  assert.ok(Math.abs(cuts[0] - 2) < 0.05, `cut near 2 s, got ${cuts[0]}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("scenes.check: all checks passed");
