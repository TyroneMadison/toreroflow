import { useEffect, useSyncExternalStore } from "react";
import type { FailedPostListSchema } from "@toreroflow/contracts";
import { api } from "./api";

/*
 * The failed-post list, fetched once for everything that shows it: the
 * global banner, the phone's Calendar badge and More dot, the brand sheet.
 * Polled every couple of minutes while anything is watching, and refetched
 * at once when a screen retries or removes failures (FAILED_CHANGED).
 */
export type FailedList = ReturnType<typeof FailedPostListSchema.parse>;
export const FAILED_CHANGED = "toreroflow:failed-posts-changed";

let list: FailedList | null = null;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function poll() {
  void api
    .get<FailedList>("/failed-posts")
    .then((l) => {
      list = l;
      emit();
    })
    .catch(() => {});
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

/** The latest failed-post list (null until the first answer). */
export function useFailedPosts(): FailedList | null {
  useEffect(() => {
    if (watchers++ === 0) {
      poll();
      timer = setInterval(poll, 2 * 60 * 1000);
      window.addEventListener(FAILED_CHANGED, poll);
    }
    return () => {
      if (--watchers === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        window.removeEventListener(FAILED_CHANGED, poll);
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => list);
}
