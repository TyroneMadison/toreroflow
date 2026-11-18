import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useToast } from "../components/Toasts";

/*
 * Studio phone parts (mobile pass): long-press in place of hover buttons and
 * right-click, the menu it opens, and delete with Undo. Phone markup only.
 */

/** Handlers for one item: hold still for half a second to fire; the click that ends it is swallowed. */
export function useLongPress<T>(onLong: (item: T) => void, ms = 500) {
  const timer = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const stop = () => {
    window.clearTimeout(timer.current);
    origin.current = null;
  };
  useEffect(() => stop, []);
  return (item: T) => ({
    onPointerDown(e: PointerEvent) {
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        fired.current = true;
        origin.current = null;
        onLong(item);
      }, ms);
    },
    onPointerMove(e: PointerEvent) {
      const o = origin.current;
      if (o && Math.abs(e.clientX - o.x) + Math.abs(e.clientY - o.y) > 10) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    // Android and a mouse right-click open the native menu here; ours replaces it.
    onContextMenu(e: MouseEvent) {
      e.preventDefault();
      if (fired.current) return;
      stop();
      fired.current = true;
      onLong(item);
    },
    onClickCapture(e: MouseEvent) {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  });
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  run(): void;
}

/** The long-press menu: the item's name, its actions as full-width buttons, Cancel. */
export function PhoneMenu({ title, items, onClose }: { title: string; items: MenuItem[]; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="mb-scrim top" onClick={onClose} aria-hidden="true" />
      <div className="mb-sheet top mb-menu" role="menu" aria-label={title} data-testid="studio.menu">
        <div className="mb-grab" aria-hidden="true" />
        <div className="mb-sh">
          <div className="mb-ttl">
            <h2>{title}</h2>
          </div>
        </div>
        <div className="mb-shb">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`mb-btn block${it.danger ? " danger" : ""}`}
              onClick={() => {
                onClose();
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
          <button type="button" className="mb-btn block ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Delete with Undo: the row leaves at once and the server delete runs once
 * the toast is gone (success toasts last 3.5 s), unless Undo brings it back.
 */
export function useUndoDelete(remove: (id: string) => unknown) {
  const toast = useToast();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const del = (id: string, name: string) => {
    setHidden((h) => new Set(h).add(id));
    const t = window.setTimeout(() => void remove(id), 4000);
    toast.success(`Deleted ${name}.`, {
      label: "Undo",
      run: () => {
        window.clearTimeout(t);
        setHidden((h) => {
          const n = new Set(h);
          n.delete(id);
          return n;
        });
      },
    });
  };
  return { hidden, del };
}
