import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown that looks like the rest of the app.
 *
 * A native `<select>` hands its list to the operating system, which paints it
 * with no radius, no blur and no animation, and ignores everything this
 * stylesheet says beyond the colour of the text. That list was the last piece
 * of Windows chrome left in the app, and no amount of CSS reaches it.
 *
 * Built to match the sidebar's brand switcher, which is the menu this app
 * already had: opaque rather than glass, because glass over glass cannot be
 * read, and closed by a mousedown anywhere outside it.
 *
 * The panel is portaled to the body rather than drawn next to its trigger.
 * Every card in this app is `.glass`, `backdrop-filter` creates a stacking
 * context, and a stacking context is a ceiling no z-index can climb out of:
 * an open list rendered in place is painted under whichever card comes next.
 * Cards that scroll their contents would clip it too. Being on the body costs
 * a measurement and keeps the list above everything, everywhere.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Shown in grey after the label, for a rate or a count. */
  hint?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown when the value matches no option, the way an empty option would. */
  placeholder?: string;
  disabled?: boolean;
  /**
   * Extra classes, applied to both the wrapper and the trigger.
   *
   * Both, because the wrapper is what a surrounding flex row sizes, while the
   * trigger is what carries the padding and the type. A class that does one or
   * the other lands where it is needed and does nothing where it is not.
   */
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  "aria-label"?: string;
}

const PANEL_MAX = 300;
const GAP = 6;

interface PanelBox {
  left: number;
  width: number;
  /** Set when the panel hangs below the trigger. */
  top?: number;
  /** Set instead when it has to open upwards. */
  bottom?: number;
  maxHeight: number;
}

/**
 * Where the panel goes, in viewport coordinates.
 *
 * Below the trigger unless there is genuinely more room above it, so a list in
 * the middle of a tall window opens downwards like every other menu, and one
 * near the bottom of the screen still shows its options instead of a scrollbar.
 */
function measure(trigger: HTMLElement): PanelBox {
  const r = trigger.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - GAP;
  const above = r.top - GAP;
  const flip = below < Math.min(PANEL_MAX, 160) && above > below;
  return {
    left: r.left,
    width: r.width,
    ...(flip ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    maxHeight: Math.max(120, Math.min(PANEL_MAX, flip ? above : below)),
  };
}

export default function Select({
  value,
  options,
  onChange,
  placeholder = "Select",
  disabled = false,
  className = "",
  style,
  title,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<PanelBox | null>(null);
  /** Which option the keyboard is on, which is not yet the chosen one. */
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const reposition = useCallback(() => {
    if (triggerRef.current) setBox(measure(triggerRef.current));
  }, []);

  // Same closer as the brand switcher: mousedown, so a click that starts
  // outside and ends inside cannot leave a menu open behind the pointer. The
  // panel is on the body, so it is not inside the wrapper and is asked too.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Escape is handled here as well as on the trigger. Focus can end up
    // somewhere else entirely, and an open list that will not close on the one
    // key everybody presses is a trap.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  // A panel positioned in viewport coordinates has to follow its trigger when
  // anything under it scrolls. Capture phase, because the scrolling element is
  // usually a card rather than the window.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  // Opening lands on the current value, not the top of the list, so a state
  // picker with fifty entries opens showing the state that is already set.
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    reposition();
  }, [open, selectedIndex, reposition]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [open, active]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const move = (delta: number) => {
    if (!options.length) return;
    setActive((i) => Math.min(options.length - 1, Math.max(0, i + delta)));
  };

  /** Typing a letter jumps, the way a native select does. */
  const jump = (key: string) => {
    const now = Date.now();
    const text = now - typed.current.at < 800 ? typed.current.text + key : key;
    typed.current = { text, at: now };
    const from = options.findIndex((o) => o.label.toLowerCase().startsWith(text.toLowerCase()));
    if (from >= 0) setActive(from);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) jump(e.key);
    }
  };

  return (
    <div className={`selwrap${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`field-in sel${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        style={style}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? "selval" : "selval ph"}>{selected?.label ?? placeholder}</span>
        {selected?.hint && <span className="selhint">{selected.hint}</span>}
        <svg className="selchev" viewBox="0 0 12 8" aria-hidden="true">
          <path d="M1 1.5 6 6.5l5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        box &&
        createPortal(
          <div
            id={listId}
            ref={listRef}
            className={`selpanel${box.bottom !== undefined ? " up" : ""}`}
            role="listbox"
            tabIndex={-1}
            style={{
              left: box.left,
              width: box.width,
              top: box.top,
              bottom: box.bottom,
              maxHeight: box.maxHeight,
            }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                className={`selopt${o.value === value ? " on" : ""}${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
              >
                <span className="l">{o.label}</span>
                {o.hint && <span className="h">{o.hint}</span>}
              </div>
            ))}
            {!options.length && <div className="selempty">Nothing to choose from</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
