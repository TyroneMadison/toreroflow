/*
 * The whole point is that a drag issues far fewer seeks than it does events,
 * and still lands on the frame the pointer stopped at. Getting the second half
 * wrong is the subtle failure: coalescing that drops the LAST request leaves
 * the video showing a frame from the middle of the drag while the slider sits
 * at the end, which looks exactly like the stutter it replaced.
 */
import { createSeekQueue, type Seekable } from "./seekQueue";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
};

/** A video element that seeks only when told the seek finished. */
function fakeVideo() {
  const seeks: number[] = [];
  const el = {
    seeking: false,
    _t: 0,
    get currentTime() {
      return this._t;
    },
    set currentTime(v: number) {
      this._t = v;
      this.seeking = true;
      seeks.push(v);
    },
  };
  return { el: el as unknown as Seekable & { seeking: boolean; _t: number }, seeks };
}

// A drag: many requests, one seek in flight, and the newest wins.
{
  const { el, seeks } = fakeVideo();
  const q = createSeekQueue(() => el);
  for (const t of [1.0, 1.1, 1.2, 1.3, 1.4]) q.request(t);
  assert.equal(seeks.length, 1, "only the first request reaches the element");
  assert.equal(seeks[0], 1.0, "and it is the one that started the drag");
  assert.equal(q.pending(), 1.4, "the newest is held, the ones between are dropped");

  // The seek lands; the queue goes straight to where the pointer actually is.
  el.seeking = false;
  q.settled();
  assert.equal(seeks.length, 2, "one more seek, not four");
  assert.equal(seeks[1], 1.4, "to the newest position, never an intermediate one");
  assert.equal(q.pending(), null, "and nothing is left waiting");
}

// A settled seek with nothing waiting must not re-seek.
{
  const { el, seeks } = fakeVideo();
  const q = createSeekQueue(() => el);
  q.request(2.0);
  el.seeking = false;
  q.settled();
  assert.equal(seeks.length, 1, "no phantom seek when the pointer stopped");
  assert.equal(q.pending(), null, "nothing pending");
}

// Slow, deliberate steps each get their own seek, because none overlaps.
{
  const { el, seeks } = fakeVideo();
  const q = createSeekQueue(() => el);
  for (const t of [3.0, 3.1, 3.2]) {
    q.request(t);
    el.seeking = false;
    q.settled();
  }
  assert.equal(seeks.length, 3, "frame stepping is not coalesced away");
  assert.equal(seeks[2], 3.2, "and lands where asked");
}

// The modal can close mid-seek. Neither call may throw on a missing element.
{
  const q = createSeekQueue(() => null);
  q.request(1.0);
  q.settled();
  assert.equal(q.pending(), null, "a vanished element is survivable");
}
{
  const { el } = fakeVideo();
  let live: Seekable | null = el;
  const q = createSeekQueue(() => live);
  q.request(1.0);
  q.request(2.0);
  assert.equal(q.pending(), 2.0, "held while seeking");
  live = null;
  q.settled();
  assert.equal(q.pending(), null, "and cleared rather than replayed into nothing");
}

console.log("seekQueue.check: all checks passed");
