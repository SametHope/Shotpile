import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION,
  ACTIONS,
  DEFAULT_KEYS,
  GESTURE_THRESHOLD,
  MAX_ZOOM,
  PassTally,
  ReviewQueue,
  ZOOM_PAN_THRESHOLD,
  anchorZoom,
  basename,
  classifyGesture,
  clampScale,
  detectKeyConflict,
  getKeysForAction,
  getKeyBindings,
  resetKeyBindings,
  setKeyBindings,
  wheelZoomFactor,
  containedSize,
  countOf,
  dragTilt,
  exitVector,
  formatBytes,
  formatCount,
  gestureVisual,
  groupByYear,
  monthLabel,
  nextMonthWithWork,
  panLimit,
  progressOf,
  scanSummary,
  statusSegments,
  timeAgo,
} from "../src/logic.js";

test("monthLabel renders English month names", () => {
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("2026-01"), "January 2026");
  assert.equal(monthLabel("2026-12"), "December 2026");
  assert.equal(monthLabel("2026-09", { short: true }), "Sep 2026");
  assert.equal(monthLabel("2026-09", { year: false }), "September");
});

test("countOf pluralises and groups digits", () => {
  assert.equal(countOf(1, "file"), "1 file");
  assert.equal(countOf(0, "file"), "0 files");
  assert.equal(countOf(2, "file"), "2 files");
  assert.equal(countOf(1284, "screenshot"), "1,284 screenshots");
  assert.equal(countOf(3, "entry", "entries"), "3 entries");
  assert.equal(countOf(undefined, "file"), "0 files");
  assert.equal(formatCount(1234567), "1,234,567");
});

test("basename takes the last segment on either separator", () => {
  assert.equal(basename("C:\\Users\\me\\Pictures\\Screenshots"), "Screenshots");
  assert.equal(basename("C:\\Users\\me\\Pictures\\"), "Pictures");
  assert.equal(basename("/home/me/shots/"), "shots");
  assert.equal(basename("C:"), "C:");
  assert.equal(basename(""), "");
  assert.equal(basename(null), "");
});

test("scanSummary describes a scan in one line", () => {
  assert.equal(
    scanSummary({ added: 12, refreshed: 1400, unviewable: 2, missing: 0 }),
    "12 new · 1,400 already known · 2 without preview"
  );
  assert.equal(scanSummary({ added: 0, refreshed: 0, missing: 3 }), "no screenshots found · 3 missing on disk");
  assert.equal(scanSummary({ added: 0, refreshed: 5, restored: 2 }), "5 already known · 2 restored, now kept");
  assert.equal(scanSummary(null), "");
});

test("statusSegments orders segments and leaves pending as the remainder", () => {
  const segs = statusSegments({ total: 10, kept: 4, staged: 1, deleted: 0, skipped: 2, remaining: 3 });
  assert.deepEqual(segs.map((s) => s.key), ["kept", "staged", "skipped"]);
  assert.equal(segs[0].ratio, 0.4);
  assert.deepEqual(statusSegments({ total: 0, kept: 3 }), []);
  assert.deepEqual(statusSegments(null), []);
});

test("groupByYear keeps newest-first order", () => {
  const groups = groupByYear([{ month: "2026-02" }, { month: "2026-01" }, { month: "2025-12" }]);
  assert.deepEqual(groups.map((g) => g.year), ["2026", "2025"]);
  assert.deepEqual(groups[0].months.map((m) => m.month), ["2026-02", "2026-01"]);
  assert.deepEqual(groupByYear(undefined), []);
});

test("nextMonthWithWork goes chronologically forward, else backward", () => {
  const months = [
    { month: "2026-03", remaining: 4 },
    { month: "2026-02", remaining: 0 },
    { month: "2026-01", remaining: 2 },
    { month: "2025-06", remaining: 1 },
    { month: "2025-05", remaining: 3 },
  ];
  assert.equal(nextMonthWithWork(months, "2025-05"), "2025-06", "nearest later month");
  assert.equal(nextMonthWithWork(months, "2025-06"), "2026-01", "skips finished months");
  assert.equal(nextMonthWithWork(months, "2026-03"), "2026-01", "no later month: nearest earlier");
  assert.equal(nextMonthWithWork([{ month: "2026-03", remaining: 4 }], "2026-03"), null);
});

test("timeAgo reads naturally", () => {
  const now = Date.UTC(2026, 8, 30, 12);
  assert.equal(timeAgo(now - 10_000, now), "just now");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5 min ago");
  assert.equal(timeAgo(now - 3600_000, now), "1 hour ago");
  assert.equal(timeAgo(now - 3 * 86400_000, now), "3 days ago");
  assert.equal(timeAgo(null, now), "never");
});

test("dragTilt follows the horizontal drag and flips for a low grab", () => {
  assert.ok(dragTilt(100) > 0);
  assert.ok(dragTilt(100, true) < 0);
  assert.equal(dragTilt(0), 0);
  assert.equal(dragTilt(10_000), 14, "clamped");
});

test("containedSize letterboxes like object-fit: contain", () => {
  assert.deepEqual(containedSize(2000, 1000, 500, 500), { w: 500, h: 250 });
  assert.deepEqual(containedSize(0, 0, 500, 400), { w: 500, h: 400 }, "unknown size falls back to the frame");
});

test("panLimit allows the anchored zoom on a letterboxed photo", () => {
  // A 500x250 photo in a 500x500 frame at 2x: content grew by 250 on y, so the
  // anchor may need up to 125px; "content minus frame" would have said 0.
  assert.equal(panLimit(250, 500, 2), 125);
  // A small photo at 1.2x still has leftover frame to slide in.
  assert.equal(panLimit(100, 500, 1.2), 190);
});

test("PassTally counts the latest decision per file and reverts", () => {
  const t = new PassTally();
  t.record(1, ACTION.KEEP);
  const prev = t.record(1, ACTION.DELETE, 2048); // re-decided after a jump back
  t.record(2, ACTION.SKIP);
  assert.deepEqual(t.counts(), { keep: 0, delete: 1, skip: 1, deleteBytes: 2048 });
  t.revert(1, prev);
  assert.deepEqual(t.counts(), { keep: 1, delete: 0, skip: 1, deleteBytes: 0 });
  t.revert(2, undefined);
  assert.equal(t.size, 1);
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
  // Compared with plain spaces; the real separator is a non-breaking one.
  const f = (n) => formatBytes(n).replace(/\u00a0/g, " ");
  assert.equal(f(0), "0 B");
  assert.equal(f(512), "512 B");
  assert.equal(f(1024), "1.0 KB");
  assert.equal(f(1536), "1.5 KB");
  assert.equal(f(20 * 1024), "20 KB");
  assert.equal(f(5 * 1024 * 1024), "5.0 MB");
  assert.equal(f(2 * 1024 * 1024 * 1024), "2.0 GB");
});

test("formatBytes never lets a size wrap between number and unit", () => {
  assert.equal(formatBytes(189 * 1024), "189\u00a0KB");
  assert.ok(!/ /.test(formatBytes(5 * 1024 * 1024)));
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
});

test("undoing a skip restores the pre-skip order instead of ending the pass", () => {
  // The old behaviour seeked to the deferred item at the back. Deciding it then
  // advanced past the end and silently dropped 2 and 3 from the pass.
  const q = new ReviewQueue([1, 2, 3]);
  q.deferCurrent();
  q.focusId(1);
  assert.deepEqual(q.ids, [1, 2, 3]);
  assert.equal(q.cursor, 0);
  assert.equal(q.deferred, 0);
  q.advance(); // decide 1
  assert.equal(q.current(), 2, "the items that were waiting are still ahead");
  // The undone skip no longer counts, so 1 could be skipped again later.
  assert.equal(q.deferredIds.has(1), false);
});

test("each item is deferred at most once per pass", () => {
  const q = new ReviewQueue([1, 2]);
  q.deferCurrent(); // [2, 1]
  q.advance(); // decide 2, now on the deferred 1
  assert.equal(q.current(), 1);
  // Skipping it a second time moves on instead of showing it yet again.
  assert.equal(q.deferCurrent(), 1);
  assert.equal(q.atEnd(), true);
  assert.equal(q.deferred, 1);
});

test("skipping the last item ends the pass instead of looping on it", () => {
  const q = new ReviewQueue([7]);
  assert.equal(q.deferCurrent(), 7);
  assert.equal(q.atEnd(), true);
  assert.equal(q.deferred, 0);
});

test("snapshot and restore cover the deferred set", () => {
  const q = new ReviewQueue([1, 2, 3]);
  const before = q.snapshot();
  q.deferCurrent();
  q.restore(before);
  assert.equal(q.deferredIds.size, 0);
  q.deferCurrent();
  const mid = q.snapshot();
  q.advance();
  q.restore(mid);
  assert.equal(q.deferredIds.has(1), true);
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

test("wheelZoomFactor: direction, touchpad smoothness and a cap", () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(0), 1);
  // Many small touchpad events add up to about one notch, not one jump each.
  const small = wheelZoomFactor(-4) ** 25;
  assert.ok(Math.abs(small - wheelZoomFactor(-100)) < 0.05, `${small}`);
  // A pinch (ctrl+wheel) is more sensitive than a plain wheel.
  assert.ok(wheelZoomFactor(-4, 0, true) > wheelZoomFactor(-4, 0, false));
  // One huge event cannot jump past the cap; line mode counts as pixels.
  assert.equal(wheelZoomFactor(-5000), wheelZoomFactor(-120));
  assert.equal(wheelZoomFactor(-3, 1), wheelZoomFactor(-48, 0));
});

test("keybinding actions are defined with metadata", () => {
  assert.ok(ACTIONS.DELETE);
  assert.equal(ACTIONS.DELETE.id, "delete");
  assert.equal(ACTIONS.DELETE.group, "Sorting");
});

test("DEFAULT_KEYS maps keys to action ids", () => {
  assert.equal(DEFAULT_KEYS.ArrowLeft, ACTIONS.DELETE.id);
  assert.equal(DEFAULT_KEYS.ArrowRight, ACTIONS.KEEP.id);
  assert.equal(DEFAULT_KEYS.ArrowUp, ACTIONS.SKIP.id);
});

test("getKeyBindings returns defaults when no custom bindings exist", () => {
  const mockPrefs = {
    get: () => ({ someOtherPref: "value" }),
    set: () => {},
  };
  const bindings = getKeyBindings(mockPrefs);
  assert.equal(bindings.ArrowLeft, ACTIONS.DELETE.id);
  assert.equal(bindings[" "], ACTIONS.OPEN_VIEWER.id);
});

test("getKeyBindings merges custom bindings with defaults", () => {
  const mockPrefs = {
    get: () => ({ keyBindings: { "ArrowLeft": ACTIONS.KEEP.id } }),
    set: () => {},
  };
  const bindings = getKeyBindings(mockPrefs);
  assert.equal(bindings.ArrowLeft, ACTIONS.KEEP.id, "custom overrides default");
  assert.equal(bindings.ArrowRight, ACTIONS.KEEP.id, "other defaults still exist");
});

test("setKeyBindings saves to prefs", () => {
  let savedPrefs = null;
  const mockPrefs = {
    get: () => ({ existingPref: "value" }),
    set: (prefs) => { savedPrefs = prefs; },
  };
  const newBindings = { "a": ACTIONS.KEEP.id };
  setKeyBindings(mockPrefs, newBindings);
  assert.deepEqual(savedPrefs.keyBindings, newBindings);
  assert.equal(savedPrefs.existingPref, "value", "preserves other prefs");
});

test("getKeysForAction finds all keys bound to an action", () => {
  const bindings = { "a": ACTIONS.DELETE.id, "A": ACTIONS.DELETE.id, "b": ACTIONS.KEEP.id };
  const deleteKeys = getKeysForAction(ACTIONS.DELETE.id, bindings);
  assert.deepEqual(deleteKeys.sort(), ["A", "a"]);
  const keepKeys = getKeysForAction(ACTIONS.KEEP.id, bindings);
  assert.deepEqual(keepKeys, ["b"]);
});

test("detectKeyConflict finds when a key is bound to a different action", () => {
  const bindings = { "a": ACTIONS.DELETE.id, "b": ACTIONS.KEEP.id };
  assert.equal(detectKeyConflict("a", ACTIONS.DELETE.id, bindings), null, "no conflict for same action");
  assert.equal(detectKeyConflict("a", ACTIONS.KEEP.id, bindings), ACTIONS.DELETE.id, "conflict detected");
  assert.equal(detectKeyConflict("c", ACTIONS.KEEP.id, bindings), null, "no conflict for unbound key");
});

test("resetKeyBindings removes custom bindings from prefs", () => {
  let savedPrefs = null;
  const mockPrefs = {
    get: () => ({ keyBindings: { "a": ACTIONS.KEEP.id }, otherPref: "value" }),
    set: (prefs) => { savedPrefs = prefs; },
  };
  resetKeyBindings(mockPrefs);
  assert.equal(savedPrefs.keyBindings, null, "keyBindings set to null for deletion");
});
