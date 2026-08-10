import { useEffect, useState } from "react";
import {
  KEY_ACTIONS,
  bindingFor,
  formatBinding,
  saveOverride,
  type KeyActionId,
  type KeyBinding,
} from "../lib/keymap";

/**
 * The remap dialog. Every action row shows its current key; Change arms a
 * capture and the next key pressed becomes the binding. Escape cancels a
 * capture rather than binding Escape, because a dialog you cannot back out
 * of is worse than one key you cannot bind.
 */
export default function KeymapModal({
  overrides,
  onChange,
  onClose,
}: {
  overrides: Partial<Record<KeyActionId, KeyBinding>>;
  onChange: (next: Partial<Record<KeyActionId, KeyBinding>>) => void;
  onClose: () => void;
}) {
  const [arming, setArming] = useState<KeyActionId | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!arming) {
        if (e.key === "Escape") onClose();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setArming(null);
        return;
      }
      // A bare modifier press is the operator reaching for a chord, not the
      // chord itself.
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const b: KeyBinding = {
        key: e.key.toLowerCase(),
        ...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
        ...(e.shiftKey ? { shift: true } : {}),
        ...(e.altKey ? { alt: true } : {}),
      };
      saveOverride(arming, b);
      onChange({ ...overrides, [arming]: b });
      setArming(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [arming, overrides, onChange, onClose]);

  const reset = (id: KeyActionId) => {
    saveOverride(id, null);
    const next = { ...overrides };
    delete next[id];
    onChange(next);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,.55)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card glass"
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          width: 480,
          maxHeight: "80vh",
          overflow: "auto",
          zIndex: 81,
          background: "var(--bg-1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Keyboard shortcuts</h3>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
            Done
          </button>
        </div>
        <div className="sub" style={{ marginBottom: 12 }}>
          Click Change, then press the key you want. Escape cancels.
        </div>
        {KEY_ACTIONS.map((a) => (
          <div
            key={a.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 0",
              borderTop: "1px solid var(--brd-soft)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 12.5 }}>{a.label}</b>
              {a.hint && (
                <div className="sub" style={{ fontSize: 10.5 }}>
                  {a.hint}
                </div>
              )}
            </div>
            <span
              className="filterchip"
              style={{
                marginLeft: "auto",
                flex: "0 0 auto",
                ...(arming === a.id ? { color: "var(--v)" } : {}),
              }}
            >
              {arming === a.id ? "Press a key…" : formatBinding(bindingFor(a.id, overrides))}
            </span>
            <button
              className="btn ghost"
              style={{ flex: "0 0 auto", padding: "4px 10px", fontSize: 11 }}
              onClick={() => setArming(arming === a.id ? null : a.id)}
            >
              {arming === a.id ? "Cancel" : "Change"}
            </button>
            {overrides[a.id] && (
              <button
                className="btn ghost"
                title="Back to the default"
                style={{ flex: "0 0 auto", padding: "4px 10px", fontSize: 11 }}
                onClick={() => reset(a.id)}
              >
                Reset
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
