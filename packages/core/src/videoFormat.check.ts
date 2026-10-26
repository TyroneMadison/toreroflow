import assert from "node:assert/strict";
import { defaultFormat, parseVideoFormat } from "./revisions";

// Vertical and square start short-form however long they run.
assert.equal(defaultFormat({ durationSec: 30, width: 1080, height: 1920 }), "short_form");
assert.equal(defaultFormat({ durationSec: 600, width: 1080, height: 1920 }), "short_form", "a 10 minute vertical is still short until flipped");
assert.equal(defaultFormat({ durationSec: 600, width: 1080, height: 1080 }), "short_form", "square counts as not landscape");
assert.equal(defaultFormat({ durationSec: 600, width: null, height: null }), "short_form", "unmeasured defaults short");
// Landscape keeps the duration rule it always had.
assert.equal(defaultFormat({ durationSec: 600, width: 1920, height: 1080 }), "long_form");
assert.equal(defaultFormat({ durationSec: 60, width: 1920, height: 1080 }), "short_form");

assert.equal(parseVideoFormat("short"), "short_form");
assert.equal(parseVideoFormat("long"), "long_form");
assert.equal(parseVideoFormat("short_form"), "short_form");
assert.equal(parseVideoFormat("long_form"), "long_form");
assert.equal(parseVideoFormat("carousel"), null);
assert.equal(parseVideoFormat(undefined), null);

console.log("videoFormat.check: all checks passed");
