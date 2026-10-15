/* Runnable check: tsx src/posts/sopReminder.check.ts */
import assert from "node:assert/strict";
import { sopReminder } from "./sopReminder";

const withSop = { id: "c1", name: "Caleb", sop: "Hook in 2s." };
// Scheduling without the flag is allowed: it yields a reminder, not a refusal.
assert.deepEqual(sopReminder(withSop, undefined), { clientId: "c1", message: "Reminder: check Caleb's SOP" });
assert.deepEqual(sopReminder(withSop, false), { clientId: "c1", message: "Reminder: check Caleb's SOP" });
assert.equal(sopReminder(withSop, true), null, "acknowledged means no reminder");
assert.equal(sopReminder({ id: "c2", name: "Jacoby", sop: null }, undefined), null, "no SOP, no reminder");
assert.equal(sopReminder({ id: "c3", name: "Dud", sop: "   " }, undefined), null, "blank SOP, no reminder");
console.log("sopReminder: all checks passed");
