// YouTube Shorts hard stop: 180.0 seconds is allowed, anything longer is not.
import assert from "node:assert/strict";
import { SHORT_FORM_MAX_SEC } from "./revisions";
import {
  YOUTUBE_SHORTS_LIMIT_REASON,
  exceedsYoutubeShortsLimit,
  formatMeasuredDuration,
  measuredDurationSec,
  youtubeShortsBlockMessage,
  youtubeShortsPublishBlock,
} from "./shortsLimit";

assert.equal(SHORT_FORM_MAX_SEC, 180);

assert.equal(exceedsYoutubeShortsLimit(180), false, "3:00 exactly is allowed");
assert.equal(exceedsYoutubeShortsLimit(180.0), false, "180.0 is the same instant");
assert.equal(exceedsYoutubeShortsLimit(179.999), false);
assert.equal(exceedsYoutubeShortsLimit(180.1), true, "a fraction past 180.0 is over");
assert.equal(exceedsYoutubeShortsLimit(181), true, "one second over is over");
assert.equal(exceedsYoutubeShortsLimit(240), true);
assert.equal(exceedsYoutubeShortsLimit(null), false, "unknown is not refused on a guess");
assert.equal(exceedsYoutubeShortsLimit(undefined), false);
assert.equal(exceedsYoutubeShortsLimit(Number.NaN), false);
assert.equal(exceedsYoutubeShortsLimit(0), false);
assert.equal(exceedsYoutubeShortsLimit(-5), false);

assert.equal(measuredDurationSec(181.2, 30), 181.2, "a probe of the file wins over stored metadata");
assert.equal(measuredDurationSec(null, 181), 181, "a missing file keeps the stored measurement");
assert.equal(measuredDurationSec(0, 90), 90, "a zero probe is not a duration");
assert.equal(measuredDurationSec(undefined, null), null);

assert.equal(formatMeasuredDuration(181), "181 seconds (3:01)");
assert.equal(formatMeasuredDuration(180.1), "180.1 seconds (3:00.1)");
assert.equal(formatMeasuredDuration(240), "240 seconds (4:00)");
assert.equal(formatMeasuredDuration(90.5), "90.5 seconds (1:30.5)");

const message = youtubeShortsBlockMessage(181);
assert.match(message, /3:00/);
assert.match(message, /181 seconds/);
assert.match(message, /3:01/);
assert.equal(message.includes("\u2014"), false, "no em dash in the UI sentence");

const over = { platform: "youtube", format: "short_form", kind: "video", durationSec: 181 };
assert.equal(youtubeShortsPublishBlock(over), YOUTUBE_SHORTS_LIMIT_REASON);
assert.equal(youtubeShortsPublishBlock({ ...over, durationSec: 180 }), null, "3:00 posts");
assert.equal(youtubeShortsPublishBlock({ ...over, durationSec: 180.1 }), YOUTUBE_SHORTS_LIMIT_REASON);
assert.equal(
  youtubeShortsPublishBlock({ ...over, format: null }),
  YOUTUBE_SHORTS_LIMIT_REASON,
  "unset format is the short-form scheduler",
);
assert.equal(
  youtubeShortsPublishBlock({ ...over, format: "long_form", durationSec: 900 }),
  null,
  "a long-form YouTube upload is not a Short",
);
assert.equal(youtubeShortsPublishBlock({ ...over, platform: "instagram" }), null);
assert.equal(youtubeShortsPublishBlock({ ...over, platform: "tiktok" }), null);
assert.equal(youtubeShortsPublishBlock({ ...over, platform: "facebook" }), null);
assert.equal(youtubeShortsPublishBlock({ ...over, kind: "carousel" }), null);
assert.equal(youtubeShortsPublishBlock({ ...over, durationSec: null }), null);

assert.equal(YOUTUBE_SHORTS_LIMIT_REASON, "Over 3:00, Shorts limit");

console.log("shortsLimit.check: all checks passed");
