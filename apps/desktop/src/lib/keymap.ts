/**
 * The editor's keyboard map: one place that says what every key does, and the
 * one place the operator can say otherwise.
 *
 * Defaults follow CapCut desktop, because that is the editor whose muscle
 * memory the operator arrives with: A select, B blade, Ctrl+B split. Where
 * CapCut has no binding the convention comes from Resolve or Final Cut, which
 * agree on A/B anyway. Overrides live in localStorage as a partial map from
 * action id to binding, so a remap survives restarts and an unset action
 * falls back to its default rather than dying.
 */

export interface KeyBinding {
  /** KeyboardEvent.key, lowercased for letters: "a", "b", " ", "delete". */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeyAction {
  id: string;
  label: string;
  /** What the key actually does, in the words the remap dialog shows. */
  hint: string;
  def: KeyBinding;
}

/** Every remappable action, in the order the shortcuts dialog lists them. */
export const KEY_ACTIONS: readonly KeyAction[] = [
  { id: "select", label: "Selection tool", hint: "Back to the normal cursor", def: { key: "a" } },
  { id: "blade", label: "Blade tool", hint: "Click a clip to split it where you clicked", def: { key: "b" } },
  { id: "splitAtPlayhead", label: "Split at playhead", hint: "Splits the selected clip under the playhead", def: { key: "b", ctrl: true } },
  { id: "delete", label: "Delete selected", hint: "Removes the selected clip or overlay", def: { key: "delete" } },
  { id: "duplicate", label: "Duplicate selected", hint: "A copy right after the original", def: { key: "d", ctrl: true } },
  { id: "mute", label: "Mute selected", hint: "Silences the selected clip or audio", def: { key: "m" } },
  { id: "detachAudio", label: "Detach audio", hint: "Puts the clip's sound on the audio lane", def: { key: "s", ctrl: true, shift: true } },
  { id: "playPause", label: "Play / pause", hint: "", def: { key: " " } },
  { id: "prevFrame", label: "Back one frame", hint: "Shift steps five", def: { key: "arrowleft" } },
  { id: "nextFrame", label: "Forward one frame", hint: "Shift steps five", def: { key: "arrowright" } },
  { id: "jumpStart", label: "Jump to start", hint: "", def: { key: "home" } },
  { id: "jumpEnd", label: "Jump to end", hint: "", def: { key: "end" } },
  { id: "undo", label: "Undo", hint: "", def: { key: "z", ctrl: true } },
  { id: "redo", label: "Redo", hint: "Ctrl+Y works too", def: { key: "z", ctrl: true, shift: true } },
] as const;

export type KeyActionId = (typeof KEY_ACTIONS)[number]["id"];

const STORE_KEY = "toreroflow-keymap";

/** The stored overrides, tolerating a corrupt or missing entry. */
export function loadOverrides(): Partial<Record<KeyActionId, KeyBinding>> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, KeyBinding>;
    const out: Partial<Record<KeyActionId, KeyBinding>> = {};
    for (const a of KEY_ACTIONS) {
      const b = parsed[a.id];
      if (b && typeof b.key === "string" && b.key.length > 0) out[a.id] = b;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOverride(id: KeyActionId, binding: KeyBinding | null): void {
  const all = loadOverrides();
  if (binding) all[id] = binding;
  else delete all[id];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // Storage refusing to write costs persistence, not the session's remap.
  }
}

/** The live binding for an action: override when set, default otherwise. */
export function bindingFor(
  id: KeyActionId,
  overrides: Partial<Record<KeyActionId, KeyBinding>>,
): KeyBinding {
  return overrides[id] ?? KEY_ACTIONS.find((a) => a.id === id)!.def;
}

/** Does this event mean this binding? Modifiers must match exactly, so plain
 *  B and Ctrl+B stay two different actions. */
export function matches(e: KeyboardEvent, b: KeyBinding): boolean {
  return (
    e.key.toLowerCase() === b.key &&
    (e.ctrlKey || e.metaKey) === !!b.ctrl &&
    e.shiftKey === !!b.shift &&
    e.altKey === !!b.alt
  );
}

/** The action an event maps to, or null. First match wins in KEY_ACTIONS
 *  order, and more-modified bindings are checked first so Ctrl+Shift+Z is
 *  found before Ctrl+Z ever gets to claim it. */
export function actionFor(
  e: KeyboardEvent,
  overrides: Partial<Record<KeyActionId, KeyBinding>>,
): KeyActionId | null {
  const ranked = [...KEY_ACTIONS].sort((x, y) => {
    const mods = (b: KeyBinding) => (b.ctrl ? 1 : 0) + (b.shift ? 1 : 0) + (b.alt ? 1 : 0);
    return mods(bindingFor(y.id, overrides)) - mods(bindingFor(x.id, overrides));
  });
  for (const a of ranked) {
    if (matches(e, bindingFor(a.id, overrides))) return a.id;
  }
  // The one hardcoded alias: Ctrl+Y as redo, because half the world's hands
  // learned it there and it collides with nothing here.
  if (e.key.toLowerCase() === "y" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    return "redo";
  }
  return null;
}

/** "Ctrl+Shift+S", "Space", "Delete": the dialog's display form. */
export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  const names: Record<string, string> = {
    " ": "Space",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    arrowdown: "Down",
    delete: "Delete",
    backspace: "Backspace",
    home: "Home",
    end: "End",
    escape: "Esc",
  };
  parts.push(names[b.key] ?? b.key.toUpperCase());
  return parts.join("+");
}
