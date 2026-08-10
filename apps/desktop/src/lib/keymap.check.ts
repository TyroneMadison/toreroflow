import { KEY_ACTIONS, actionFor, bindingFor, formatBinding, matches } from "./keymap";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
};

/**
 * The keyboard map's two expensive mistakes: a key firing the wrong action
 * (B splitting when Ctrl+B was pressed), and a remap silently not taken.
 */

const ev = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  }) as KeyboardEvent;

/* Modifiers are exact: plain B is blade, Ctrl+B is split, never both. */
assert.equal(actionFor(ev("b"), {}), "blade", "plain B is the blade tool");
assert.equal(actionFor(ev("b", { ctrl: true }), {}), "splitAtPlayhead", "Ctrl+B splits");
assert.equal(actionFor(ev("z", { ctrl: true }), {}), "undo", "Ctrl+Z undoes");
assert.equal(
  actionFor(ev("z", { ctrl: true, shift: true }), {}),
  "redo",
  "Ctrl+Shift+Z redoes rather than falling through to undo",
);
assert.equal(actionFor(ev("y", { ctrl: true }), {}), "redo", "the Ctrl+Y alias holds");
assert.equal(actionFor(ev("q"), {}), null, "an unbound key does nothing");

/* An override replaces the default and frees the old key. */
const remapped = { blade: { key: "c" } } as const;
assert.equal(actionFor(ev("c"), remapped), "blade", "the remapped key fires the action");
assert.equal(actionFor(ev("b"), remapped), null, "and the old key is genuinely free");
assert.equal(bindingFor("blade", remapped).key, "c", "bindingFor reports the override");
assert.equal(bindingFor("select", remapped).key, "a", "and defaults for everything else");

/* Display names read like a settings screen, not like event.key. */
assert.equal(formatBinding({ key: " " }), "Space", "space has a name");
assert.equal(
  formatBinding({ key: "s", ctrl: true, shift: true }),
  "Ctrl+Shift+S",
  "modifier order is stable",
);

/* matches() is what the capture dialog trusts when recording a new key. */
assert.equal(matches(ev("m"), { key: "m" }), true, "bare key matches");
assert.equal(matches(ev("m", { ctrl: true }), { key: "m" }), false, "extra modifier does not");

assert.equal(KEY_ACTIONS.length >= 14, true, "the full action list is present");

console.log("keymap.check: all checks passed");
