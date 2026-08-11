import { fromHeader } from "./reminder";

/** Local assert: the worker's tsconfig carries node types, but keep it plain. */
function eq(a: unknown, b: unknown, m: string) {
  if (a !== b) throw new Error(`${m}\n  expected: ${String(b)}\n  actual:   ${String(a)}`);
}

/*
 * The From header is the one env value an operator types by hand into a
 * shell. Angle brackets there cost a broken paste, so a bare address has to
 * work, and an already-dressed one has to survive untouched.
 */
eq(fromHeader("hello@torerone.com"), "Torerone <hello@torerone.com>", "a bare address gets a name");
eq(
  fromHeader("Torerone <hello@torerone.com>"),
  "Torerone <hello@torerone.com>",
  "an already-dressed address passes through",
);
eq(fromHeader("  hello@torerone.com  "), "Torerone <hello@torerone.com>", "stray spaces are trimmed");
eq(fromHeader(""), "", "unset stays unset so the caller's own error fires");

console.log("reminder.check: all checks passed");
