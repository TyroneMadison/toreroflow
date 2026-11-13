import assert from "node:assert/strict";
import { hashtagCount, instagramCopyKbps, instagramLongformFit } from "./igLongform";

const MB = 1024 * 1024;

// A 9:16 12:48 file under 300 MB fits as is.
{
  const f = instagramLongformFit({ durationSec: 768, width: 1080, height: 1920, bytes: 284 * MB });
  assert.deepEqual(f.blocks, []);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.needsCopy, false);
  assert.equal(f.is916, true);
}

// A 2.4 GB 4K 16:9 master: copy needed, bars warned, nothing blocked.
{
  const f = instagramLongformFit({ durationSec: 842, width: 3840, height: 2160, bytes: 2.4 * 1024 * MB });
  assert.deepEqual(f.blocks, []);
  assert.equal(f.needsCopy, true);
  assert.match(f.warnings[0]!, /Instagram needs a smaller file\. This is 2\.4 GB/);
  assert.match(f.warnings[1]!, /bars/);
  // Asking for the crop removes the bars warning and still needs a copy.
  const c = instagramLongformFit({ durationSec: 842, width: 3840, height: 2160, bytes: 100 * MB, crop916: true });
  assert.equal(c.needsCopy, true);
  assert.equal(c.warnings.some((w) => /bars/.test(w)), false);
}

// Wider than 1920 but small: still needs a copy.
assert.equal(instagramLongformFit({ durationSec: 60, width: 2560, height: 1440, bytes: 50 * MB }).needsCopy, true);

// Over 15 minutes and under 3 seconds are refused.
assert.match(instagramLongformFit({ durationSec: 901, width: 1080, height: 1920, bytes: 1 }).blocks[0]!, /15 minutes and this video is 15:01/);
assert.equal(instagramLongformFit({ durationSec: 2, width: 1080, height: 1920, bytes: 1 }).blocks.length, 1);
// Exactly 15:00 is fine.
assert.deepEqual(instagramLongformFit({ durationSec: 900, width: 1080, height: 1920, bytes: 1 }).blocks, []);

// Unknown size never invents a copy.
assert.equal(instagramLongformFit({ durationSec: 60, width: 1080, height: 1920, bytes: null }).needsCopy, false);

// Bitrate: 15 minutes lands near 2.4 Mbit/s and the result fits the cap.
{
  const kbps = instagramCopyKbps(900);
  assert.ok(kbps > 2000 && kbps < 2600, String(kbps));
  const bytes = ((kbps + 128) * 1000 * 900) / 8;
  assert.ok(bytes < 300 * MB);
  assert.equal(instagramCopyKbps(10), 8000);
}

assert.equal(hashtagCount("Full M3 walkaround #cars #m3 and email a#b"), 2);

console.log("igLongform.check passed");
