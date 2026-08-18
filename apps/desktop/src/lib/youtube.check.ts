// buildStudioTasks is the bridge between what the wizard records and what a
// human actually does: a choice that fails to become a task is silently lost,
// and a default that becomes a task buries the real work. Both directions are
// pinned here, along with the routing and ratio helpers.
import { buildStudioTasks, COMMENT_DEFAULTS, isHorizontal, ratioLabel } from "./youtube";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  ok(value: unknown, message: string) {
    if (!value) throw new Error(message);
  },
};

const allDefaults = {
  membersOnly: false,
  selfCert: null,
  comments: COMMENT_DEFAULTS,
  autoChapters: true,
  featuredPlaces: true,
  autoConcepts: true,
  fundraiserUrl: "",
  collaborator: "",
};

// Untouched defaults produce an empty list: the checklist only ever holds work.
assert.equal(buildStudioTasks(allDefaults).length, 0, "defaults are not tasks");

// Every deviation becomes exactly one task.
{
  const tasks = buildStudioTasks({
    ...allDefaults,
    membersOnly: true,
    selfCert: { rating: "limited", flags: ["firearms", "language"] },
    comments: { state: "paused", moderation: "strict", who: "subscribers", sort: "newest" },
    autoChapters: false,
    featuredPlaces: false,
    autoConcepts: false,
    fundraiserUrl: "https://gofund.me/x",
    collaborator: "@caleb",
  });
  assert.equal(tasks.length, 11, "every deviation surfaces, none twice");
  assert.ok(tasks.some((t) => t.includes("members-only")), "members-only");
  assert.ok(
    tasks.some((t) => t.includes("Firearms-related content") && t.includes("Inappropriate language")),
    "flagged categories are named in Studio's words, not our keys",
  );
  assert.ok(tasks.some((t) => t.includes("Pause comments")), "paused comments");
  assert.ok(tasks.some((t) => t.includes("Strict")), "moderation");
  assert.ok(tasks.some((t) => t.includes("subscribers")), "who can comment");
  assert.ok(tasks.some((t) => t.includes("newest")), "sort order");
  assert.ok(tasks.some((t) => t.includes("gofund.me/x")), "the fundraiser carries its link");
  assert.ok(tasks.some((t) => t.includes("@caleb")), "the collaborator is named");
}

// Comments off swallows the sub-settings: moderation on a closed section is
// not work anyone can do, and listing it would send someone hunting for it.
{
  const tasks = buildStudioTasks({
    ...allDefaults,
    comments: { state: "off", moderation: "holdAll", who: "subscribers", sort: "newest" },
  });
  assert.equal(tasks.length, 1, "off is one task, not four");
  assert.ok(tasks[0]!.includes("off"), "and it is the off task");
}

// A clean rating still prints, because a monetized channel must submit it.
{
  const tasks = buildStudioTasks({ ...allDefaults, selfCert: { rating: "safe", flags: [] } });
  assert.equal(tasks.length, 1, "safe is still a Studio submission");
  assert.ok(tasks[0]!.includes("none of the categories"), "and says none apply");
}

// The video-elements choices, none of which have an API, all reach the list.
{
  const tasks = buildStudioTasks({
    ...allDefaults,
    endScreen: { kind: "video", title: "Morning Ride + a V6 Camaro review" },
    relatedVideoTitle: "Sell me this Pen pt. 4",
    productTag: "Detailing kit",
  });
  assert.equal(tasks.length, 3, "three element choices, three tasks");
  assert.ok(tasks.some((t) => t.includes("Morning Ride")), "the end screen names its video");
  assert.ok(tasks.some((t) => t.includes("Sell me this Pen")), "the related pin names its video");
  assert.ok(tasks.some((t) => t.includes("Detailing kit")), "the product tag carries through");
}
{
  const tasks = buildStudioTasks({ ...allDefaults, endScreen: { kind: "recent" } });
  assert.equal(tasks.length, 1, "recent-upload end screen is one task");
  assert.ok(tasks[0]!.includes("most recent upload"), "and says which kind");
}
assert.equal(
  buildStudioTasks({ ...allDefaults, endScreen: { kind: "none" } }).length,
  0,
  "an end screen left at none is not work",
);

// Routing: shape decides, duration is only the fallback.
assert.equal(isHorizontal({ width: 1920, height: 1080, format: "short_form", kind: "video" }), true, "16:9 is long-form whatever the length");
assert.equal(isHorizontal({ width: 1080, height: 1920, format: "long_form", kind: "video" }), false, "a long vertical stays with the reel scheduler");
assert.equal(isHorizontal({ width: null, height: null, format: "long_form", kind: "video" }), true, "unmeasured falls back to duration");
assert.equal(isHorizontal({ width: 1920, height: 1080, format: "long_form", kind: "carousel" }), false, "a carousel is never a video upload");
assert.equal(isHorizontal({ width: 1080, height: 1080, format: null, kind: "video" }), false, "square is not horizontal");

// Ratio names, at the sizes clients actually export.
assert.equal(ratioLabel(1920, 1080), "16:9", "full HD");
assert.equal(ratioLabel(3840, 2160), "16:9", "4K");
assert.equal(ratioLabel(1440, 1080), "4:3", "4:3");
assert.equal(ratioLabel(2560, 1080), "2.35:1", "ultrawide lands in the scope band");
assert.equal(ratioLabel(1998, 1080), "1.85:1", "flat");
assert.equal(ratioLabel(2538, 1080), "2.35:1", "scope");
assert.equal(ratioLabel(1234, 567), "1234x567", "the unnamed fall back to pixels");

console.log("youtube.check: all checks passed");
