import assert from "node:assert/strict";
import { planShoots } from "./shootPlan";
const car = { type: "prop", label: "Needs a car" }, kitchen = { type: "location", label: "Needs a kitchen" }, two = { type: "people", label: "Needs two people" };
const plan = planShoots([
  { id: "a", text: "A", difficulty: "hard", needs: [two] },
  { id: "b", text: "B", difficulty: "medium", needs: [two, car] },
  { id: "c", text: "C", difficulty: "easy", needs: [kitchen] },
  { id: "d", text: "D", difficulty: "medium", needs: [kitchen] },
  { id: "e", text: "E", difficulty: "easy" },
  { id: "f", text: "F", difficulty: "hard", completed: true },
  { id: "g", text: "G", difficulty: "hard", needs: [two] },
]);
assert.ok(plan.every((s) => s.effort <= 6), "budget holds");
assert.ok(!plan.some((s) => s.ideas.some((i) => i.id === "f")), "done ideas left out");
const withA = plan.find((s) => s.ideas.some((i) => i.id === "a"))!;
assert.ok(withA.ideas.some((i) => i.id === "b"), "shared people need grouped");
const withC = plan.find((s) => s.ideas.some((i) => i.id === "c"))!;
assert.ok(withC.ideas.some((i) => i.id === "d") && withC.where.includes("a kitchen"));
assert.equal(plan[0]!.day, "Monday");
assert.deepEqual(planShoots([{ id: "x", text: "x" }]), planShoots([{ id: "x", text: "x" }]), "deterministic");
assert.equal(planShoots(Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, text: "h", difficulty: "hard" })))[7]!.day, "Monday (week 2)");
console.log("shootPlan ok");
