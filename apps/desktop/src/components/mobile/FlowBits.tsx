import { useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "../Toasts";

/*
 * Phone parts for the Carousels and Workflows pages (mobile pass): the sticky
 * chip row that jumps between the areas of one long page, a minus and plus
 * stepper, and delete with Undo. Phone markup only.
 */

export interface JumpItem {
  id: string;
  label: ReactNode;
}

/**
 * A sticky row of chips: a tap scrolls to the element with that id, and the
 * chip of the area on screen stays lit while the page scrolls.
 */
export function JumpChips({ items, label }: { items: JumpItem[]; label: string }) {
  const row = useRef<HTMLElement>(null);
  const [on, setOn] = useState(items[0]?.id);
  // A jump's own smooth scroll should not light the chips it passes on the way.
  const lockUntil = useRef(0);
  const ids = items.map((i) => i.id).join(" ");

  useEffect(() => {
    const main = row.current?.closest<HTMLElement>(".main");
    if (!main) return;
    const list = ids.split(" ");
    const spy = () => {
      if (!row.current || Date.now() < lockUntil.current) return;
      const edge = row.current.getBoundingClientRect().bottom + 24;
      let cur = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= edge) cur = id;
      }
      // The last area may be too short to ever reach the top.
      if (main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2) cur = list[list.length - 1];
      setOn(cur);
    };
    main.addEventListener("scroll", spy, { passive: true });
    return () => main.removeEventListener("scroll", spy);
  }, [ids]);

  // Keep the lit chip in view when the row is wider than the phone.
  useEffect(() => {
    const r = row.current;
    const c = r?.querySelector<HTMLElement>(".on");
    if (r && c && (c.offsetLeft < r.scrollLeft || c.offsetLeft + c.offsetWidth > r.scrollLeft + r.clientWidth))
      r.scrollTo({ left: c.offsetLeft - 16, behavior: "smooth" });
  }, [on]);

  const jump = (id: string) => {
    const main = row.current?.closest<HTMLElement>(".main");
    const el = document.getElementById(id);
    if (!main || !el || !row.current) return;
    const top = main.scrollTop + el.getBoundingClientRect().top - row.current.getBoundingClientRect().bottom - 8;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lockUntil.current = Date.now() + 700;
    main.scrollTo({ top, behavior: still ? "auto" : "smooth" });
    setOn(id);
  };

  return (
    <nav ref={row} className="mb-chips fl-jump" aria-label={label}>
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          className={`mb-chip${on === i.id ? " on" : ""}`}
          aria-current={on === i.id ? "true" : undefined}
          onClick={() => jump(i.id)}
        >
          {i.label}
        </button>
      ))}
    </nav>
  );
}

/** Minus, the number and plus. `children` replaces the number, for one that can also be typed. */
export function Stepper({
  value,
  min,
  max,
  label,
  onChange,
  children,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange(n: number): void;
  children?: ReactNode;
}) {
  return (
    <div className="fl-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        &minus;
      </button>
      {children ?? (
        <output className="fl-num" aria-live="polite">
          {value}
        </output>
      )}
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

/**
 * Delete with Undo: the row goes at once and the delete runs once the toast
 * is gone, unless Undo brings it back. `remove` throws on failure (after its
 * own toast), which brings the row back too.
 */
export function useSoftDelete(remove: (id: string) => Promise<void>) {
  const toast = useToast();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const back = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.delete(id);
      return n;
    });
  const del = (id: string, name: string) => {
    setHidden((h) => new Set(h).add(id));
    const t = window.setTimeout(() => void remove(id).catch(() => back(id)), 4000);
    toast.success(`Deleted ${name}.`, {
      label: "Undo",
      run: () => {
        window.clearTimeout(t);
        back(id);
      },
    });
  };
  return { hidden, del };
}

/** The red tile a swiped row slides off to show. */
export function SwipeDel() {
  return (
    <span className="fl-swdel" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <use href="#i-trash" />
      </svg>
      Delete
    </span>
  );
}
