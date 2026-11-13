import { useSyncExternalStore } from "react";

/**
 * Phase 8: the open project's comment markers, shared between the
 * Comments panel (which loads and changes them) and the Timeline (which
 * draws them on the ruler). One project is open at a time.
 */
export interface CommentMarker {
  id: string;
  at: number;
  count: number;
  resolved: boolean;
}

let markers: CommentMarker[] = [];
const listeners = new Set<() => void>();

export function setCommentMarkers(next: CommentMarker[]): void {
  markers = next;
  listeners.forEach((l) => l());
}

export function useCommentMarkers(): CommentMarker[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => markers,
  );
}
