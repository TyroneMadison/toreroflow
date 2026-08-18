/**
 * One video seek in flight at a time, always heading for the newest position.
 *
 * Dragging a range input fires change events as fast as the pointer moves, and
 * the cover scrubber assigned `currentTime` on every one of them. A seek is
 * not free: the decoder jumps to the nearest keyframe and decodes forward, so
 * a new assignment landing mid-seek makes the browser abandon work it had
 * already done. Thirty of those a second is the stutter, and it gets worse the
 * further the frame sits from a keyframe, which is why it felt worst in the
 * middle of a drag rather than at the ends.
 *
 * So requests are coalesced instead of queued. Only the newest pending
 * position is kept, because the ones behind it are frames nobody will ever
 * look at: the pointer has already moved past them. The scrubber ends up
 * showing fewer intermediate frames and every one it shows is real, which
 * reads as smooth where the old version read as jumpy.
 */

/** The slice of HTMLVideoElement this needs, so a check can supply a fake. */
export interface Seekable {
  /** True while a seek is in progress. The browser's own state, not a flag. */
  readonly seeking: boolean;
  currentTime: number;
}

export interface SeekQueue {
  /** Ask for a position. Seeks now, or remembers it for when the current one lands. */
  request(seconds: number): void;
  /** Call from the element's `seeked` event. */
  settled(): void;
  /** The position waiting to be seeked to, or null. Exposed for checks. */
  pending(): number | null;
}

export function createSeekQueue(element: () => Seekable | null): SeekQueue {
  let waiting: number | null = null;

  return {
    request(seconds) {
      const el = element();
      if (!el) return;
      /*
       * `el.seeking` rather than a flag of our own. A boolean we maintain gets
       * stuck true the moment a seek fails or the element is replaced, and a
       * stuck flag freezes the scrubber permanently, which is worse than the
       * stutter it was meant to fix. The element already knows the answer.
       */
      if (el.seeking) {
        waiting = seconds;
        return;
      }
      el.currentTime = seconds;
    },
    settled() {
      const next = waiting;
      waiting = null;
      if (next === null) return;
      const el = element();
      // Skipped when the element has gone, e.g. the modal closed mid-seek.
      if (el) el.currentTime = next;
    },
    pending() {
      return waiting;
    },
  };
}
