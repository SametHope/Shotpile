/**
 * Pure logic for Screenshot Sifter. No DOM and no Tauri calls, so it can be
 * unit tested with `node --test tests/`.
 */

export const GESTURE_THRESHOLD = 90;
export const AXIS_LOCK_RATIO = 1.2;

export const ACTION = {
  KEEP: "keep",
  DELETE: "delete",
  SKIP: "skip",
};

export const MONTH_NAMES = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];

const SHORT_MONTH_NAMES = [
  "Oca", "Şub", "Mar", "Nis", "May", "Haz",
  "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara",
];

/** "2026-09" -> "Eylül 2026". Returns the input unchanged if it is malformed. */
export function monthLabel(month, { short = false } = {}) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ""));
  if (!m) return String(month ?? "");
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  if (index < 0 || index > 11) return String(month);
  const name = (short ? SHORT_MONTH_NAMES : MONTH_NAMES)[index];
  return `${name} ${year}`;
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
    /** 0 for horizontal, 1 for vertical; drives the rotation angle. */
    vertical: Math.abs(dy) > Math.abs(dx) ? 1 : 0,
  };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatDateTime(ms) {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const DATE_SOURCE_LABELS = {
  filename: "dosya adından",
  created: "oluşturma tarihinden",
  modified: "değiştirme tarihinden",
  unknown: "tarih yok",
};

/** Local minutes east of UTC, which is what the month grouping expects. */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * The review queue: an ordered list of ids with a cursor, plus session-level
 * deferral for skipped items.
 *
 * A skip does not remove the item from view, it moves it to the back of the
 * queue so the same pass can come back to it, while the persisted status
 * ("skipped") keeps it out of the month totals as reviewed.
 */
export class ReviewQueue {
  constructor(ids = []) {
    this.ids = ids.slice();
    this.cursor = 0;
    this.deferred = 0;
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

  /** Position among all items, 1-based, for "23 / 140" style progress. */
  position() {
    if (this.ids.length === 0) return 0;
    return Math.min(this.cursor + 1, this.ids.length);
  }

  advance() {
    if (this.cursor < this.ids.length) this.cursor += 1;
    return this.current();
  }

  /** Keeps the current item but moves it to the back of the queue. */
  deferCurrent() {
    const id = this.current();
    if (id === null) return null;
    this.ids.splice(this.cursor, 1);
    this.ids.push(id);
    this.deferred += 1;
    return id;
  }

  /** Re-inserts an id right after the cursor, for undo. */
  reinsertAfterCursor(id) {
    if (id === null || id === undefined) return;
    if (this.ids.includes(id)) return;
    this.ids.splice(this.cursor, 0, id);
  }

  /**
   * Points the cursor back at `id`, re-inserting it if it is no longer queued.
   *
   * Undo cannot simply step the cursor back by one: a skipped item was deferred
   * to the back of the list, and an item decided outside this queue is gone
   * entirely. Seeking by id handles every case, and `showCurrent` then re-hydrates
   * whatever the cursor lands on.
   */
  focusId(id) {
    if (id === null || id === undefined) return null;
    this.reinsertAfterCursor(id);
    const index = this.ids.indexOf(id);
    if (index === -1) return null;
    this.cursor = index;
    return id;
  }

  /** Copy of the queue state, so a failed write can be rolled back. */
  snapshot() {
    return { ids: this.ids.slice(), cursor: this.cursor, deferred: this.deferred };
  }

  /** Restores a `snapshot()`, e.g. when persisting a decision fails. */
  restore(snap) {
    if (!snap) return;
    this.ids = snap.ids.slice();
    this.cursor = snap.cursor;
    this.deferred = snap.deferred;
  }

  atEnd() {
    return this.cursor >= this.ids.length;
  }

  /** The next few ids, for prefetching. */
  upcoming(count = 2, offset = 1) {
    return this.ids.slice(this.cursor + offset, this.cursor + offset + count);
  }

  reset(ids) {
    this.ids = ids.slice();
    this.cursor = 0;
    this.deferred = 0;
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
