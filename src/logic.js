/**
 * Pure logic for Shotpile. No DOM and no Tauri calls, so it can be
 * unit tested with `node --test tests/`.
 */

export const GESTURE_THRESHOLD = 90;
export const AXIS_LOCK_RATIO = 1.2;

/** Zoom ceiling, shared by the card and the full-screen viewer. */
export const MAX_ZOOM = 8;

/**
 * Past this zoom a drag pans the image instead of swiping the card.
 *
 * A drag on a card means "decide this photo", so it cannot also mean "move the
 * zoomed image" at rest. Requiring a real zoom first keeps the swipe gesture
 * exactly as it was until the user has deliberately zoomed in.
 */
export const ZOOM_PAN_THRESHOLD = 1.2;

export const ACTION = {
  KEEP: "keep",
  DELETE: "delete",
  SKIP: "skip",
};

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SHORT_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "2026-09" -> "September 2026". With `year: false` only the month name is
 * returned, for lists that already group by year. Malformed input comes back
 * unchanged.
 */
export function monthLabel(month, { short = false, year = true } = {}) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ""));
  if (!m) return String(month ?? "");
  const index = Number(m[2]) - 1;
  if (index < 0 || index > 11) return String(month);
  const name = (short ? SHORT_MONTH_NAMES : MONTH_NAMES)[index];
  return year ? `${name} ${Number(m[1])}` : name;
}

/** Pinned to en-US: the UI is English-only, so grouping must not follow the OS. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** 1284 -> "1,284". */
export function formatCount(n) {
  return COUNT_FORMAT.format(Number(n) || 0);
}

/**
 * A number with its noun: `countOf(1, "file")` -> "1 file",
 * `countOf(1284, "screenshot")` -> "1,284 screenshots".
 *
 * Exists because "1 files" kept slipping into the UI wherever a count was
 * glued to a fixed plural.
 */
export function countOf(n, singular, plural = `${singular}s`) {
  const value = Number(n) || 0;
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

/**
 * Which decision a drag/throw maps to, or null while it is still ambiguous.
 *
 * Left is delete, right is keep, up is skip. The dominant axis wins once the
 * drag clears the threshold, which keeps diagonal wobble from choosing for the
 * user.
 */
export function classifyGesture(dx, dy, threshold = GESTURE_THRESHOLD) {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < threshold && ady < threshold) return null;
  if (adx >= ady * AXIS_LOCK_RATIO) return dx < 0 ? ACTION.DELETE : ACTION.KEEP;
  if (ady >= adx * AXIS_LOCK_RATIO) return dy < 0 ? ACTION.SKIP : null;
  // Too diagonal to call: fall back to the larger axis.
  if (adx >= ady) return dx < 0 ? ACTION.DELETE : ACTION.KEEP;
  return dy < 0 ? ACTION.SKIP : null;
}

/** Visual hint for a drag, including partial progress, used for card styling. */
export function gestureVisual(dx, dy, threshold = GESTURE_THRESHOLD) {
  const action = classifyGesture(dx, dy, threshold);
  const distance = Math.hypot(dx, dy);
  return {
    action,
    progress: Math.min(1, distance / threshold),
    /** 0 for horizontal, 1 for vertical. */
    vertical: Math.abs(dy) > Math.abs(dx) ? 1 : 0,
  };
}

/**
 * Tilt of a dragged card, in degrees.
 *
 * Only the horizontal offset tilts the card: a skip is a straight lift, and
 * tilting it by the vertical distance made an upward drag read as a throw to
 * the side. Grabbing the lower half pivots the other way, the way a physical
 * card held near its bottom edge would. Clamped so a long drag never spins it.
 */
export function dragTilt(dx, grabbedLowerHalf = false, max = 14) {
  const raw = dx * 0.045 * (grabbedLowerHalf ? -1 : 1);
  return Math.max(-max, Math.min(max, raw));
}

/**
 * Cursor-anchored zoom.
 *
 * The image is laid out centred in its wrapper and moved with
 * `translate(x, y) scale(s)`, so `transform-origin: center` scales about the
 * image's own centre. `dx`/`dy` are the cursor's offset from that centre and
 * `k` is the new/old scale ratio.
 *
 * The point under the cursor has to stay under the cursor, so the offset from
 * the image centre must grow by exactly `k`. Solving for the translate that
 * does that gives `x' = dx - (dx - x) * k`.
 */
export function anchorZoom(dx, dy, x, y, nextScale, scale) {
  if (scale === nextScale) return { x, y };
  const k = nextScale / scale;
  return { x: dx - (dx - x) * k, y: dy - (dy - y) * k };
}

/**
 * The zoom factor for one wheel event. A mouse wheel sends big steps (about
 * 100 px per notch), a touchpad sends many small ones, and a touchpad pinch
 * arrives as a ctrl+wheel with deltas of a few pixels. An exponential of the
 * delta makes all three feel alike, where a fixed step per event made a
 * touchpad jump or stall. Line and page modes are scaled to pixels first.
 */
export function wheelZoomFactor(deltaY, deltaMode = 0, pinch = false) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = Math.max(-120, Math.min(120, px));
  return Math.exp(-capped * (pinch ? 0.012 : 0.0016));
}

/** Clamps a scale to the 1x..MAX_ZOOM range the viewer and card both use. */
export function clampScale(scale, factor, min = 1, max = MAX_ZOOM) {
  return Math.min(max, Math.max(min, scale * factor));
}

/**
 * The size of a photo inside a frame under `object-fit: contain`.
 *
 * The image element fills its frame and the photo is letterboxed inside it, so
 * the element box is not the photo. Pan bounds have to be measured on this.
 */
export function containedSize(naturalW, naturalH, frameW, frameH) {
  if (!naturalW || !naturalH || !frameW || !frameH) return { w: frameW, h: frameH };
  const k = Math.min(frameW / naturalW, frameH / naturalH);
  return { w: naturalW * k, h: naturalH * k };
}

/**
 * How far a zoomed photo may be panned along one axis.
 *
 * Two bounds, and the larger wins:
 *   - half the content's growth, the most translate a cursor-anchored zoom can
 *     ever need. Without it the clamp zeroes the anchor on a letterboxed photo,
 *     where "scaled content minus frame" goes negative.
 *   - half the leftover frame, so a photo smaller than its frame can still be
 *     slid around without leaving it.
 */
export function panLimit(content, frame, scale) {
  return Math.max(0, (content * scale - content) / 2, (frame - content * scale) / 2);
}

/**
 * "1.5 MB". The space is non-breaking, so a size never wraps between the
 * number and its unit.
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}\u00a0B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}\u00a0${units[i]}`;
}

export function formatDateTime(ms) {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago", then a plain date. */
export function timeAgo(ms, now = Date.now()) {
  if (!ms) return "never";
  const diff = Math.max(0, now - Number(ms));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${countOf(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${countOf(days, "day")} ago`;
  return formatDateTime(ms).slice(0, 10);
}

export const DATE_SOURCE_LABELS = {
  filename: "from filename",
  created: "from creation date",
  modified: "from modified date",
  unknown: "no date",
};

/** Local minutes east of UTC, which is what the month grouping expects. */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * The folder's own name, for compact labels: "C:\\Users\\me\\Pictures\\" ->
 * "Pictures". Handles both separators and trailing ones; a bare drive or root
 * comes back as given.
 */
export function basename(path) {
  const s = String(path ?? "");
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return s;
  return parts[parts.length - 1];
}

/** One-line description of a scan report for a toast. */
export function scanSummary(report) {
  if (!report) return "";
  const bits = [];
  if (report.added) bits.push(`${formatCount(report.added)} new`);
  if (report.refreshed) bits.push(`${formatCount(report.refreshed)} already known`);
  if (!report.added && !report.refreshed) bits.push("no screenshots found");
  if (report.restored) bits.push(`${formatCount(report.restored)} restored, now kept`);
  if (report.unviewable) bits.push(`${formatCount(report.unviewable)} without preview`);
  if (report.missing) bits.push(`${formatCount(report.missing)} missing on disk`);
  return bits.join(" · ");
}

/**
 * Status segments for a stacked progress bar, in a fixed order so bars line up
 * across rows. Pending is the unfilled remainder and is not a segment.
 */
export const SEGMENT_ORDER = ["kept", "staged", "deleted", "skipped"];

export function statusSegments(stat) {
  const total = Number(stat?.total) || 0;
  if (!total) return [];
  return SEGMENT_ORDER
    .map((key) => ({ key, n: Number(stat?.[key]) || 0 }))
    .filter((s) => s.n > 0)
    .map((s) => ({ ...s, ratio: Math.min(1, s.n / total) }));
}

/** Months as `[{ year, months }]`, preserving the incoming (newest-first) order. */
export function groupByYear(months) {
  const out = [];
  for (const m of months || []) {
    const year = String(m?.month ?? "").slice(0, 4) || "Undated";
    let group = out[out.length - 1];
    if (!group || group.year !== year) {
      group = { year, months: [] };
      out.push(group);
    }
    group.months.push(m);
  }
  return out;
}

/**
 * The month to offer after finishing `current`: the nearest later month that
 * still has work, else the nearest earlier one, else null.
 */
export function nextMonthWithWork(months, current) {
  const open = (months || []).filter(
    (m) => m.month !== current && (Number(m.remaining) || 0) > 0,
  );
  const key = (m) => String(m.month ?? "");
  const later = open.filter((m) => key(m) > String(current ?? ""));
  if (later.length) return later.reduce((a, m) => (key(m) < key(a) ? m : a)).month;
  const earlier = open.filter((m) => key(m) < String(current ?? ""));
  return earlier.length ? earlier.reduce((a, m) => (key(m) > key(a) ? m : a)).month : null;
}

/**
 * The review queue: an ordered list of ids with a cursor, plus session-level
 * deferral for skipped items.
 *
 * A skip does not remove the item from view, it moves it to the back of the
 * queue so the same pass can come back to it, while the persisted status
 * ("skipped") keeps it out of the month totals as reviewed.
 *
 * Each item is deferred at most once per pass. Skipping an item that already
 * came back, or skipping the very last item, simply moves on: deferring those
 * would put the same card straight back on screen, so the Skip button looked
 * broken and a pass of nothing but skips never ended.
 */
export class ReviewQueue {
  constructor(ids = []) {
    this.reset(ids);
  }

  get length() {
    return this.ids.length;
  }

  get remaining() {
    return Math.max(0, this.ids.length - this.cursor);
  }

  /** The id under the cursor, or null when the queue is exhausted. */
  current() {
    if (this.cursor < 0 || this.cursor >= this.ids.length) return null;
    return this.ids[this.cursor];
  }

  /** Position among all items, 1-based, for "23 of 140" style progress. */
  position() {
    if (this.ids.length === 0) return 0;
    return Math.min(this.cursor + 1, this.ids.length);
  }

  advance() {
    if (this.cursor < this.ids.length) this.cursor += 1;
    return this.current();
  }

  /**
   * Moves the current item to the back of the queue, once per pass. Returns
   * the id that was skipped, or null on an exhausted queue.
   */
  deferCurrent() {
    const id = this.current();
    if (id === null) return null;
    const last = this.cursor === this.ids.length - 1;
    if (last || this.deferredIds.has(id)) {
      this.advance();
      return id;
    }
    this.ids.splice(this.cursor, 1);
    this.ids.push(id);
    this.deferredIds.add(id);
    this.deferred += 1;
    return id;
  }

  /**
   * Points the cursor back at `id`, but only when it is still queued.
   *
   * Undo cannot simply step the cursor back by one: a skipped item was deferred
   * to the back of the list. Seeking to it there would also be wrong, because
   * deciding it would then end the pass and silently jump over every item that
   * was still waiting in between. So undoing a skip moves the item back to the
   * cursor, which restores the exact pre-skip order.
   *
   * An id that is not in this queue at all is left alone rather than injected:
   * the undo stack is session-wide, so it may belong to another root or month.
   */
  focusId(id) {
    if (id === null || id === undefined) return null;
    const index = this.ids.indexOf(id);
    if (index === -1) return null;
    if (index >= this.cursor && this.deferredIds.has(id)) {
      this.ids.splice(index, 1);
      this.ids.splice(this.cursor, 0, id);
      this.deferredIds.delete(id);
      this.deferred = Math.max(0, this.deferred - 1);
    } else {
      this.cursor = index;
    }
    return id;
  }

  /** Copy of the queue state, so a failed write can be rolled back. */
  snapshot() {
    return {
      ids: this.ids.slice(),
      cursor: this.cursor,
      deferred: this.deferred,
      deferredIds: [...this.deferredIds],
    };
  }

  /** Restores a `snapshot()`, e.g. when persisting a decision fails. */
  restore(snap) {
    if (!snap) return;
    this.ids = snap.ids.slice();
    this.cursor = snap.cursor;
    this.deferred = snap.deferred;
    this.deferredIds = new Set(snap.deferredIds || []);
  }

  atEnd() {
    return this.cursor >= this.ids.length;
  }

  /** The next few ids, for prefetching. */
  upcoming(count = 2, offset = 1) {
    return this.ids.slice(this.cursor + offset, this.cursor + offset + count);
  }

  reset(ids) {
    this.ids = (ids || []).slice();
    this.cursor = 0;
    this.deferred = 0;
    this.deferredIds = new Set();
  }
}

/**
 * Decisions made during one pass through a queue, keyed by id so re-deciding
 * a file (after jumping back to it) replaces its entry instead of counting it
 * twice. Feeds the live tally and the end-of-pass summary.
 */
export class PassTally {
  constructor() {
    this.byId = new Map();
  }

  /** Records `action` for `id` and returns what it replaced, for undo. */
  record(id, action, bytes = 0) {
    const prev = this.byId.get(id);
    this.byId.set(id, { action, bytes: Number(bytes) || 0 });
    return prev;
  }

  /** Puts back what `record()` returned. */
  revert(id, prev) {
    if (prev) this.byId.set(id, prev);
    else this.byId.delete(id);
  }

  get size() {
    return this.byId.size;
  }

  counts() {
    const out = { keep: 0, delete: 0, skip: 0, deleteBytes: 0 };
    for (const { action, bytes } of this.byId.values()) {
      if (action in out) out[action] += 1;
      if (action === ACTION.DELETE) out.deleteBytes += bytes;
    }
    return out;
  }

  snapshot() {
    return new Map(this.byId);
  }

  restore(snap) {
    this.byId = new Map(snap || []);
  }
}

/** Progress numbers for a month row or the header. */
export function progressOf(stat) {
  const total = Number(stat?.total) || 0;
  const reviewed = Number(stat?.reviewed) || 0;
  const remaining = Number(stat?.remaining) || 0;
  return {
    total,
    reviewed,
    remaining,
    staged: Number(stat?.staged) || 0,
    skipped: Number(stat?.skipped) || 0,
    kept: Number(stat?.kept) || 0,
    deleted: Number(stat?.deleted) || 0,
    /** 0..1 of files that have a final keep/delete answer. */
    ratio: total === 0 ? 0 : Math.min(1, reviewed / total),
    done: total > 0 && remaining === 0,
  };
}

/** How far a fling should carry the card off-screen, per action. */
export function exitVector(action, distance = 900) {
  switch (action) {
    case ACTION.DELETE:
      return { x: -distance, y: 0 };
    case ACTION.KEEP:
      return { x: distance, y: 0 };
    case ACTION.SKIP:
      return { x: 0, y: -distance };
    default:
      return { x: 0, y: 0 };
  }
}

/** Keybinding actions with human-readable descriptions. */
export const ACTIONS = {
  DELETE: { id: "delete", label: "Mark for deletion", group: "Sorting" },
  KEEP: { id: "keep", label: "Keep", group: "Sorting" },
  SKIP: { id: "skip", label: "Skip for now", group: "Sorting" },
  UNDO: { id: "undo", label: "Undo the last decision", group: "Sorting" },
  REDO: { id: "redo", label: "Redo", group: "Sorting" },
  PREV_IMAGE: { id: "prevImage", label: "Previous image in filmstrip", group: "Sorting" },
  NEXT_IMAGE: { id: "nextImage", label: "Next image in filmstrip", group: "Sorting" },
  ZOOM_IN: { id: "zoomIn", label: "Zoom in", group: "Looking closer" },
  ZOOM_OUT: { id: "zoomOut", label: "Zoom out", group: "Looking closer" },
  ZOOM_RESET: { id: "zoomReset", label: "Reset zoom to 100%", group: "Looking closer" },
  OPEN_VIEWER: { id: "openViewer", label: "Open full screen", group: "Looking closer" },
  OPEN_OPTIONS: { id: "openOptions", label: "Options", group: "Window" },
  HELP: { id: "help", label: "Keyboard shortcuts", group: "Window" },
};

/** Default key bindings: key -> action id. */
export const DEFAULT_KEYS = {
  ArrowLeft: ACTIONS.DELETE.id,
  ArrowRight: ACTIONS.KEEP.id,
  ArrowUp: ACTIONS.SKIP.id,
  z: ACTIONS.UNDO.id,
  Z: ACTIONS.UNDO.id,
  Backspace: ACTIONS.UNDO.id,
  y: ACTIONS.REDO.id,
  Y: ACTIONS.REDO.id,
  a: ACTIONS.PREV_IMAGE.id,
  A: ACTIONS.PREV_IMAGE.id,
  d: ACTIONS.NEXT_IMAGE.id,
  D: ACTIONS.NEXT_IMAGE.id,
  ArrowDown: ACTIONS.PREV_IMAGE.id,
  "+": ACTIONS.ZOOM_IN.id,
  "=": ACTIONS.ZOOM_IN.id,
  "-": ACTIONS.ZOOM_OUT.id,
  "_": ACTIONS.ZOOM_OUT.id,
  0: ACTIONS.ZOOM_RESET.id,
  " ": ACTIONS.OPEN_VIEWER.id,
  "?": ACTIONS.HELP.id,
};

/**
 * Get current key bindings from preferences, or defaults if not set.
 * Returns a map of key -> action id.
 */
export function getKeyBindings(prefs) {
  if (!prefs) return DEFAULT_KEYS;
  const saved = prefs.get().keyBindings;
  return saved ? { ...DEFAULT_KEYS, ...saved } : DEFAULT_KEYS;
}

/**
 * Save key bindings to preferences.
 */
export function setKeyBindings(prefs, bindings) {
  const current = prefs.get();
  prefs.set({ ...current, keyBindings: bindings });
}

/**
 * Get all keys bound to a specific action id.
 */
export function getKeysForAction(actionId, bindings) {
  return Object.entries(bindings)
    .filter(([, id]) => id === actionId)
    .map(([key]) => key);
}

/**
 * Detect if a key is already bound to a different action.
 * Returns the action id it's currently bound to, or null if unbound or same action.
 */
export function detectKeyConflict(key, targetActionId, bindings) {
  const boundActionId = bindings[key];
  if (!boundActionId || boundActionId === targetActionId) return null;
  return boundActionId;
}

/**
 * Reset key bindings to defaults.
 */
export function resetKeyBindings(prefs) {
  prefs.set({ keyBindings: null });
}

/**
 * Filter a filename by substring match. Case-insensitive. Returns true if the
 * filename should be included in the filtered results.
 *
 * Empty filter string includes everything. Filters on the filename only,
 * not the full path.
 */
export function matchesFilename(filename, filter) {
  if (!filter || !String(filter).trim()) return true;
  return String(filename || "").toLowerCase().includes(String(filter).toLowerCase());
}
