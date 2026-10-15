/*
 * The desktop window as glass.
 *
 * In the Tauri app the window is transparent (tauri.conf.json), so the panels
 * sit over the live Windows desktop. The translucency slider decides what the
 * window adds behind them: Acrylic blur toward the frosted end, nothing at all
 * toward the clear end, so the real desktop shows straight through. In a
 * browser this does nothing; liquid.css gives the web a neutral dark base.
 */
import { isTauri } from "./autostart";

let last: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function windowEffectFor(level: number): "acrylic" | "clear" {
  return level < 0.5 ? "acrylic" : "clear";
}

/** Re-applies after the theme flips, so the acrylic tint follows it. */
export function refreshWindowGlass(): void {
  last = null;
  const v = Number(document.documentElement.getAttribute("data-glass-level") ?? "0.5");
  applyWindowGlass(v, document.documentElement.getAttribute("data-glass") === "low");
}

export function markShell(): void {
  if (isTauri()) document.documentElement.setAttribute("data-shell", "desktop");
}

export function applyWindowGlass(level: number, plain = false): void {
  if (!isTauri()) return;
  // Automation mode and reduced transparency get a calm frosted window.
  const want = plain ? "acrylic" : windowEffectFor(level);
  // Acrylic tinted to match the mode: near-black in dark, iPhone white in light.
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const key = `${want}:${light ? "light" : "dark"}`;
  if (key === last) return;
  if (timer) clearTimeout(timer);
  // Debounced: dragging the slider should not hammer the compositor.
  timer = setTimeout(() => {
    last = key;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow, Effect }) => {
        const w = getCurrentWindow();
        if (want === "acrylic") await w.setEffects({ effects: [Effect.Acrylic], color: light ? [242, 242, 247, 110] : [5, 5, 5, 120] });
        else await w.clearEffects();
      })
      .catch(() => {
        last = null; // older Windows without the effect: the panels' own smoke still reads fine
      });
  }, 120);
}
