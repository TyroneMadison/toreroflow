/*
 * Node's types are deliberately not in this package's tsconfig, which is a
 * browser one. This check has to read files off disk, so the functions it
 * needs are declared here rather than pulling a whole type package into the
 * app's typecheck. The hand-rolled assert follows the other checks in this
 * folder for the same reason.
 */
declare const process: { cwd(): string };

// @ts-expect-error node's fs is not in this package's browser tsconfig on
// purpose. This file never reaches the bundle: it runs under tsx as a check.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
};

/**
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 *
 * This one reads the stylesheets rather than any code, because the thing being
 * defended is a property of the CSS: motion in this app must run on the
 * compositor.
 *
 * `transform` and `opacity` are composited, so a frame of them costs no layout
 * and no repaint. Everything else makes the browser redo real work on every
 * frame: `width` and `margin` force layout, `box-shadow` and `filter` force a
 * repaint of a blurred region, and this app puts a 38px backdrop-filter behind
 * almost every card. Animating the wrong property here is the difference
 * between motion nobody notices and a fan that spins up.
 *
 * The exceptions are listed by name below. Each one is a case where there is
 * no compositor-only way to do the job, and each is confined to a single
 * element animating on a deliberate action rather than continuously.
 */

// Run from the package root by its test script, so the paths are fixed.
const ROOT = process.cwd();
const MAIN = `${ROOT}/src/styles.css`;

/** Every .css file under a directory, editor components keep theirs beside them. */
function cssUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = readdirSync(dir, { recursive: true }).map(String);
  return entries
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => `${dir}/${f}`);
}

const FILES = [MAIN, ...cssUnder(`${ROOT}/src/editor`), ...cssUnder(`${ROOT}/src/screens`)];

/** Properties whose animation costs layout or a repaint on every frame. */
const EXPENSIVE = [
  "width",
  "height",
  "margin",
  "padding",
  "top",
  "left",
  "right",
  "bottom",
  "box-shadow",
  "filter",
  "backdrop-filter",
  "grid-template-rows",
  "grid-template-columns",
  "aspect-ratio",
  "background-position",
  "font-size",
];

/**
 * Where an expensive property is animated on purpose.
 *
 * Keyed by the selector it appears on, with the reason it earns the exception.
 * A new entry here should be a decision, not a reflex.
 */
const ALLOWED: Record<string, string> = {
  ".qbar .fill":
    "a progress bar's width. scaleX would stretch its gradient and its rounded ends, and it animates once when a figure changes, on one small element.",
  ".pmedia":
    "a brand card growing its image when expanded. Only on an explicit click, one card at a time.",
  ".pexpand":
    "grid-template-rows 0fr to 1fr, the only way to animate to a height nobody knows in advance without measuring in JavaScript first.",
  ".jobwrap":
    "an upload card collapsing out of the list after it is scheduled. One card, once, on an action the operator took.",
  ".jobwrap.departing>.job":
    "the same collapse, closing the gap the card leaves behind.",
  ".shimmer":
    "background-position on a loading placeholder, which only exists while something is loading.",
};

const KEYFRAME_ALLOWED = new Set([
  // A loading shimmer only runs while something is loading, and there is no
  // compositor-only way to slide a gradient across text.
  "sh",
  // Draws a line by shortening its dash offset. SVG geometry, one small path.
  "draw",
]);

/**
 * Keyframe bodies, found by matching braces rather than by regex.
 *
 * Most of these blocks are written on one line with nested `from{}`/`to{}`
 * inside them, which a non-greedy regex either cuts short or runs past.
 */
function keyframeBlocks(css: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1]!, body: css.slice(start, i - 1) });
  }
  return out;
}

for (const file of FILES) {
  const css = readFileSync(file, "utf8");
  // The message names the file, because "which stylesheet" is the first
  // question a failure raises now that components carry their own.
  const short = file.slice(ROOT.length + 1);

  /* ---- every transition in the stylesheet ---- */

  const transitions = [...css.matchAll(/([^{}]+)\{[^{}]*transition:([^;}]+)/g)].map((m) => ({
    selector: m[1]!.trim().split("\n").pop()!.trim(),
    value: m[2]!.trim(),
  }));

  if (file === MAIN) {
    assert.equal(transitions.length > 10, true, "the main stylesheet should have transitions to check");
  }

  for (const t of transitions) {
    for (const prop of EXPENSIVE) {
      // Word boundary: "transition:width" matters, "transition:transform" does
      // not just because it contains "for".
      const animatesIt = new RegExp(`(^|[,\\s])${prop}(\\s|$|,)`).test(t.value);
      if (!animatesIt) continue;
      const allowed = Object.keys(ALLOWED).some((sel) => t.selector.includes(sel));
      assert.equal(
        allowed,
        true,
        `${short}: ${t.selector} animates "${prop}", which costs layout or a repaint every frame.\n` +
          `        Use transform or opacity, or add the selector to ALLOWED in motion.check.ts with the reason.`,
      );
    }
  }

  /* ---- and every keyframe ---- */

  const keyframes = keyframeBlocks(css);
  if (file === MAIN) {
    assert.equal(keyframes.length > 5, true, "the main stylesheet should have keyframes to check");
  }

  for (const k of keyframes) {
    if (KEYFRAME_ALLOWED.has(k.name)) continue;
    for (const prop of EXPENSIVE) {
      const animatesIt = new RegExp(`[{;\\s]${prop}\\s*:`).test(k.body);
      assert.equal(
        animatesIt,
        false,
        `${short}: @keyframes ${k.name} animates "${prop}". Keyframes should move transform and opacity only.`,
      );
    }
  }
}

/* ---- the kill switch ---- */

// Anyone who has asked their system to reduce motion gets none of this, and it
// has to be turned off in one place rather than remembered per animation. The
// global rule lives in the main stylesheet and covers every component sheet.
const MAIN_CSS = readFileSync(MAIN, "utf8");
const reducedBlocks = MAIN_CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g) ?? [];
assert.equal(reducedBlocks.length >= 1, true, "reduced motion must be honoured");
assert.equal(
  /@media\s*\(prefers-reduced-motion:reduce\)\{\s*\*,\*::before,\*::after\{/.test(
    MAIN_CSS.replace(/\s*\n\s*/g, ""),
  ),
  true,
  "there must be one global reduced-motion rule, not only per-element ones",
);

/* ---- the stagger stays bounded ---- */

// A list of two hundred rows must never become two hundred animations with
// two hundred growing delays.
assert.equal(
  MAIN_CSS.includes(".stagger>*:nth-child(n+6)"),
  true,
  "the stagger must collapse to a single delay past a handful of rows",
);

console.log(`motion: all checks passed (${FILES.length} stylesheets)`);
