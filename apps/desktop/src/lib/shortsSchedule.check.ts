/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    if (actual !== expected) throw new Error(`${message} expected ${String(expected)}, got ${String(actual)}`);
  },
  match(actual: string, re: RegExp, message = "") {
    if (!re.test(actual)) throw new Error(`${message} expected ${JSON.stringify(actual)} to match ${re}`);
  },
};

import { YOUTUBE_SHORTS_LIMIT_REASON } from "@toreroflow/core";
import { schedulePlatformBlock } from "./shortsSchedule";

const video = { kind: "video", format: "short_form" as string | null, durationSec: 181 };

const blocked = schedulePlatformBlock("youtube", video)!;
assert.match(blocked, /181 seconds \(3:01\)/, "the message shows the length");
assert.match(blocked, /stops at 3:00/, "the message names the cap");
assert.equal(blocked.includes("\u2014"), false, "no em dash");
assert.equal(schedulePlatformBlock("instagram", video), null, "Instagram is not the Shorts cap");
assert.equal(schedulePlatformBlock("tiktok", video), null, "TikTok is not the Shorts cap");
assert.equal(schedulePlatformBlock("youtube", { ...video, durationSec: 180 }), null, "3:00 can be selected");
assert.equal(schedulePlatformBlock("youtube", { ...video, durationSec: 180.0 }), null, "180.0 can be selected");
assert.match(
  schedulePlatformBlock("youtube", { ...video, durationSec: 180.1 })!,
  /180\.1 seconds/,
  "a fraction over 180.0 is blocked",
);
assert.equal(
  schedulePlatformBlock("youtube", { ...video, format: "long_form", durationSec: 900 }),
  null,
  "long-form is not blocked by the Shorts rule",
);
assert.equal(
  schedulePlatformBlock("youtube", { ...video, format: null }),
  schedulePlatformBlock("youtube", video),
  "unset format is the short-form scheduler",
);
assert.equal(schedulePlatformBlock("youtube", { ...video, durationSec: null }), null, "unknown length is not a guess");

const carousel = { kind: "carousel", format: null, durationSec: null };
assert.match(schedulePlatformBlock("youtube", carousel)!, /only takes videos/, "carousels still cannot pick YouTube");
assert.equal(schedulePlatformBlock("instagram", carousel), null, "Instagram still takes a carousel");

assert.equal(YOUTUBE_SHORTS_LIMIT_REASON, "Over 3:00, Shorts limit");

console.log("shortsSchedule.check: all checks passed");
