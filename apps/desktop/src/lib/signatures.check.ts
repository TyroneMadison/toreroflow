// Field geometry and the Send rules. The geometry is the part that silently
// ruins a contract: a box that drifts a few percent puts a signature over a
// clause, and nobody notices until it is signed.
import {
  boxStyle,
  clampBox,
  daysLeft,
  dropBox,
  moveBox,
  progress,
  resizeBox,
  signedCount,
  sendBlockers,
  statusLine,
  waitingOn,
  MIN_SIDE,
  type FieldDraft,
  type RequestView,
  type SignerDraft,
} from "./signatures";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) {
      throw new Error(`${message ? `${message}\n  ` : ""}expected: ${String(expected)}, actual: ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message ? `${message}\n  ` : ""}expected: ${b}, actual: ${a}`);
  },
  ok(cond: unknown, message?: string) {
    if (!cond) throw new Error(message || "assertion failed");
  },
  match(actual: string, re: RegExp, message?: string) {
    if (!re.test(actual)) throw new Error(`${message ? `${message}\n  ` : ""}${re} does not match ${JSON.stringify(actual)}`);
  },
};

const page = { width: 800, height: 1035 };

/* ---- clamping ---- */
// Key order matters: this deepEqual compares JSON, as the other desktop checks do.
assert.deepEqual(clampBox({ page: 0, x: 0.5, y: 0.5, width: 0.2, height: 0.1 }), {
  page: 0,
  width: 0.2,
  height: 0.1,
  x: 0.5,
  y: 0.5,
}, "a box already inside the page is left alone");
let b = clampBox({ page: 0, x: 0.95, y: 0.99, width: 0.2, height: 0.1 });
assert.equal(b.x, 0.8, "pushed back so the right edge stays on the page");
assert.equal(b.y, 0.9, "and the bottom edge too");
assert.ok(b.x + b.width <= 1 && b.y + b.height <= 1);
b = clampBox({ page: 0, x: -0.4, y: -0.1, width: 0.2, height: 0.1 });
assert.deepEqual([b.x, b.y], [0, 0], "never off the left or top");
assert.equal(clampBox({ page: 0, x: 0.1, y: 0.1, width: 0.0001, height: 0 }).width, MIN_SIDE, "never invisible");
assert.equal(clampBox({ page: 0, x: 0, y: 0, width: 5, height: 5 }).width, 1, "never wider than the page");

/* ---- dropping ---- */
// A drop is centred on the cursor: the box lands where it looks like it landed.
b = dropBox("signature", 1, 400, 500, page);
assert.equal(b.page, 1);
assert.ok(Math.abs(b.x + b.width / 2 - 0.5) < 1e-9, "horizontally centred on the cursor");
assert.ok(Math.abs(b.y + b.height / 2 - 500 / 1035) < 1e-9, "vertically centred on the cursor");
// A drop in the corner is pulled back on, not clipped.
b = dropBox("signature", 0, 795, 1030, page);
assert.ok(b.x + b.width <= 1 + 1e-9 && b.y + b.height <= 1 + 1e-9, "a corner drop stays on the page");
assert.ok(b.width > 0.2, "and keeps its size rather than being squashed");

/* ---- moving and resizing round-trip through pixels ---- */
const start = dropBox("date", 0, 200, 300, page);
let moved = moveBox(start, 80, -40, page);
assert.ok(Math.abs((moved.x - start.x) * page.width - 80) < 1e-9, "a drag of 80px moves 80px");
assert.ok(Math.abs((moved.y - start.y) * page.height + 40) < 1e-9);
// Moving out and back lands where it started. Float arithmetic leaves a few
// parts in 10^16, which is nanometres on a page; a tolerance, not an equality.
const back = moveBox(moved, -80, 40, page);
assert.ok(Math.abs(back.x - start.x) < 1e-12 && Math.abs(back.y - start.y) < 1e-12, "no accumulated drift");
// Clamping does not quietly eat a later move.
moved = moveBox(moveBox(start, 10_000, 0, page), -400, 0, page);
assert.ok(Math.abs(moved.x - (1 - start.width - 400 / page.width)) < 1e-9);

let r = resizeBox(start, 100, 20, page);
assert.ok(Math.abs((r.width - start.width) * page.width - 100) < 1e-9, "grows by the drag");
assert.deepEqual([r.x, r.y], [start.x, start.y], "resizing from the corner does not move the box");
r = resizeBox(start, -9_999, -9_999, page);
assert.deepEqual([r.width, r.height], [MIN_SIDE, MIN_SIDE], "cannot be shrunk away");
r = resizeBox({ page: 0, x: 0.8, y: 0.9, width: 0.1, height: 0.05 }, 9_999, 9_999, page);
assert.ok(Math.abs(r.x + r.width - 1) < 1e-9, "cannot be grown off the page");
assert.ok(Math.abs(r.y + r.height - 1) < 1e-9);

// Percentages, so the overlay tracks the page at any window width with no
// measuring: that is the point of storing fractions in the first place.
assert.deepEqual(boxStyle({ page: 0, x: 0.25, y: 0.5, width: 0.5, height: 0.1 }), {
  left: "25.0000%",
  top: "50.0000%",
  width: "50.0000%",
  height: "10.0000%",
});
assert.equal(boxStyle({ page: 0, x: 1 / 3, y: 0, width: 0.1, height: 0.1 }).left, "33.3333%");

/* ---- the Send rules, mirroring the API ---- */
const field = (signerIndex: number, over: Partial<FieldDraft> = {}): FieldDraft => ({
  key: `k${signerIndex}${over.page ?? 0}`,
  signerIndex,
  type: "signature",
  page: 0,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.05,
  required: true,
  ...over,
});
const dana: SignerDraft = { email: "dana@example.com", name: "Dana", order: 1 };
const sam: SignerDraft = { email: "sam@example.com", name: "Sam", order: 2 };

assert.deepEqual(sendBlockers("Agreement", [dana], [field(0)], 2), [], "ready");
assert.deepEqual(sendBlockers("  ", [dana], [field(0)], 2), ["Give the document a title."]);
assert.deepEqual(sendBlockers("A", [], [], 2), ["Add at least one signer."]);
assert.deepEqual(sendBlockers("A", [dana], [], 2), ["Place at least one field on the document."]);
assert.match(sendBlockers("A", [{ ...dana, email: "dana@" }], [field(0)], 2)[0]!, /does not look right/);
assert.match(sendBlockers("A", [dana, { ...sam, email: "DANA@example.com" }], [field(0), field(1)], 2)[0]!, /listed twice/);
// The one that would otherwise strand a document forever.
let blockers = sendBlockers("A", [dana, sam], [field(0)], 2);
assert.equal(blockers.length, 1);
assert.match(blockers[0]!, /^Sam has nothing to fill\.$/);
blockers = sendBlockers("A", [dana], [field(0, { page: 5 })], 2);
assert.ok(blockers.some((x) => /past the end/.test(x)));
// A signer with no name is named by their email, not "undefined".
assert.match(sendBlockers("A", [dana, { ...sam, name: "" }], [field(0)], 2)[0]!, /sam@example\.com has nothing/);

/* ---- reading a sent request ---- */
const sig = (over: Partial<RequestView["signers"][number]>) => ({
  id: "s",
  email: "x@example.com",
  name: "",
  order: 1,
  status: "pending" as const,
  signedAt: null,
  declineReason: "",
  ...over,
});
const three = [sig({ status: "signed" }), sig({}), sig({})];
assert.equal(signedCount(three), 1);
assert.equal(progress(signedCount(three), three.length), "1 of 3 signed");
assert.equal(progress(0, 1), "0 of 1 signed");

// Turn order: only the lowest unfinished order is waiting, and a declined
// signer does not hold the queue open behind them.
const queue = [
  sig({ id: "a", name: "A", order: 1, status: "signed" }),
  sig({ id: "b", name: "B", order: 2 }),
  sig({ id: "c", name: "C", order: 2, status: "viewed" }),
  sig({ id: "d", name: "D", order: 3 }),
];
assert.deepEqual(waitingOn(queue).map((s) => s.id), ["b", "c"], "equal orders sign together");
assert.deepEqual(
  waitingOn([sig({ id: "a", order: 1, status: "declined" }), sig({ id: "b", order: 2 })]).map((s) => s.id),
  [],
  "a decline blocks the queue behind it, exactly as the API's isTurn does",
);
// That has to match the server or the UI would say it was someone's turn while
// the API refused their signature. It is moot in a live request: one decline
// closes the whole document, which statusLine is checked for below.
assert.deepEqual(waitingOn(queue.map((s) => ({ ...s, status: "signed" as const }))), [], "nobody left");

const now = Date.parse("2026-11-18T12:00:00Z");
const base: RequestView = {
  id: "r1",
  title: "Service Agreement",
  status: "sent",
  expiresAt: "2026-11-25T12:00:00Z",
  signedUrl: null,
  documentUrl: "/files/x",
  signers: queue,
};
assert.equal(daysLeft(base.expiresAt, now), 7);
assert.equal(daysLeft("2026-11-18T23:00:00Z", now), 0, "later today is zero days, not one");
assert.equal(daysLeft("2026-11-01T00:00:00Z", now), 0, "never negative");
assert.equal(statusLine(base, now), "Waiting on B, C · 7 days left");
assert.equal(statusLine({ ...base, expiresAt: "2026-11-19T06:00:00Z" }, now), "Waiting on B, C · expires today");
assert.equal(statusLine({ ...base, status: "draft" }, now), "Draft, not sent");
assert.equal(statusLine({ ...base, status: "completed" }, now), "Signed by everyone");
assert.equal(statusLine({ ...base, status: "voided" }, now), "Cancelled");
assert.equal(
  statusLine({ ...base, status: "declined", signers: [sig({ name: "Pat", status: "declined", declineReason: "Wrong entity" })] }, now),
  "Declined by Pat: Wrong entity",
);
assert.equal(
  statusLine({ ...base, status: "declined", signers: [sig({ name: "Pat", status: "declined" })] }, now),
  "Declined by Pat",
  "no trailing colon when no reason was given",
);
// A decline with people still queued behind it reads as declined, not as
// waiting on anyone: nobody is being asked to sign something already dead.
assert.equal(
  statusLine(
    { ...base, status: "declined", signers: [sig({ id: "a", order: 1, name: "A", status: "declined" }), sig({ id: "b", order: 2, name: "B" })] },
    now,
  ),
  "Declined by A",
);

console.log("signatures.check: ok");
