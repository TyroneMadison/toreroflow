/*
 * Glass translucency: the Settings slider from Frosted (0) to Clear (1).
 *
 * One number drives the whole look. It lands on <html> as the --glass-level
 * custom property (every glass token in styles/liquid.css is a calc() of it)
 * and as data-glass-level for agents. The SVG refraction filter's strength
 * follows it too: heavy ripple at the clear end, none at the frosted end.
 * Persisted in localStorage; applied before first paint by main.tsx.
 */
import { setRefraction } from "./refraction";
import { applyWindowGlass } from "./windowGlass";

export const GLASS_STORAGE_KEY = "toreroflow-glass-level";
export const GLASS_DEFAULT = 0.25;

export function clampGlass(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return GLASS_DEFAULT;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

export function loadGlassLevel(): number {
  try {
    const s = localStorage.getItem(GLASS_STORAGE_KEY);
    return s == null ? GLASS_DEFAULT : clampGlass(s);
  } catch {
    return GLASS_DEFAULT;
  }
}

/** Refraction strength in px of displacement. Eases in, so the middle of the
 *  slider is mostly frosted and the clear end warps like looking through liquid. */
export function refractionScale(level: number): number {
  // v0.3.27: never see-through. 70px of smooth warp at 0% up to 180px (liquid, unreadable) at the clear end.
  void level;
  return 0; // v0.3.29: glass removed, solid background only
}

/** backdrop-filter url() is Chromium-only (WebView2 and Chrome). Elsewhere the
 *  CSS gloss and blur still give the look, just without the bend. */
function supportsRefraction(): boolean {
  const ua = navigator.userAgent;
  return /Chrome\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
}

const listeners = new Set<(v: number) => void>();
export function onGlassLevel(fn: (v: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyGlassLevel(level: number): void {
  const v = clampGlass(level);
  const html = document.documentElement;
  html.style.setProperty("--glass-level", String(v));
  html.setAttribute("data-glass-level", String(v));
  const scale = refractionScale(v);
  html.style.setProperty("--g-refract", scale > 0 && supportsRefraction() ? "url(#tf-refract)" : "none");
  document.getElementById("tf-refract-map")?.setAttribute("scale", String(scale));
  setRefraction(scale);
  applyWindowGlass(v, html.getAttribute("data-glass") === "low");
  listeners.forEach((fn) => fn(v));
}

/** The Settings slider. Stores the choice and applies it to the whole app at once. */
export function setGlassLevel(level: number): void {
  const v = clampGlass(level);
  try {
    localStorage.setItem(GLASS_STORAGE_KEY, String(v));
  } catch {
    // still applied for this session
  }
  applyGlassLevel(v);
}
