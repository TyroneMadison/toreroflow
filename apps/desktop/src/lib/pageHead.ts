import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * A screen's own title, extra breadcrumb, subtitle and header controls for the
 * desktop PageHeader, which App renders above every screen. The Automations
 * list and editor use it (round 2 mockups 01 and 02: the account picker and
 * New automation; the automation's name, its LIVE pill, and More, Test it and
 * Publish). The newest caller wins; a caller only ever clears its own head, so
 * a parent passing null never wipes the head a child just set. Same idea as
 * lib/phoneBar.ts for the phone's app bar.
 */
export interface PageHead {
  title?: ReactNode;
  /** Appended after the section and page crumbs (the phone's eyebrow). */
  crumb?: string;
  sub?: ReactNode;
  controls?: ReactNode;
}

let current: PageHead | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function usePageHead(head: PageHead | null): void {
  const mine = useRef<PageHead | null>(null);
  useEffect(() => {
    if (head) {
      current = head;
      mine.current = head;
      emit();
    } else if (mine.current) {
      if (current === mine.current) {
        current = null;
        emit();
      }
      mine.current = null;
    }
  });
  useEffect(
    () => () => {
      if (mine.current && current === mine.current) {
        current = null;
        emit();
      }
    },
    [],
  );
}

export function usePageHeadState(): PageHead | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
