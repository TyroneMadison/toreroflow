import assert from "node:assert/strict";
import { isBrowserReady, type ProbeResult } from "./ffmpeg";

/**
 * The gate that decides whether a dropped clip needs converting.
 *
 * It is a speed optimisation with an asymmetric cost. Saying "convert this"
 * about a file that did not need it wastes the seconds that used to be spent
 * on every clip anyway. Saying "this is fine" about a file the webview cannot
 * decode gives the operator an editor whose preview is a black rectangle, and
 * nothing on screen explains why. So every case that is not provably safe has
 * to come back false, and that is what this pins.
 */

const ok: ProbeResult = {
  durationSec: 35,
  width: 1080,
  height: 1920,
  videoCodec: "h264",
  audioCodec: "aac",
  pixFmt: "yuv420p",
};

assert.equal(isBrowserReady(ok), true, "a 1080p H.264/AAC phone export needs no copy");
assert.equal(
  isBrowserReady({ ...ok, width: 720, height: 1280 }),
  true,
  "and neither does a smaller one",
);
assert.equal(
  isBrowserReady({ ...ok, audioCodec: "" }),
  true,
  "silent footage is fine; no audio stream is not a bad audio stream",
);

assert.equal(isBrowserReady({ ...ok, videoCodec: "hevc" }), false, "HEVC is not decodable here");
assert.equal(isBrowserReady({ ...ok, videoCodec: "prores" }), false, "nor is ProRes");
assert.equal(
  isBrowserReady({ ...ok, pixFmt: "yuv420p10le" }),
  false,
  "10-bit fails to decode even when the codec says h264",
);
assert.equal(
  isBrowserReady({ ...ok, pixFmt: "yuv422p" }),
  false,
  "and so does 4:2:2 chroma",
);
assert.equal(
  isBrowserReady({ ...ok, width: 3840, height: 2160 }),
  false,
  "4K is playable but scrubs badly, which is the other reason the proxy exists",
);
assert.equal(
  isBrowserReady({ ...ok, audioCodec: "pcm_s16le" }),
  false,
  "PCM audio in an MP4 will not play",
);
assert.equal(
  isBrowserReady({ ...ok, width: 0, height: 0, videoCodec: "" }),
  false,
  "a file with no video stream is never ready, whatever else it says",
);

console.log("browserReady.check: all checks passed");
