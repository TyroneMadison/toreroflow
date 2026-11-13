import { refreshWindowGlass } from "./windowGlass";

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "toreroflow-theme";

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  refreshWindowGlass();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable; theme still applied for this session
  }
}

/*
 * Automation mode: no motion and no blur.
 *
 * A bot driving the app through a browser screenshots it and clicks by
 * position. Entrance animations make it act on a half-arrived screen, and
 * backdrop blur is the most expensive thing to render in a headless browser
 * and makes text over glass harder to read back. So html[data-motion="reduced"]
 * stops the motion and html[data-glass="low"] swaps every glass layer for a
 * solid tinted fill (tokens.css).
 *
 * On when any of these say so: ?automation=1 in the URL (remembered, so a bot
 * only has to pass it once; ?automation=0 forgets it), the Settings toggle, or
 * the system's own reduce-motion setting.
 */
export const AUTOMATION_STORAGE_KEY = "toreroflow-automation";

/** What the URL asks for: true, false, or null when it says nothing. */
export function automationParam(search: string): boolean | null {
  const v = new URLSearchParams(search).get("automation");
  return v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : null;
}

/** The html attributes automation mode sets. Empty when it is off. */
export function automationAttributes(on: boolean): Record<string, string> {
  return on ? { "data-motion": "reduced", "data-glass": "low" } : {};
}

export function loadAutomation(): boolean {
  try {
    return localStorage.getItem(AUTOMATION_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function systemReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function applyAutomation(on: boolean): void {
  const html = document.documentElement;
  html.removeAttribute("data-motion");
  html.removeAttribute("data-glass");
  for (const [k, v] of Object.entries(automationAttributes(on || systemReducedMotion()))) {
    html.setAttribute(k, v);
  }
}

/** The Settings toggle. Stores the choice and applies it at once. */
export function setAutomation(on: boolean): void {
  try {
    localStorage.setItem(AUTOMATION_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // not remembered, still applied for this session
  }
  applyAutomation(on);
}

/** Called once before first paint. */
export function initAutomation(): void {
  const asked = automationParam(window.location.search);
  if (asked !== null) setAutomation(asked);
  else applyAutomation(loadAutomation());
}
