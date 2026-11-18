import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/*
 * The phone app bar's "deeper page" mode (mobile pass, PATTERN A2): Back, a
 * centered title and at most one action, so it is always clear how to get out.
 * A screen that is a level down (a Settings section, Preflight, an analysis)
 * calls usePhoneBar while it is mounted; MobileNav shows the newest one.
 * `hide` is for full-screen tools (the Studio editor) that bring their own bar
 * and want the tab bar gone too. Nothing here renders above the phone width.
 */
export interface PhoneBar {
  title: string;
  back(): void;
  action?: ReactNode;
  hide?: boolean;
}

let stack: Array<{ id: number; bar: PhoneBar }> = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
let top: PhoneBar | null = null;
const snapshot = () => top;
function sync() {
  top = stack.length ? stack[stack.length - 1]!.bar : null;
  emit();
}

/** Puts the app bar in deeper-page mode while the calling screen is mounted. */
export function usePhoneBar(bar: PhoneBar | null): void {
  const id = useRef(0);
  if (!id.current) id.current = ++seq;
  // Every render: the title, back and action are whatever the screen says now.
  useLayoutEffect(() => {
    stack = stack.filter((e) => e.id !== id.current);
    if (bar) stack.push({ id: id.current, bar });
    sync();
  });
  useLayoutEffect(
    () => () => {
      stack = stack.filter((e) => e.id !== id.current);
      sync();
    },
    [],
  );
}

/** The bar a screen asked for, or null for the normal brand switcher. */
export function usePhoneBarState(): PhoneBar | null {
  return useSyncExternalStore(subscribe, snapshot);
}
