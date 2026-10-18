import { useSyncExternalStore } from "react";

/*
 * The one phone breakpoint. At or under this width the app swaps the floating
 * dock for the bottom tab bar (components/MobileNav.tsx) and styles/mobile.css
 * applies. phone.check.ts keeps the CSS media query and this number in step.
 */
export const PHONE_MAX = 768;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** True at phone widths; re-renders when the window crosses the breakpoint. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches);
}
