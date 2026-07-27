import { useEffect, useRef, useState } from "react";
import { FINANCE_COLORS } from "../../lib/financials";

/**
 * Per-row colour, chosen from a glass dropdown.
 *
 * The chosen colour is used for this row's donut segment and bar segment, so
 * a category reads the same everywhere on the screen.
 */
export default function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange(color: string): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="cwrap" ref={wrap}>
      <div className={`cbtn${open ? " open" : ""}`} title="Colour" onClick={() => setOpen((o) => !o)}>
        <i style={{ background: value, color: value }} />
      </div>
      {open && (
        <div className="cmenu">
          {FINANCE_COLORS.map((c) => (
            <span
              key={c}
              className={`sw${c === value ? " on" : ""}`}
              style={{ background: c }}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
