import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION,
  GESTURE_THRESHOLD,
  MAX_ZOOM,
  ReviewQueue,
  ZOOM_PAN_THRESHOLD,
  anchorZoom,
  classifyGesture,
  clampScale,
  exitVector,
  formatBytes,
  gestureVisual,
  monthLabel,
  progressOf,
} from "../src/logic.js";

test("monthLabel renders English month names", () => {
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("2026-01"), "January 2026");
  assert.equal(monthLabel("2026-12"), "December 2026");
  assert.equal(monthLabel("2026-09", { short: true }), "Sep 2026");
});

test("monthLabel passes through malformed input", () => {
  assert.equal(monthLabel("nope"), "nope");
  assert.equal(monthLabel("2026-13"), "2026-13");
  assert.equal(monthLabel(null), "");
});

test("classifyGesture maps left to delete, right to keep, up to skip", () => {
  assert.equal(classifyGesture(-120, 0), ACTION.DELETE);
  assert.equal(classifyGesture(120, 0), ACTION.KEEP);
  assert.equal(classifyGesture(0, -120), ACTION.SKIP);
});

test("classifyGesture stays silent below the threshold", () => {
  assert.equal(classifyGesture(0, 0), null);
  assert.equal(classifyGesture(10, 10), null);
  assert.equal(classifyGesture(GESTURE_THRESHOLD - 1, 0), null);
});

test("classifyGesture never treats a downward drag as a decision", () => {
  assert.equal(classifyGesture(0, 200), null);
  assert.equal(classifyGesture(5, 200), null);
});

test("classifyGesture locks onto the dominant axis", () => {
  // Mostly horizontal, small upward wobble: still a keep.
  assert.equal(classifyGesture(120, -40), ACTION.KEEP);
  // Mostly vertical, small sideways wobble: still a skip.
  assert.equal(classifyGesture(40, -120), ACTION.SKIP);
  // A diagonal beyond the lock ratio falls back to the larger axis.
  assert.equal(classifyGesture(-120, -100), ACTION.DELETE);
});

test("classifyGesture honours a custom threshold", () => {
  assert.equal(classifyGesture(60, 0, 40), ACTION.KEEP);
  assert.equal(classifyGesture(30, 0, 40), null);
});

test("gestureVisual reports progress and axis", () => {
  const v = gestureVisual(-45, 0);
  assert.equal(v.action, null);
  assert.equal(v.progress, 0.5);
  assert.equal(v.vertical, 0);
  assert.equal(gestureVisual(0, -45).vertical, 1);
  assert.equal(gestureVisual(-200, 0).progress, 1);
});

test("formatBytes scales and rounds sensibly", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(20 * 1024), "20 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
});

test("exitVector sends the card the right way", () => {
  assert.deepEqual(exitVector(ACTION.DELETE, 500), { x: -500, y: 0 });
  assert.deepEqual(exitVector(ACTION.KEEP, 500), { x: 500, y: 0 });
  assert.deepEqual(exitVector(ACTION.SKIP, 500), { x: 0, y: -500 });
  assert.deepEqual(exitVector(null, 500), { x: 0, y: 0 });
});

test("ReviewQueue walks forward and reports progress", () => {
  const q = new ReviewQueue([10, 20, 30]);
  assert.equal(q.length, 3);
  assert.equal(q.current(), 10);
  assert.equal(q.position(), 1);
  assert.equal(q.remaining, 3);
  assert.equal(q.advance(), 20);
  assert.equal(q.position(), 2);
  assert.equal(q.remaining, 2);
  q.advance();
  assert.equal(q.advance(), null);
  assert.equal(q.atEnd(), true);
  assert.equal(q.remaining, 0);
});

test("ReviewQueue handles an empty queue", () => {
  const q = new ReviewQueue([]);
  assert.equal(q.current(), null);
  assert.equal(q.position(), 0);
  assert.equal(q.remaining, 0);
  assert.equal(q.atEnd(), true);
});

test("skipping defers the item to the back instead of dropping it", () => {
  const q = new ReviewQueue([1, 2, 3]);
  assert.equal(q.deferCurrent(), 1);
  assert.deepEqual(q.ids, [2, 3, 1]);
  assert.equal(q.current(), 2);
  assert.equal(q.deferred, 1);
  // A second skip of the same pass keeps moving it back.
  q.deferCurrent();
  q.deferCurrent();
  assert.deepEqual(q.ids, [1, 2, 3]);
  assert.equal(q.deferred, 3);
});

test("deferCurrent on an empty queue is a no-op", () => {
  const q = new ReviewQueue([]);
  assert.equal(q.deferCurrent(), null);
  assert.equal(q.deferred, 0);
});

test("focusId finds a deferred item, which a cursor step-back would miss", () => {
  const q = new ReviewQueue([1, 2, 3]);
  q.deferCurrent(); // 1 is deferred to the back, cursor still at 2
  assert.equal(q.current(), 2);
  // Undo of the skip must land on 1, which now sits at the end.
  q.focusId(1);
  assert.equal(q.current(), 1);
  assert.deepEqual(q.ids, [2, 3, 1]);
});

test("focusId leaves an id that is not in this queue alone", () => {
  const q = new ReviewQueue([1, 2, 3]);
  q.advance();
  q.advance();
  // The undo stack is session-wide, so the undone id may belong to another
  // root or month. It must not be injected into this queue.
  assert.equal(q.focusId(99), null);
  assert.deepEqual(q.ids, [1, 2, 3]);
  assert.equal(q.current(), 3);
  assert.equal(q.focusId(null), null);
  assert.equal(q.focusId(undefined), null);
});

test("focusId on a keep undo steps back to the decided item", () => {
  const q = new ReviewQueue([1, 2, 3]);
  q.advance(); // kept 1, now on 2
  q.focusId(1);
  assert.equal(q.current(), 1);
});

test("snapshot and restore undo a failed advance", () => {
  const q = new ReviewQueue([1, 2, 3]);
  const before = q.snapshot();
  q.advance();
  q.deferCurrent();
  assert.equal(q.current(), 3);
  q.restore(before);
  assert.deepEqual(q.ids, [1, 2, 3]);
  assert.equal(q.cursor, 0);
  assert.equal(q.deferred, 0);
  assert.equal(q.current(), 1);
});

test("restore tolerates a missing snapshot", () => {
  const q = new ReviewQueue([1, 2]);
  q.restore(null);
  assert.equal(q.current(), 1);
});

test("upcoming prefetches following ids", () => {
  const q = new ReviewQueue([1, 2, 3, 4, 5]);
  assert.deepEqual(q.upcoming(2), [2, 3]);
  assert.deepEqual(q.upcoming(2, 2), [3, 4]);
  assert.deepEqual(q.upcoming(2, 10), []);
});

test("ReviewQueue.reset starts a fresh pass", () => {
  const q = new ReviewQueue([1, 2, 3]);
  q.advance();
  q.deferCurrent();
  q.reset([7, 8]);
  assert.deepEqual(q.ids, [7, 8]);
  assert.equal(q.cursor, 0);
  assert.equal(q.deferred, 0);
  assert.equal(q.current(), 7);
});

test("progressOf reports completion and tolerates a zero total", () => {
  const p = progressOf({ total: 10, reviewed: 4, remaining: 6, staged: 1, skipped: 2, kept: 3, deleted: 1 });
  assert.equal(p.ratio, 0.4);
  assert.equal(p.done, false);
  assert.equal(progressOf({ total: 10, reviewed: 10, remaining: 0 }).done, true);
  assert.equal(progressOf({ total: 10, reviewed: 12, remaining: 0 }).ratio, 1);
  assert.deepEqual(progressOf({ total: 0 }).ratio, 0);
  assert.equal(progressOf(null).done, false);
  assert.equal(progressOf(undefined).total, 0);
});

test("anchorZoom keeps the point under the cursor fixed", () => {
  // Zooming in 2x with the cursor 100px right of and 40px below the centre.
  // The cursor's offset from the image centre must double, which is what makes
  // the pixel under the cursor stay put.
  const r = anchorZoom(100, 40, 0, 0, 2, 1);
  assert.equal(r.x, -100);
  assert.equal(r.y, -40);
  assert.equal(100 - r.x, 200, "offset from centre doubles");
  assert.equal(40 - r.y, 80);
});

test("anchorZoom from an already-zoomed state stays anchored", () => {
  // Second step: from scale 2 at (-100,-40) up to scale 4, same cursor point.
  const first = anchorZoom(100, 40, 0, 0, 2, 1);
  const second = anchorZoom(100, 40, first.x, first.y, 4, 2);
  assert.equal(100 - second.x, 400, "offset quadruples from the original");
  assert.equal(40 - second.y, 160);
});

test("anchorZoom is a no-op at an unchanged scale", () => {
  assert.deepEqual(anchorZoom(10, 10, 5, 7, 3, 3), { x: 5, y: 7 });
});

test("anchorZoom zooms out toward the cursor too", () => {
  // Halving must pull the image back so the same pixel stays under the cursor.
  const r = anchorZoom(100, 0, -100, 0, 0.5, 1);
  assert.equal(r.x, 0);
  assert.equal(100 - r.x, 100, "offset halves from 200");
});

test("clampScale keeps the zoom inside 1x..MAX_ZOOM", () => {
  assert.equal(clampScale(1, 1.25), 1.25);
  assert.equal(clampScale(1, 0.5), 1, "never zooms out past 100%");
  assert.equal(clampScale(MAX_ZOOM, 2), MAX_ZOOM);
  assert.equal(clampScale(MAX_ZOOM - 1, 4), MAX_ZOOM);
  assert.equal(MAX_ZOOM, 8);
});

test("the pan threshold is a real zoom, not a hair", () => {
  // Past 20% a drag pans instead of swiping.
  assert.equal(ZOOM_PAN_THRESHOLD, 1.2);
  assert.equal(1.19 < ZOOM_PAN_THRESHOLD, true);
  assert.equal(1.21 >= ZOOM_PAN_THRESHOLD, true);
});
