import { useRef, type PointerEvent as RPointerEvent } from "react";

/*
 * Phone gestures (mobile pass) where a desktop hover, right-click or drag used
 * to be: swipe a row left to act on it, long-press for a menu. Small and
 * pointer-based; vertical scrolling keeps working (touch-action: pan-y on the
 * row), and a mouse can still use the visible buttons.
 */

/** Swipe left past `threshold` px to call onLeft. Spread the handlers on the row. */
export function useSwipeLeft(onLeft: () => void, threshold = 96) {
  const start = useRef<{ x: number; y: number; dx: number; el: HTMLElement; live: boolean } | null>(null);
  const reset = (el: HTMLElement) => {
    el.style.transition = "transform .18s ease";
    el.style.transform = "";
  };
  return {
    onPointerDown(e: RPointerEvent<HTMLElement>) {
      if (e.pointerType === "mouse") return;
      start.current = { x: e.clientX, y: e.clientY, dx: 0, el: e.currentTarget, live: false };
    },
    onPointerMove(e: RPointerEvent<HTMLElement>) {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.live) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (start.current = null);
        if (dx < -12) s.live = true;
        else return;
      }
      s.dx = Math.min(0, dx);
      s.el.style.transition = "none";
      s.el.style.transform = `translateX(${s.dx}px)`;
    },
    onPointerUp() {
      const s = start.current;
      start.current = null;
      if (!s) return;
      if (s.dx < -threshold) {
        s.el.style.transition = "transform .18s ease, opacity .18s ease";
        s.el.style.transform = "translateX(-100%)";
        s.el.style.opacity = "0";
        window.setTimeout(onLeft, 160);
      } else reset(s.el);
    },
    onPointerCancel() {
      const s = start.current;
      start.current = null;
      if (s) reset(s.el);
    },
  };
}

/** Press and hold for `ms` to call onLong; moving or lifting first cancels. */
export function useLongPress(onLong: () => void, ms = 500) {
  const timer = useRef<number | null>(null);
  const at = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown(e: RPointerEvent<HTMLElement>) {
      fired.current = false;
      at.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLong();
      }, ms);
    },
    onPointerMove(e: RPointerEvent<HTMLElement>) {
      if (at.current && Math.hypot(e.clientX - at.current.x, e.clientY - at.current.y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(e: { preventDefault(): void }) {
      e.preventDefault();
    },
    /** True right after a long press fired, so the click that follows can be ignored. */
    fired,
  };
}
