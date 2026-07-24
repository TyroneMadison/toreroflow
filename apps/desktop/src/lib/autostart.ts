/** True when running inside the Tauri shell (vs a plain browser tab). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** null = not available (browser dev mode). */
export async function getAutostart(): Promise<boolean | null> {
  if (!isTauri()) return null;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  const plugin = await import("@tauri-apps/plugin-autostart");
  if (on) await plugin.enable();
  else await plugin.disable();
}
