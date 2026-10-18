import assert from "node:assert/strict";
import { enforceMix, nearDuplicate, preferenceProfile, preferencePrompt, batchCaps } from "./ideaMix";

assert.ok(nearDuplicate("Three things nobody tells you before renting a car", "3 things nobody tells you before you rent a car"));
assert.ok(!nearDuplicate("Ranking every SUV on our lot", "What a rental pickup looks like in 20 seconds"));
const ideas = [
  { text: "Ranking every SUV on our lot", format: "Ranking", funnelStage: "bottom", label: "Verdict hook" },
  { text: "Ranking every SUV on the lot", format: "Ranking", funnelStage: "bottom", label: "Verdict hook" },
  { text: "Day one vs day ninety of detailing", format: "Before and after", funnelStage: "middle", label: "Contrast hook" },
];
assert.equal(enforceMix(ideas, 10).length, 2, "near duplicate dropped");
assert.equal(enforceMix(ideas, 10, ["ranking every suv on our lot!"]).length, 1, "saved duplicate dropped");
assert.equal(batchCaps(20).perFormat, 4);
const TOPICS = ["Parking lot pranks gone wrong", "Grandma reviews our convertible", "Valet tries every seat button", "Mechanic guesses engine sounds", "Kids design a dream minivan", "Road trip snack wars", "Dog rates the back seat", "Wedding getaway car surprise", "Rainy day wiper fails", "Midnight airport pickup panic"]; const many = TOPICS.map((text, n) => ({ text, format: "Skits", funnelStage: "top", label: `h${n}` }));
assert.equal(enforceMix(many, 10).length, batchCaps(10).perFormat, "format cap holds");
const ev = [
  ...Array.from({ length: 8 }, () => ({ format: "Ranking", funnelStage: "bottom", hookStyle: null, creator: null, saved: true })),
  ...Array.from({ length: 8 }, () => ({ format: "Skits", funnelStage: "top", hookStyle: null, creator: null, saved: false })),
];
const p = preferenceProfile(ev);
assert.ok(p.find((x) => x.value === "Ranking")!.weight > 1 && p.find((x) => x.value === "Skits")!.weight < 1);
assert.ok(p.every((x) => x.weight >= 0.75 && x.weight <= 1.35), "clamped");
assert.equal(preferenceProfile(ev.slice(0, 3)).length, 0 + 0, "all saved means nothing to learn yet is fine");
assert.ok(preferencePrompt(p).includes("Ranking"));
assert.equal(preferencePrompt([]), "");
console.log("ideaMix ok");
