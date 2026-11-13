import { sheetMode } from "../components/GlassDateTime";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 *
 * The bug this exists to stop: rescheduling from a phone. Upright, the month
 * and the time columns drew on top of each other; sideways, the panel ran off
 * the bottom of a 390px window with Done out of reach.
 */

/* Desktop and laptop windows keep the panel under its trigger. */
eq(sheetMode(1440, 900), "none", "a desktop window keeps the anchored panel");
eq(sheetMode(1007, 700), "none", "a narrow laptop window keeps the anchored panel");

/* An upright phone gets the bottom sheet. */
eq(sheetMode(390, 844), "portrait", "an upright iPhone gets the bottom sheet");
eq(sheetMode(430, 932), "portrait", "an upright Pro Max gets the bottom sheet");

/* A phone turned sideways gets the full height panel, however wide it is. */
eq(sheetMode(844, 390), "landscape", "a sideways iPhone gets the side by side panel");
eq(sheetMode(932, 430), "landscape", "a sideways Pro Max gets the side by side panel");
eq(sheetMode(1000, 360), "landscape", "Safari in landscape with its bars showing still counts");

/* A tiny square window is upright, not sideways. */
eq(sheetMode(480, 480), "portrait", "a small square window gets the bottom sheet");

console.log("dateSheet: all checks passed");
