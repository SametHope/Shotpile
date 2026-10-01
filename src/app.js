/**
 * Shotpile — UI controller.
 *
 * All filesystem, database and Recycle Bin work happens in Rust behind the
 * commands in src-tauri/src/commands.rs. This file orchestrates views, the
 * review deck, gestures and keyboard input. DOM primitives live in dom.js, the
 * full-screen viewer in viewer.js, and everything testable without a DOM in
 * logic.js.
 */

import {
  ACTION,
  DATE_SOURCE_LABELS,
  GESTURE_THRESHOLD,
  PassTally,
  ReviewQueue,
  ZOOM_PAN_THRESHOLD,
  anchorZoom,
  basename,
  clampScale,
  classifyGesture,
  containedSize,
  countOf,
  dragTilt,
  exitVector,
  formatBytes,
  formatCount,
  formatDateTime,
  gestureVisual,
  groupByYear,
  monthLabel,
  nextMonthWithWork,
  panLimit,
  progressOf,
  scanSummary,
  statusSegments,
  timeAgo,
  tzOffsetMinutes,
  wheelZoomFactor,
} from "./logic.js";
import { log } from "./log.js";
import {
  closeMenu,
  closeModal,
  confirmDialog,
  h,
  icon,
  initModal,
  kbd,
  menuOpen,
  modal,
  modalOpen,
  openMenu,
  reducedMotion,
  replay,
  toast,
  wait,
} from "./dom.js";
import { iconSvg } from "./icons.js";
import { closeViewer, openViewer, viewerKeydown, viewerOpen } from "./viewer.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

const el = {
  view: document.getElementById("view"),
  back: document.getElementById("btn-back"),
  folderBtn: document.getElementById("btn-folder"),
  folderName: document.getElementById("folder-name"),
  scan: document.getElementById("btn-scan"),
  stagedBtn: document.getElementById("btn-staged"),
  stagedBadge: document.getElementById("staged-badge"),
  help: document.getElementById("btn-help"),
  footbar: document.getElementById("footbar"),
  stagedN: document.getElementById("staged-n"),
  stagedSize: document.getElementById("staged-size"),
  commit: document.getElementById("btn-commit"),
  undo: document.getElementById("btn-undo"),
  redo: document.getElementById("btn-redo"),
  options: document.getElementById("btn-options"),
};

/** Theme and zoom, owned by boot.js (it applies them before the first paint). */
const prefs = window.shotpilePrefs;

const state = {
  view: "loading", // loading | setup | scanning | months | review | staged
  info: null,
  roots: [],
  rootId: null,
  months: [],
  summary: null,
  thumbs: new Map(), // month -> [path, ...] for the month-row fan
  queue: new ReviewQueue(),
  pass: new PassTally(), // decisions made in the current pass, for the tally and the summary
  history: [], // [{ id, action, prevInPass, pass }] decisions made this session, newest last
  cache: new Map(), // id -> shot
  scope: null, // { scope, month, label }
  card: null, // current shot, null on the end-of-pass summary
  enter: null, // how the next full render brings the top card in
  drag: null,
  pan: null, // active panning gesture on a zoomed card
  dragged: false, // true once the current gesture moved, so its click is not a "click"
  deciding: false, // a decision write is in flight
  busy: false, // a commit is running: decisions and undo wait for it
  scanning: null, // path being scanned; scans never touch decisions, so they block nothing else
  scanFound: 0, // images the running scan has found so far (scan-progress events)
  stagedToken: 0, // guards the async staged view against a stale paint
  libraryScroll: 0, // where the library was scrolled to, restored on return
  showToken: 0, // the latest showCurrent(); an older one must not paint over it
};

// ---------------------------------------------------------------- tauri glue

async function api(cmd, args = {}) {
  log.debug("api", `${cmd} ${JSON.stringify(args)}`);
  try {
    return await invoke(cmd, args);
  } catch (e) {
    log.error("api", `${cmd} failed: ${e}`, args);
    throw e;
  }
}

// Warnings and errors also go to the backend file log, so a release build
// keeps them after the window closes. Called with invoke directly, not api():
// a failing log_write must not log an error that triggers another log_write.
// Rate-limited, so an error in a render loop cannot flood the file.
const forward = { windowStart: 0, sent: 0 };
log.setSink((level, scope, msg) => {
  const now = Date.now();
  if (now - forward.windowStart > 60_000) {
    forward.windowStart = now;
    forward.sent = 0;
  }
  if (++forward.sent > 40) return;
  invoke("log_write", { level, scope, msg }).catch(() => {});
});

window.addEventListener("error", (e) => {
  log.error("window", e.message || "uncaught error", e.error?.stack || `${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  log.error("promise", "unhandled rejection", e.reason?.stack || String(e.reason));
});

function tzArgs() {
  return { rootId: state.rootId ?? null, tz: tzOffsetMinutes() };
}

function currentRoot() {
  return state.roots.find((r) => r.id === state.rootId) || null;
}

async function refreshCounts() {
  state.summary = await api("summary", tzArgs());
  paintCounts();
}

/** The staged badge and the footer bar, from `state.summary`. */
function paintCounts() {
  const s = state.summary || {};
  const staged = s.pile || 0;
  el.stagedBadge.textContent = formatCount(staged);
  el.stagedBtn.hidden = staged === 0 || state.view === "setup" || state.view === "scanning";
  el.stagedBtn.classList.toggle("is-active", state.view === "staged");
  el.stagedN.textContent = countOf(staged, "screenshot");
  el.stagedSize.textContent = s.bytes_pile ? `(${formatBytes(s.bytes_pile)})` : "";
  // The footer bar is always in the layout and expands/collapses with a
  // transition, so showing it never shifts the content above. It stays out of
  // the review: the header badge carries the count there, and a commit button
  // in the middle of a pass invites deleting half-way through.
  el.footbar.classList.toggle("on", staged > 0 && state.view !== "review" && state.view !== "staged");
}

// ----------------------------------------------------------------- data load

async function loadRoots() {
  state.roots = await api("list_roots");
}

async function loadMonths() {
  const [months, summary, thumbs] = await Promise.all([
    api("months", tzArgs()),
    api("summary", tzArgs()),
    api("month_thumbs", { ...tzArgs(), limit: 3 }),
  ]);
  state.months = months;
  state.summary = summary;
  state.thumbs = new Map(thumbs.map((t) => [t.month, t.paths]));
  paintCounts();
}

async function hydrate(ids) {
  const missing = [...new Set(ids)].filter((id) => id !== null && id !== undefined && !state.cache.has(id));
  if (missing.length) {
    const rows = await api("items", { ids: missing });
    for (const row of rows) state.cache.set(row.id, row);
  }
  return ids.map((id) => state.cache.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------- navigation

/** What a click is told while a commit is moving files. */
/** What this OS calls its bin ("Recycle Bin", "Trash") and file manager. */
const binName = () => state.info?.trash_name || "Recycle Bin";
const fileManager = () => state.info?.file_manager || "File Explorer";
const commitRunning = () => `Moving files to the ${binName()}… one moment`;

async function openQueue(scope, month = null, label = "") {
  // A commit holds decisions and undo until it finishes; a review opened now
  // would ignore every key.
  if (state.busy) {
    toast(commitRunning());
    return;
  }
  let ids;
  try {
    ids = await api("queue_ids", { scope, month, ...tzArgs() });
  } catch (e) {
    toast(`Couldn't open that queue: ${e}`, { tone: "error" });
    return;
  }
  if (ids.length === 0) {
    log.info("queue", `${label || scope}: no files`);
    toast(scope === "month" ? `Nothing left to sort in ${label}` : "Nothing to review here");
    return;
  }
  log.info("queue", `${label || scope}: ${ids.length} files`);
  state.cache.clear();
  state.queue = new ReviewQueue(ids);
  state.pass = new PassTally();
  state.scope = { scope, month, label };
  state.view = "review";
  await showCurrent({ enter: "fade" });
}

/**
 * Full render of the review around the queue's current item. Used when a
 * queue opens, after a jump, after an undo, and as the fallback whenever the
 * deck on screen does not match the queue.
 */
async function showCurrent({ enter = "fade" } = {}) {
  const token = ++state.showToken;
  const id = state.queue.current();
  // Until the card being loaded is on screen, the one still showing must not
  // be decided: the cursor already points elsewhere, so a key would record the
  // old card and advance from the new position, skipping a card unseen.
  state.card = null;
  try {
    // The deck and the filmstrip window are hydrated before the first paint,
    // otherwise the deck would show one card until the preload landed.
    await hydrate([id, ...state.queue.upcoming(DECK_DEPTH, 1), ...filmWindowIds()]);
  } catch (e) {
    log.warn("review", `couldn't load card details: ${e}`);
  }
  // A newer jump, undo or render took over while this one was loading.
  if (token !== state.showToken) return;
  state.card = id === null ? null : state.cache.get(id) || null;
  state.enter = enter;
  render();
  if (id !== null) preload();
}

function preload() {
  const next = state.queue.upcoming(4, 1);
  if (next.length) hydrate(next).catch(() => {});
}

function backToMonths() {
  // Leaving a pass mid-review is fine; decisions are already saved.
  closeViewer();
  state.view = "months";
  state.card = null;
  render();
  loadMonths()
    .then(() => state.view === "months" && render())
    .catch((e) => {
      log.error("months", "couldn't load the library", e);
      toast(`Couldn't load the library: ${e}`, { tone: "error" });
    });
}

function openStaged() {
  closeViewer();
  state.view = "staged";
  render();
}

// -------------------------------------------------------------------- render

function render() {
  log.debug("view", state.view);
  // Remember the library's scroll before anything changes, so coming back from
  // a review (or a re-render of the library itself) lands where it was.
  if (document.body.dataset.view === "months") state.libraryScroll = el.view.scrollTop;
  closeMenu();
  document.body.dataset.view = state.view;
  el.view.classList.toggle("reviewing", state.view === "review");
  renderHeader();
  paintCounts();

  switch (state.view) {
    case "loading":
      el.view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "busy" })));
      return;
    case "scanning":
      return renderScanning();
    case "setup":
      return renderSetup();
    case "months":
      return renderLibrary();
    case "review":
      return renderReview();
    case "staged":
      return renderStaged();
    default:
      return undefined;
  }
}

function renderHeader() {
  const v = state.view;
  el.back.hidden = !(v === "review" || v === "staged");
  const root = currentRoot();
  const inFolder = !!root && (v === "months" || v === "review" || v === "staged");
  el.folderBtn.hidden = !inFolder;
  if (root) {
    el.folderName.textContent = basename(root.path) || root.path;
    el.folderBtn.title = `${root.path} — switch folder`;
  }
  el.scan.hidden = !(root && v === "months");
  el.scan.disabled = state.busy || !!state.scanning;
  const scanLabel = state.scanFound ? `Scanning… ${formatCount(state.scanFound)}` : "Scanning…";
  el.scan.replaceChildren(icon("refresh", { size: 16, cls: state.scanning ? "spin" : "" }), state.scanning ? scanLabel : "Rescan");
}

// ---------------------------------------------------------------------- setup

function renderSetup() {
  const hero = h("section", { class: "onboard" },
    h("div", { class: "onboard-mark", html: iconSvg("pile", 40) }),
    h("h1", { text: "Sort a pile of screenshots in minutes" }),
    h("p", { class: "onboard-lead", text: "Point it at the folder your screenshots pile up in. They get grouped by month and dealt out one at a time." }),
    gestureLegend(),
    h("button", { class: "btn primary lg", onclick: addFolder }, icon("folder-plus"), "Choose a folder"),
    h("p", { class: "onboard-fine", text: `Everything stays on this computer. A swipe only marks a file; nothing leaves the disk until you confirm, and then it goes to the ${binName()}.` })
  );
  el.view.replaceChildren(h("div", { class: "page narrow" }, hero));
}

function gestureLegend() {
  const item = (cls, ico, stamp, caption, key) => h("div", { class: `legend-item ${cls}`, role: "listitem" },
    h("div", { class: "legend-card", "aria-hidden": "true" },
      h("span", { class: "mini-stamp" }, icon(ico, { size: 15 }), stamp)),
    h("div", { class: "legend-caption" }, kbd(key), h("span", { text: caption })));
  return h("div", { class: "gesture-legend", role: "list", "aria-label": "How sorting works" },
    item("is-delete", "trash", "Delete", "Swipe left", "←"),
    item("is-skip", "skip", "Skip", "Swipe up", "↑"),
    item("is-keep", "check", "Keep", "Swipe right", "→"));
}

function renderScanning() {
  el.view.replaceChildren(h("div", { class: "empty scanning" },
    h("span", { class: "busy lg" }),
    h("h2", { text: "Looking for screenshots…" }),
    h("p", { class: "muted", text: state.scanning || "" }),
    h("p", { class: "scan-found", id: "scan-found", text: scanFoundText() })));
}

function scanFoundText() {
  return state.scanFound ? `Found ${countOf(state.scanFound, "image")} so far` : "";
}

/** `scan-progress` from the backend: a big first scan should not look frozen. */
function onScanProgress(p) {
  if (!p || p.path !== state.scanning) return;
  state.scanFound = Number(p.found) || 0;
  const node = document.getElementById("scan-found");
  if (node) node.textContent = scanFoundText();
  if (!el.scan.hidden) renderHeader();
}

// -------------------------------------------------------------------- library

const SEG_LABEL = { kept: "kept", staged: "to delete", deleted: "deleted", skipped: "skipped", pending: "unsorted" };

function segbar(stat, size = "") {
  const segs = statusSegments(stat);
  const label = segs.map((s) => `${formatCount(s.n)} ${SEG_LABEL[s.key]}`).join(", ") || "nothing sorted yet";
  return h("div", { class: `segbar${size ? ` ${size}` : ""}`, role: "img", "aria-label": label },
    segs.map((s) => h("i", { class: `seg seg-${s.key}`, style: `width:${(s.ratio * 100).toFixed(2)}%` })));
}

/** The dot-and-count key under a status bar, for the non-zero `keys` of `stat`. */
function legend(stat, keys) {
  return h("ul", { class: "legend" }, keys
    .filter((k) => stat[k])
    .map((k) => h("li", { class: `lg-${k}` }, h("i"), h("b", { text: formatCount(stat[k]) }), ` ${SEG_LABEL[k]}`)));
}

function renderLibrary() {
  const s = state.summary || {};
  if (!state.months.length) {
    el.view.replaceChildren(h("div", { class: "page" }, h("div", { class: "empty" },
      h("div", { class: "empty-glyph" }, icon("image", { size: 26 })),
      h("h2", { text: "No screenshots in this folder" }),
      h("p", { text: "Image files in it and in its subfolders show up here after a scan." }),
      h("div", { class: "row center" },
        h("button", { class: "btn primary", onclick: rescan }, icon("refresh", { size: 16 }), "Scan again"),
        h("button", { class: "btn", onclick: addFolder }, icon("folder-plus", { size: 16 }), "Choose another folder")))));
    return;
  }

  const pending = s.pending || 0;
  const decided = (s.kept || 0) + (s.staged || 0) + (s.deleted || 0) + (s.skipped || 0);

  const facts = [];
  if (s.bytes_pending) facts.push(`${formatBytes(s.bytes_pending)} unsorted`);
  if (s.bytes_deleted) facts.push(`${formatBytes(s.bytes_deleted)} freed so far`);

  const overview = h("section", { class: "overview" },
    h("div", { class: "overview-top" },
      h("div", { class: "overview-title" },
        h("h1", {}, h("span", { class: "num", text: formatCount(s.total) }), ` ${s.total === 1 ? "screenshot" : "screenshots"}`),
        h("p", { class: "overview-sub" }, pending
          ? [h("b", { text: formatCount(pending) }), " left to sort", facts.length ? ` · ${facts.join(" · ")}` : ""]
          : [icon("check-circle", { size: 16, cls: "ok" }), " Everything here is sorted", facts.length ? ` · ${facts.join(" · ")}` : ""])),
      h("div", { class: "overview-actions" },
        h("button", { class: "btn", id: "btn-filter", title: "Filter the month list", onclick: showFilters },
          icon("filter", { size: 16 }), "Filter", prefs.get().showDone ? null : h("span", { class: "btn-dot", "aria-hidden": "true" })),
        pending
          ? h("button", { class: "btn primary lg", id: "btn-sort-all", onclick: () => openQueue("unreviewed", null, "All unsorted") },
              icon("play", { size: 16 }), decided ? "Continue sorting" : "Start sorting", h("span", { class: "btn-count", text: formatCount(pending) }))
          : null,
        pending > 1
          ? h("button", { class: "btn", title: "Review the unsorted screenshots in random order", onclick: () => openQueue("random", null, "Shuffle") }, icon("shuffle", { size: 16 }), "Shuffle")
          : null,
        s.skipped
          ? h("button", { class: "btn", title: "Review the screenshots you skipped", onclick: () => openQueue("skipped", null, "Skipped") }, icon("skip", { size: 16 }), "Skipped", h("span", { class: "btn-count", text: formatCount(s.skipped) }))
          : null)),
    segbar(s, "lg"),
    legend({ ...s, pending }, ["kept", "staged", "deleted", "skipped", "pending"]));

  const showDone = prefs.get().showDone;
  const shown = showDone ? state.months : state.months.filter((m) => !progressOf(m).done);
  const hidden = state.months.length - shown.length;
  const years = groupByYear(shown).map((g) => h("section", { class: "year" },
    h("h2", { class: "section-label", text: g.year }),
    h("div", { class: "months" }, g.months.map(monthRow))));
  const hiddenNote = hidden
    ? h("p", { class: "filter-note" },
        `${countOf(hidden, "sorted month")} hidden. `,
        h("button", { class: "linklike", onclick: showFilters }, "Change filter"))
    : null;

  el.view.replaceChildren(h("div", { class: "page" }, overview, years, hiddenNote));
  el.view.scrollTop = state.libraryScroll;
}

function monthRow(m) {
  const p = progressOf(m);
  const thumbs = (state.thumbs.get(m.month) || []).slice(0, 3);
  const parts = [];
  if (p.kept) parts.push(`${formatCount(p.kept)} kept`);
  if (p.staged) parts.push(`${formatCount(p.staged)} to delete`);
  if (p.deleted) parts.push(`${formatCount(p.deleted)} deleted`);
  if (p.skipped) parts.push(`${formatCount(p.skipped)} skipped`);
  const label = monthLabel(m.month);

  return h("button", {
    class: `month${p.done ? " is-done" : ""}`,
    dataset: { month: m.month },
    "aria-label": `${label}: ${countOf(p.total, "screenshot")}, ${p.done ? "sorted" : `${formatCount(p.remaining)} left`}`,
    onclick: () => (p.done ? openQueue("kept", m.month, `Kept from ${label}`) : openQueue("month", m.month, label)),
  },
    h("span", { class: `fan n${thumbs.length}` },
      thumbs.length
        ? thumbs.map((path, i) => h("img", { src: convertFileSrc(path), alt: "", loading: "lazy", decoding: "async", draggable: "false", style: `--i:${i}` }))
        : icon("image", { size: 20 })),
    h("span", { class: "month-main" },
      h("span", { class: "month-title" },
        h("span", { class: "label", text: monthLabel(m.month, { year: false }) }),
        h("span", { class: "counts", text: countOf(p.total, "screenshot") })),
      segbar(m),
      h("span", { class: "month-meta", text: parts.join(" · ") || "Not started" })),
    h("span", { class: "month-side" },
      p.done
        ? h("span", { class: "done-tag" }, icon("check-circle", { size: 16 }), "Sorted")
        : h("span", { class: "left-tag" }, h("b", { text: formatCount(p.remaining) }), " left"),
      icon("chevron-right", { size: 18, cls: "month-go" })));
}

// --------------------------------------------------------------------- review

/** Upcoming cards painted behind the top one, and their resting offsets. */
const DECK_DEPTH = 2;
const DECK_SLOTS = [{ dy: 0, scale: 1 }, { dy: 22, scale: 0.95 }, { dy: 44, scale: 0.9 }];
const ENTER_CLASSES = ["enter-fade", "enter-from-left", "enter-from-right", "enter-from-top"];
const FILM_BEFORE = 5;
const FILM_AFTER = 9;

/** Exit animation length; keep in step with `.card.leaving` in style.css. */
const EXIT_MS = 320;

// RGB triples for the three outcomes: the card tint, the info bar and stamps.
const DRAG_RGB = {
  [ACTION.DELETE]: "220,38,38",
  [ACTION.KEEP]: "21,128,61",
  [ACTION.SKIP]: "180,83,9",
};

// How far a card shrinks at full drag, and over what distance. Driven by the
// raw pointer distance rather than the clamped gesture progress, so dragging
// further keeps shrinking instead of stopping dead at the threshold.
const SHRINK_MAX = 0.3;
const SHRINK_REACH = GESTURE_THRESHOLD * 2.6;

const topCard = () => document.querySelector("#stage .deck .card.deck-top:not(.leaving)");
const deckEl = () => document.querySelector("#stage .deck");

function filmWindowIds() {
  const ids = state.queue.ids;
  if (!ids.length) return [];
  const cursor = Math.min(state.queue.cursor, ids.length - 1);
  return ids.slice(Math.max(0, cursor - FILM_BEFORE), Math.min(ids.length, cursor + FILM_AFTER + 1));
}

function renderReview() {
  // A full render replaces every card, so a gesture in progress has lost its
  // card; a stale drag would otherwise keep blocking the decision keys.
  state.drag = null;
  state.pan = null;
  if (!state.card) return renderFinale();

  const stage = h("div", { class: "stage", id: "stage" }, buildDeck());
  const review = h("div", { class: "review", dataset: { scope: state.scope?.scope || "" } },
    reviewHead(),
    stage,
    reviewActions(),
    h("div", { class: "filmstrip-wrapper" },
      h("div", { class: "filmstrip-handle", id: "filmstrip-handle" }),
      h("div", { class: "filmstrip", id: "filmstrip", role: "group", "aria-label": "Queue" })));
  el.view.replaceChildren(review);
  review.style.setProperty("--filmstrip-height", `${prefs.get().filmstripHeight}px`);
  wireStage(stage);
  wireFilmstripResize(document.getElementById("filmstrip-handle"));
  renderReviewChrome();
  paintZoomReadout(1);

  const top = topCard();
  const enter = state.enter;
  state.enter = null;
  if (top && enter) playEnter(top, enter);
}

function playEnter(card, enter) {
  const cls = `enter-${enter}`;
  if (!ENTER_CLASSES.includes(cls)) return;
  card.classList.add(cls);
  const done = () => card.classList.remove(cls);
  card.addEventListener("animationend", done, { once: true });
  // In case the animation never fires (reduced motion, a hidden window), the
  // card must not keep a class that overrides the drag's inline position.
  setTimeout(done, 700);
}

function reviewHead() {
  const c = state.pass.counts();
  const chip = (action, ico, n, title) =>
    h("span", { class: `tally-chip t-${action}`, dataset: { action }, title }, icon(ico, { size: 14 }), h("b", { text: formatCount(n) }));
  return h("div", { class: "review-head", id: "review-head" },
    h("div", { class: "review-title" },
      h("span", { class: "review-label", text: state.scope?.label || "" }),
      h("span", { class: "review-pos", id: "review-pos" }),
      h("span", { class: "zoom-readout", id: "zoom-readout", text: "100%" })),
    h("div", { class: "tally", role: "group", "aria-label": "Decided in this pass" },
      chip(ACTION.KEEP, "check", c.keep, "Kept in this pass"),
      chip(ACTION.DELETE, "trash", c.delete, "Marked for deletion in this pass"),
      chip(ACTION.SKIP, "skip", c.skip, "Skipped in this pass")),
    h("div", { class: "review-bar", "aria-hidden": "true" }, h("i", { id: "review-bar" })));
}

function reviewActions() {
  const btn = (action, cls, ico, label, key, title) => h("button", {
    class: `act ${cls}`,
    dataset: { action },
    title,
    onclick: () => decide(action, { via: "button" }),
  }, icon(ico, { size: 18 }), h("span", { class: "act-label", text: label }), kbd(key));
  return h("div", { class: "actions", id: "review-actions" },
    btn(ACTION.DELETE, "act-delete", "trash", "Delete", "←", "Mark for deletion (←)"),
    state.scope?.scope === "staged" ? null : btn(ACTION.SKIP, "act-skip", "skip", "Skip", "↑", "Skip for now; it comes back once at the end (↑)"),
    btn(ACTION.KEEP, "act-keep", "check", "Keep", "→", "Keep (→)"),
    h("button", { class: "act act-undo", title: "Undo the last decision (Z)", "aria-label": "Undo", onclick: () => undo() },
      icon("undo", { size: 18 }), kbd("Z")));
}

/**
 * Updates the chrome around the deck (position, tally, progress, filmstrip) in
 * place. The stage and its cards are left alone: the advance has to stay one
 * continuous motion, and rebuilding the deck is what used to make it flicker.
 */
function renderReviewChrome(bumped = null) {
  const q = state.queue;
  const pos = document.getElementById("review-pos");
  if (!pos) return;
  pos.textContent = `${formatCount(q.position())} of ${formatCount(q.length)}`;
  const bar = document.getElementById("review-bar");
  if (bar) bar.style.width = `${q.length ? (Math.min(q.cursor, q.length) / q.length) * 100 : 0}%`;
  const c = state.pass.counts();
  for (const chip of document.querySelectorAll(".tally-chip")) {
    const n = { keep: c.keep, delete: c.delete, skip: c.skip }[chip.dataset.action];
    chip.querySelector("b").textContent = formatCount(n);
    chip.classList.toggle("zero", !n);
    if (chip.dataset.action === bumped) replay(chip, "bump");
  }
  paintFilmstrip();
}

function paintZoomReadout(scale) {
  const node = document.getElementById("zoom-readout");
  if (!node) return;
  node.textContent = `${Math.round(scale * 100)}%`;
  node.classList.toggle("on", scale > 1.001);
}

/**
 * The queue around the cursor: recent decisions, the current card, and what is
 * next. Clicking an item jumps to it, so a pass can be walked back without
 * undoing everything.
 */
function paintFilmstrip() {
  const strip = document.getElementById("filmstrip");
  if (!strip) return;
  const q = state.queue;
  const ids = q.ids;
  if (!ids.length) {
    strip.replaceChildren();
    return;
  }
  const cursor = Math.min(q.cursor, ids.length - 1);
  const start = Math.max(0, cursor - FILM_BEFORE);
  const end = Math.min(ids.length, cursor + FILM_AFTER + 1);
  const missing = [];
  const items = [];
  for (let i = start; i < end; i++) {
    const shot = state.cache.get(ids[i]);
    if (!shot) missing.push(ids[i]);
    const status = shot?.status || "pending";
    const current = i === q.cursor;
    items.push(h("button", {
      class: `film-item${current ? " current" : ""}`,
      dataset: { status, index: String(i), id: String(ids[i]) },
      title: shot ? `${shot.name}${status !== "pending" ? ` — ${STATUS_LABEL[status] || status}` : ""}` : `#${ids[i]}`,
      "aria-current": current ? "true" : null,
      onclick: () => jumpTo(i),
    },
      h("span", { class: "film-thumb" },
        shot?.viewable && !shot.missing
          ? h("img", { src: convertFileSrc(shot.path), alt: "", loading: "lazy", decoding: "async", draggable: "false" })
          : h("span", { class: "film-ext", text: shot ? shot.ext.toUpperCase() : "" })),
      h("span", { class: "film-mark", "aria-hidden": "true" })));
  }
  strip.replaceChildren(...items);
  strip.dataset.start = String(start);
  if (missing.length) {
    hydrate(missing).then(() => {
      if (state.view === "review" && missing.some((id) => state.cache.has(id))) paintFilmstrip();
    }).catch(() => {});
  }
}

const STATUS_LABEL = { kept: "kept", staged: "marked for deletion", skipped: "skipped", deleted: "deleted", pending: "not sorted" };

function jumpTo(index) {
  if (state.view !== "review" || state.deciding || state.busy) return;
  if (index < 0 || index >= state.queue.ids.length || index === state.queue.cursor) return;
  state.queue.cursor = index;
  showCurrent({ enter: "fade" });
}

// ------------------------------------------------------------------------ deck

/**
 * The review deck: the current card on top, the next couple peeking out below
 * so a decision always has somewhere to land.
 *
 * Every card sits in a slot (`.deck-top`, `.deck-1`, `.deck-2`) whose offset
 * comes from `--deck-dy` / `--deck-scale` through `transform`. The drag moves
 * the top card with the individual `translate` / `rotate` / `scale`
 * properties, which compose with that transform instead of replacing it, so
 * no inline style ever has to restate the slot position.
 */
function buildDeck() {
  const deck = h("div", { class: "deck" });
  const ids = [state.card.id, ...state.queue.upcoming(DECK_DEPTH, 1)];
  for (let slot = ids.length - 1; slot >= 0; slot--) {
    const shot = slot === 0 ? state.card : state.cache.get(ids[slot]);
    if (shot) deck.append(cardNode(shot, slot));
  }
  return deck;
}

function setSlot(node, slot) {
  node.classList.remove("deck-top", "deck-1", "deck-2", "deck-card");
  node.style.removeProperty("--deck-dy");
  node.style.removeProperty("--deck-scale");
  if (slot === 0) {
    node.classList.add("deck-top");
    node.id = "card";
    node.removeAttribute("aria-hidden");
  } else {
    node.classList.add("deck-card", `deck-${slot}`);
    node.removeAttribute("id");
    node.setAttribute("aria-hidden", "true");
  }
}

function placeholder(title, detail) {
  return h("div", { class: "noimg" },
    icon("image", { size: 28 }),
    h("div", { class: "noimg-title", text: title }),
    h("div", { class: "noimg-detail", text: detail }));
}

function photo(shot) {
  if (!shot.viewable) {
    return placeholder(`No preview for .${shot.ext.toLowerCase()} files`, "The app can't render this format. Decide from the name, date and size.");
  }
  if (shot.missing) {
    return placeholder("File not found", "It was moved or deleted outside Shotpile since the last scan.");
  }
  const img = h("img", { src: convertFileSrc(shot.path), alt: shot.name, draggable: "false", decoding: "async" });
  img.addEventListener("error", () => {
    log.warn("card", `couldn't load ${shot.path}`);
    img.replaceWith(placeholder("Couldn't load this image", "The file may be damaged, or it changed since the last scan."));
  }, { once: true });
  return img;
}

function cardNode(shot, slot) {
  const when = h("span", {
    text: formatDateTime(shot.taken_ms),
    // The date-source diagnostic lives in the tooltip: it was noise on every card.
    title: `Date ${DATE_SOURCE_LABELS[shot.date_source] || shot.date_source}`,
  });
  const node = h("div", { class: "card", dataset: { id: String(shot.id) } },
    // Under the photo (z 1 vs 2), so the card and its letterbox change colour
    // while the screenshot itself stays untinted.
    h("div", { class: "tint" }),
    h("div", { class: "stamp left" }, icon("trash", { size: 18 }), "Delete"),
    h("div", { class: "stamp right" }, icon("check", { size: 18 }), "Keep"),
    h("div", { class: "stamp up" }, icon("skip", { size: 18 }), "Skip"),
    h("div", { class: "imgwrap" }, photo(shot)),
    h("div", { class: "foot" },
      // The name ellipsizes to keep the info bar one line; the full text is in
      // the tooltip.
      h("div", { class: "fname", text: shot.name, title: shot.name }),
      h("div", { class: "fmeta" },
        when,
        h("span", { text: formatBytes(shot.size) }),
        h("span", { text: shot.ext.toUpperCase() }),
        shot.missing ? h("span", { class: "missing", text: "missing on disk" }) : null)));
  setSlot(node, slot);
  return node;
}

/**
 * Advances the review by one card without rebuilding the deck.
 *
 * The card waiting in slot 1 becomes the top card and slot 2 moves up; both
 * glide there through the slot transition (a swipe has usually carried them
 * most of the way already). A fresh card fades in at the back. Falls back to a
 * full `showCurrent()` whenever the deck does not hold the expected card, so a
 * stale deck can never show the wrong file.
 */
function promoteDeck(bumped) {
  const deck = deckEl();
  const id = state.queue.current();
  const shot = id === null ? null : state.cache.get(id);
  const incoming = deck?.querySelector(".deck-1:not(.leaving)");
  if (!deck || !shot || !incoming || incoming.dataset.id !== String(id)) {
    showCurrent({ enter: "fade" });
    return;
  }

  state.card = shot;
  deck.classList.remove("stacking");
  // Inert for a frame, so the tail of a click aimed at the card that just left
  // cannot land on the one taking its place.
  deck.classList.add("inert");
  const second = deck.querySelector(".deck-2:not(.leaving)");
  setSlot(incoming, 0);
  if (second) setSlot(second, 1);
  fillDeckTail(deck);

  renderReviewChrome(bumped);
  paintZoomReadout(1);
  requestAnimationFrame(() => requestAnimationFrame(() => deck.classList.remove("inert")));
  preload();
}

/** Adds any upcoming card the deck is missing, behind the others. */
function fillDeckTail(deck) {
  const want = state.queue.upcoming(DECK_DEPTH, 1);
  want.forEach((id, i) => {
    const slot = i + 1;
    const present = () => deck.querySelector(`.card[data-id="${id}"]:not(.leaving)`);
    if (present()) return;
    const add = (shot) => {
      // The queue may have moved on while the row was loading.
      if (!shot || !deck.isConnected || present() || state.queue.upcoming(DECK_DEPTH, 1)[i] !== id) return;
      const node = cardNode(shot, slot);
      node.classList.add("arriving");
      deck.prepend(node);
    };
    const cached = state.cache.get(id);
    if (cached) add(cached);
    else hydrate([id]).then(([s]) => add(s)).catch(() => {});
  });
}

/** Glides the cards behind the top one back to their slots. */
function resetStack() {
  const deck = deckEl();
  if (!deck) return;
  deck.classList.remove("stacking");
  for (const n of deck.querySelectorAll(".deck-card")) {
    n.style.removeProperty("--deck-dy");
    n.style.removeProperty("--deck-scale");
  }
}

/**
 * Colours a card for an outcome: the tint layer, the info bar (in the same
 * fading-scrim shape as its resting gradient, so it never reads as a slab) and
 * the matching stamp. `progress` 0 clears everything.
 */
function paintIntent(card, action, progress) {
  const col = DRAG_RGB[action];
  const on = !!col && progress > 0;
  card.classList.toggle("tinted", on);
  const tint = card.querySelector(".tint");
  if (tint) {
    tint.style.background = on ? `rgb(${col})` : "";
    tint.style.opacity = on ? String(progress * 0.3) : "0";
  }
  const foot = card.querySelector(".foot");
  if (foot) {
    foot.style.background = on
      ? `linear-gradient(to top, rgba(${col},${0.2 + progress * 0.45}) 0%, rgba(${col},${progress * 0.18}) 58%, rgba(${col},0) 100%)`
      : "";
  }
  const stamps = { [ACTION.DELETE]: ".stamp.left", [ACTION.KEEP]: ".stamp.right", [ACTION.SKIP]: ".stamp.up" };
  for (const [a, sel] of Object.entries(stamps)) {
    const s = card.querySelector(sel);
    if (s) s.style.opacity = on && a === action ? String(0.45 + progress * 0.55) : "0";
  }
  // Re-arming restarts the stamp's pop animation (see `[data-armed]` in CSS).
  card.dataset.armed = on ? action : "";
}

function clearDrag(card) {
  card.classList.remove("dragging");
  paintIntent(card, null, 0);
}

/** Sends a released-but-undecided card back to rest. */
function settle(card) {
  clearDrag(card);
  card.classList.add("settling");
  card.style.translate = "";
  card.style.rotate = "";
  card.style.scale = "";
  setTimeout(() => card.classList.remove("settling"), 360);
}

/**
 * Throws the top card off the deck in the direction of `action`. It stops being
 * the top card at once (so input goes to the next one) and removes itself when
 * the animation ends. A swipe continues from wherever the drag left it.
 */
function flyOut(card, action, from = null) {
  card.classList.add("leaving");
  card.classList.remove("deck-top", "dragging", ...ENTER_CLASSES);
  card.removeAttribute("id");
  card.setAttribute("aria-hidden", "true");
  paintIntent(card, action, 1);

  const v = exitVector(action, Math.max(900, window.innerWidth));
  const x = action === ACTION.SKIP ? (from?.dx || 0) : v.x;
  const y = action === ACTION.SKIP ? v.y : (from?.dy || 0) + v.y;
  const tilt = action === ACTION.SKIP ? 0 : Math.sign(v.x) * 16;
  // Commit the starting position, so the exit animates from it.
  void card.offsetWidth;
  card.style.translate = `${x}px ${y}px`;
  card.style.rotate = `${tilt}deg`;
  card.style.scale = "0.72";
  card.style.opacity = "0";
  const remove = () => card.remove();
  card.addEventListener("transitionend", (e) => {
    if (e.target === card && e.propertyName === "opacity") remove();
  });
  setTimeout(remove, EXIT_MS + 250);
}

/**
 * Speaks a short status line to screen readers: the card swap itself is
 * silent, so without this a decision gave no feedback at all.
 */
function announce(text) {
  const node = document.getElementById("sr-status");
  if (node) node.textContent = text;
}

const SPOKEN = { [ACTION.KEEP]: "Kept", [ACTION.DELETE]: "Marked for deletion", [ACTION.SKIP]: "Skipped" };

/** Lights the on-screen button for a keyboard decision, so it reads as pressed. */
function flashAction(action) {
  replay(document.querySelector(`.act[data-action="${action}"]`), "flash", 260);
}

/**
 * A small copy of the photo arcs into the "To delete" badge, which bumps: the
 * file did not vanish, it went onto a pile you can still open.
 */
function flyToPile(card) {
  const target = el.stagedBtn;
  const img = card?.querySelector(".imgwrap img");
  if (!img || !target || reducedMotion()) return;
  target.hidden = false;
  const from = img.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return;
  const w = Math.min(140, from.width);
  const hgt = w * 0.66;
  const x0 = from.left + from.width / 2 - w / 2;
  const y0 = from.top + from.height / 2 - hgt / 2;
  const dx = to.left + to.width / 2 - (x0 + w / 2);
  const dy = to.top + to.height / 2 - (y0 + hgt / 2);
  const ghost = h("img", { class: "pile-ghost", src: img.currentSrc || img.src, alt: "", "aria-hidden": "true" });
  ghost.style.cssText = `left:${x0}px;top:${y0}px;width:${w}px;height:${hgt}px`;
  document.body.append(ghost);
  const anim = ghost.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 0.95 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.55 - 60}px) scale(.6)`, opacity: 0.9, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.14)`, opacity: 0.2 },
  ], { duration: 560, easing: "cubic-bezier(.45,0,.2,1)" });
  anim.finished
    .then(() => replay(target, "bump", 450))
    .catch(() => {})
    .finally(() => ghost.remove());
}

// --------------------------------------------------------------- card zoom

/**
 * In-card zoom: the wheel zooms the card's own image around the cursor without
 * opening the viewer. Past ZOOM_PAN_THRESHOLD a drag pans the zoomed image
 * instead of swiping, so the user cannot decide a photo they are inspecting.
 *
 * The controller lives on the card node, so it follows the card through a
 * promotion with nothing to re-wire. Null for a card without a photo, which
 * the gesture code treats as "always swipe".
 */
function zoomOf(card) {
  if (!card) return null;
  if (card.__zoom) return card.__zoom;
  const imgwrap = card.querySelector(".imgwrap");
  const img = imgwrap?.querySelector("img");
  if (!img) return null;
  const zoom = { scale: 1, x: 0, y: 0 };

  const apply = () => {
    img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    card.classList.toggle("zoomed", zoom.scale > 1.001);
    card.classList.toggle("pannable", zoom.scale >= ZOOM_PAN_THRESHOLD);
    if (card.classList.contains("deck-top")) paintZoomReadout(zoom.scale);
  };
  const measure = () => {
    const r = imgwrap.getBoundingClientRect();
    return { r, ...containedSize(img.naturalWidth, img.naturalHeight, r.width, r.height) };
  };
  const clampPan = () => {
    if (zoom.scale <= 1.001) {
      zoom.x = 0;
      zoom.y = 0;
      return;
    }
    const m = measure();
    const mx = panLimit(m.w, m.r.width, zoom.scale);
    const my = panLimit(m.h, m.r.height, zoom.scale);
    zoom.x = Math.min(mx, Math.max(-mx, zoom.x));
    zoom.y = Math.min(my, Math.max(-my, zoom.y));
  };
  const zoomBy = (factor, cx = null, cy = null) => {
    const next = clampScale(zoom.scale, factor);
    if (next === zoom.scale) return;
    const r = imgwrap.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const pos = anchorZoom((cx ?? ox) - ox, (cy ?? oy) - oy, zoom.x, zoom.y, next, zoom.scale);
    zoom.x = pos.x;
    zoom.y = pos.y;
    zoom.scale = next;
    clampPan();
    apply();
  };
  const reset = () => {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    apply();
  };
  /** The pan as a fraction of the photo, which is what the viewer needs. */
  const share = () => {
    const m = measure();
    return { scale: zoom.scale, fx: m.w ? zoom.x / m.w : 0, fy: m.h ? zoom.y / m.h : 0 };
  };

  card.__zoom = { zoom, apply, clampPan, zoomBy, reset, share, panning: () => zoom.scale >= ZOOM_PAN_THRESHOLD };
  return card.__zoom;
}

function openShotViewer(shot, card = null) {
  if (!shot?.viewable || shot.missing) return;
  openViewer(shot, { src: convertFileSrc(shot.path), inherit: zoomOf(card)?.share() || null });
}

// -------------------------------------------------------------------- gestures

/**
 * Pointer capture is only an optimisation: it lets a drag continue past the
 * card edge. It throws NotFoundError when the pointer is already gone, which
 * happens with synthetic events and after a capture is lost, and that must not
 * abort the gesture.
 */
function capture(node, pointerId) {
  try {
    node.setPointerCapture?.(pointerId);
  } catch {
    /* non-fatal: the drag still tracks as long as the pointer stays inside */
  }
}

/**
 * Gesture handlers are delegated from the stage and resolve the top card when
 * each event arrives. They used to be bound per render with the top card
 * captured in a closure, so after the first promotion every drag moved a
 * detached node: the visible card sat still and the decision landed blind.
 */
function wireStage(stage) {
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerCancel);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("gesturestart", onPinchStart);
  stage.addEventListener("gesturechange", onPinchChange);
  stage.addEventListener("dblclick", onDoubleClick);
  stage.addEventListener("click", onCardClick);
  stage.addEventListener("dragstart", (e) => e.preventDefault());
}

function wireFilmstripResize(handle) {
  if (!handle) return;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startY = e.clientY;
    startHeight = prefs.get().filmstripHeight;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (startHeight === 0) return;
    const delta = e.clientY - startY;
    // Resize filmstrip down when moving down, giving the deck less space
    const newHeight = startHeight - delta;
    const clamped = Math.max(40, Math.min(300, newHeight));
    const review = document.querySelector(".review");
    if (review) {
      review.style.setProperty("--filmstrip-height", `${clamped}px`);
    }
  });

  handle.addEventListener("pointerup", (e) => {
    if (startHeight === 0) return;
    const delta = e.clientY - startY;
    const newHeight = startHeight - delta;
    const clamped = Math.max(40, Math.min(300, newHeight));
    prefs.set({ filmstripHeight: clamped });
    startHeight = 0;
  });

  handle.addEventListener("pointercancel", () => {
    if (startHeight === 0) return;
    // Restore to saved preference on cancel
    const review = document.querySelector(".review");
    if (review) {
      review.style.setProperty("--filmstrip-height", `${prefs.get().filmstripHeight}px`);
    }
    startHeight = 0;
  });
}

function onPointerDown(e) {
  if (e.button !== 0 || state.busy || state.deciding || !state.card) return;
  const card = topCard();
  if (!card || !card.contains(e.target)) return;
  state.dragged = false;
  // An entry animation overrides inline styles, so it would freeze the drag.
  card.classList.remove(...ENTER_CLASSES);

  const zoom = zoomOf(card);
  if (zoom?.panning()) {
    state.pan = { id: e.pointerId, px: e.clientX, py: e.clientY, ox: zoom.zoom.x, oy: zoom.zoom.y, zoom };
    capture(card, e.pointerId);
    return;
  }
  const r = card.getBoundingClientRect();
  state.drag = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    dx: 0,
    dy: 0,
    card,
    low: e.clientY > r.top + r.height / 2,
    behind: [...document.querySelectorAll("#stage .deck .deck-card:not(.leaving)")],
  };
  // The deck tracks the pointer directly, so its transition is suppressed
  // until the gesture ends and it can glide instead.
  deckEl()?.classList.add("stacking");
  capture(card, e.pointerId);
}

function onPointerMove(e) {
  const p = state.pan;
  if (p && p.id === e.pointerId) {
    p.zoom.zoom.x = p.ox + (e.clientX - p.px);
    p.zoom.zoom.y = p.oy + (e.clientY - p.py);
    // Clamped on every move, or the photo could be dragged clean off the card.
    p.zoom.clampPan();
    if (Math.abs(e.clientX - p.px) > 4 || Math.abs(e.clientY - p.py) > 4) state.dragged = true;
    p.zoom.apply();
    return;
  }

  const d = state.drag;
  if (!d || d.id !== e.pointerId) return;
  // The card can stop being the top card under the pointer (an undo or a
  // jump re-rendered the deck); then there is nothing left to move.
  if (d.card !== topCard()) return;
  d.dx = e.clientX - d.x;
  d.dy = e.clientY - d.y;
  if (Math.abs(d.dx) > 6 || Math.abs(d.dy) > 6) state.dragged = true;

  const v = gestureVisual(d.dx, d.dy, GESTURE_THRESHOLD);
  const dist = Math.hypot(d.dx, d.dy);
  const shrink = 1 - Math.min(SHRINK_MAX, (dist / SHRINK_REACH) * SHRINK_MAX);
  const card = d.card;
  card.classList.add("dragging");
  card.style.translate = `${d.dx}px ${d.dy}px`;
  card.style.rotate = `${dragTilt(d.dx, d.low)}deg`;
  card.style.scale = String(shrink);
  // Paint while a decision is implied, and once more to clear it on the way back.
  if (v.action || card.dataset.armed) paintIntent(card, v.action, v.progress);

  // The deck glides forward as the top card recedes, so the card that will
  // replace it is already in place instead of snapping there.
  const t = 1 - v.progress;
  d.behind.forEach((node) => {
    const slot = node.classList.contains("deck-1") ? 1 : 2;
    node.style.setProperty("--deck-dy", `${DECK_SLOTS[slot].dy * t}px`);
    node.style.setProperty("--deck-scale", String(1 + (DECK_SLOTS[slot].scale - 1) * t));
  });
}

function onPointerUp(e) {
  if (state.pan && state.pan.id === e.pointerId) {
    state.pan = null;
    return;
  }
  const d = state.drag;
  if (!d || d.id !== e.pointerId) return;
  state.drag = null;
  // Only the card the drag started on may be decided by it. If it was decided
  // or replaced meanwhile, releasing must not decide whatever card is on top
  // now.
  if (d.card !== topCard()) {
    resetStack();
    return;
  }
  const action = classifyGesture(d.dx, d.dy, GESTURE_THRESHOLD);
  if (!action) {
    settle(d.card);
    resetStack();
    return;
  }
  decide(action, { via: "swipe", from: { dx: d.dx, dy: d.dy } }).then((done) => {
    // Refused (a scan or a commit started): put the card back instead of
    // leaving it hanging where the drag let go.
    if (!done && d.card.isConnected && !d.card.classList.contains("leaving")) {
      settle(d.card);
      resetStack();
    }
  });
}

function onPointerCancel() {
  const d = state.drag;
  state.drag = null;
  state.pan = null;
  if (d) {
    settle(d.card);
    state.dragged = false;
  }
  resetStack();
}

function onWheel(e) {
  const card = topCard();
  if (!card || !card.querySelector(".imgwrap")?.contains(e.target)) return;
  const zoom = zoomOf(card);
  if (!zoom) return;
  e.preventDefault();
  zoom.zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX, e.clientY);
}

// WKWebView reports a touchpad pinch as gesture events, not ctrl+wheel.
function onPinchStart(e) {
  const zoom = zoomOf(topCard());
  if (!zoom) return;
  e.preventDefault();
  zoom.pinchBase = zoom.zoom.scale;
}

function onPinchChange(e) {
  const zoom = zoomOf(topCard());
  if (!zoom) return;
  e.preventDefault();
  zoom.zoomBy((zoom.pinchBase * e.scale) / zoom.zoom.scale, e.clientX, e.clientY);
}

function onDoubleClick(e) {
  const card = topCard();
  if (!card || !card.querySelector(".imgwrap")?.contains(e.target)) return;
  const zoom = zoomOf(card);
  if (!zoom) return;
  e.preventDefault();
  if (zoom.zoom.scale > 1) zoom.reset();
  else zoom.zoomBy(2, e.clientX, e.clientY);
}

function onCardClick(e) {
  const card = topCard();
  if (!card || !card.contains(e.target) || state.dragged) return;
  // A double-click is two clicks; the first must not open the viewer before
  // the second can zoom. Wait out the double-click interval.
  clearTimeout(onCardClick.timer);
  if (e.detail > 1) return;
  onCardClick.timer = setTimeout(() => {
    if (topCard() === card && !state.dragged) openShotViewer(state.card, card);
  }, 230);
}

// --------------------------------------------------------------------- decide

/**
 * Records a decision for the current card.
 *
 * The card leaves at once and the write runs underneath it. The deck is only
 * promoted once the write lands, so a failed write can put everything back: the
 * queue and the pass tally are restored and the card is rendered again.
 */
async function decide(action, { via = "key", from = null, saved = null } = {}) {
  if (state.view !== "review" || !state.card || state.deciding || state.busy) return false;
  // Checking the deletion pile is keep-or-delete: a skip would write
  // "skipped" and silently take the file off the pile.
  if (action === ACTION.SKIP && state.scope?.scope === "staged") return false;
  const shot = state.card;
  const card = topCard();
  const before = state.queue.snapshot();
  const prevInPass = state.pass.record(shot.id, action, shot.size);
  if (action === ACTION.SKIP) state.queue.deferCurrent();
  else state.queue.advance();

  state.deciding = true;
  if (via !== "swipe") flashAction(action);
  if (card) flyOut(card, action, from);

  let updated;
  try {
    // A redo has already written the decision; only the card has to move.
    updated = saved || (await api("decide", { id: shot.id, kind: action }));
  } catch (e) {
    state.deciding = false;
    state.queue.restore(before);
    state.pass.revert(shot.id, prevInPass);
    log.error("decide", `${action} ${shot.name} could not be saved`, e);
    toast(`Couldn't save that decision: ${e}`, { tone: "error" });
    state.card = shot;
    state.enter = "fade";
    render();
    return false;
  }
  state.cache.set(updated.id, updated);
  state.history.push({ id: shot.id, action, prevInPass, pass: state.pass });
  if (state.history.length > 500) state.history.shift();
  log.info("decide", `${action} -> ${updated.name} (${updated.status})`);

  if (action === ACTION.DELETE) flyToPile(card);
  // The badge follows anything that adds to or takes from the pile. The
  // decision is saved; a failed counter refresh must not undo it.
  if (action === ACTION.DELETE || state.scope?.scope === "staged") {
    refreshCounts().catch((e) => log.warn("decide", `couldn't refresh counts: ${e}`));
  }

  if (state.queue.atEnd()) {
    // Nothing is left to decide. Clear the card now and stay `deciding` while
    // the last card finishes leaving: a key pressed during the exit used to
    // land on the card that was just decided and decide it a second time.
    state.card = null;
    // Undo stays possible during the exit; finishPass() leaves the summary out
    // if an undo brought a card back meanwhile.
    state.deciding = false;
    announce(`${SPOKEN[action]}: ${shot.name}. That was the last one.`);
    await wait(EXIT_MS);
    if (state.view === "review" && state.queue.atEnd()) await finishPass();
  } else {
    state.deciding = false;
    promoteDeck(action);
    if (state.card) announce(`${SPOKEN[action]}: ${shot.name}. Next, ${state.queue.position()} of ${state.queue.length}: ${state.card.name}`);
  }
  return true;
}

async function finishPass() {
  try {
    await loadMonths();
  } catch (e) {
    log.warn("review", `couldn't refresh months after the pass: ${e}`);
  }
  // An undo while the months were loading brought a card back; leave it.
  if (state.view === "review" && state.queue.atEnd()) {
    state.card = null;
    render();
  }
}

/** Where an undone card comes back from: the side it left through. */
const RETURN_FROM = {
  [ACTION.DELETE]: "from-left",
  [ACTION.KEEP]: "from-right",
  [ACTION.SKIP]: "from-top",
};

function takeHistory(id) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].id === id) return state.history.splice(i, 1)[0];
  }
  return null;
}

async function undo() {
  if (state.deciding || state.busy) return;
  let shot;
  try {
    shot = await api("undo_last");
  } catch (e) {
    log.error("undo", "couldn't undo", e);
    toast(`Couldn't undo: ${e}`, { tone: "error" });
    return;
  }
  if (!shot) {
    toast("Nothing to undo");
    return;
  }
  state.cache.set(shot.id, shot);
  const entry = takeHistory(shot.id);
  if (entry && entry.pass === state.pass && entry.action !== "unstage") state.pass.revert(shot.id, entry.prevInPass);
  log.info("undo", shot.name);

  try {
    if (state.view === "review") {
      // Seek by id, not by stepping the cursor back: a skip was deferred to the
      // back of the queue. An id from another queue (the undo stack is
      // session-wide) is not injected into this one.
      if (state.queue.focusId(shot.id) !== null) {
        await showCurrent({ enter: RETURN_FROM[entry?.action] || "fade" });
      } else {
        log.info("undo", `${shot.name} is not in this queue`);
        toast(`Undid ${shot.name} (not in this queue)`);
      }
    } else if (state.view === "staged") {
      renderStaged();
      toast(`Undid: ${shot.name}`);
    } else {
      await loadMonths();
      render();
      toast(`Undid: ${shot.name}`);
    }
    await refreshCounts();
  } catch (e) {
    log.warn("undo", `couldn't refresh after undo: ${e}`);
  }
}

/** The decision a status stands for, for redo. */
const ACTION_OF = { kept: ACTION.KEEP, staged: ACTION.DELETE, skipped: ACTION.SKIP };

async function redo() {
  if (state.deciding || state.busy) return;
  let shot;
  try {
    shot = await api("redo_last");
  } catch (e) {
    log.error("redo", "couldn't redo", e);
    toast(`Couldn't redo: ${e}`, { tone: "error" });
    return;
  }
  if (!shot) {
    toast("Nothing to redo");
    return;
  }
  log.info("redo", `${shot.name} -> ${shot.status}`);
  const action = ACTION_OF[shot.status];
  // The card the undo brought back is usually still on top: throw it again,
  // the way it left the first time.
  if (state.view === "review" && action && state.card?.id === shot.id) {
    await decide(action, { via: "key", saved: shot });
    return;
  }
  state.cache.set(shot.id, shot);
  try {
    if (state.view === "review") renderReviewChrome();
    else if (state.view === "staged") renderStaged();
    else {
      await loadMonths();
      render();
    }
    toast(`Redid: ${shot.name}`);
    await refreshCounts();
  } catch (e) {
    log.warn("redo", `couldn't refresh after redo: ${e}`);
  }
}

// --------------------------------------------------------------------- finale

/** "You went through 3 screenshots: kept 2 and marked 1 for deletion (189 KB)." */
function passSentence(total, c) {
  if (!total) return "Nothing was decided in this pass.";
  const parts = [];
  if (c.keep) parts.push(`kept ${formatCount(c.keep)}`);
  if (c.delete) parts.push(`marked ${formatCount(c.delete)} for deletion${c.deleteBytes ? ` (${formatBytes(c.deleteBytes)})` : ""}`);
  if (c.skip) parts.push(`skipped ${formatCount(c.skip)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `You went through ${countOf(total, "screenshot")}: ${list}.`;
}

function renderFinale() {
  const c = state.pass.counts();
  const scope = state.scope || {};
  const month = scope.scope === "month" ? state.months.find((m) => m.month === scope.month) : null;
  const next = scope.scope === "month" ? nextMonthWithWork(state.months, scope.month) : null;
  const staged = state.summary?.pile || 0;
  const reviewedPile = scope.scope === "staged";

  const title = month && progressOf(month).done
    ? `${scope.label} is sorted`
    : reviewedPile
      ? "Checked the deletion pile"
      : "That's the end of this pass";
  const actions = [];
  if (next) {
    actions.push(h("button", { class: "btn primary lg", id: "fin-next", onclick: () => openQueue("month", next, monthLabel(next)) },
      `Next: ${monthLabel(next)}`, icon("chevron-right", { size: 16 })));
  }
  if (staged && !reviewedPile) {
    actions.push(h("button", { class: `btn ${next ? "" : "primary lg"}`.trim(), onclick: openStaged },
      icon("trash", { size: 16 }), `Review ${countOf(staged, "file")} to delete`));
  }
  actions.push(h("button", { class: `btn${actions.length ? "" : " primary lg"}`, id: "fin-back", onclick: reviewedPile ? openStaged : backToMonths },
    reviewedPile ? "Back to the pile" : "Back to the library"));

  el.view.replaceChildren(h("div", { class: "page narrow" },
    h("section", { class: "finale" },
      h("div", { class: "fin-badge" }, icon("check", { size: 26 })),
      h("h1", { text: title }),
      h("p", { class: "fin-lead", text: passSentence(state.pass.size, c) }),
      state.pass.size
        ? h("div", { class: "fin-bar" },
            segbar({ total: state.pass.size, kept: c.keep, staged: c.delete, skipped: c.skip }, "lg"),
            legend({ kept: c.keep, staged: c.delete, skipped: c.skip }, ["kept", "staged", "skipped"]))
        : null,
      h("div", { class: "fin-actions" }, actions))));
  // The primary action takes focus, so Enter or Space continues.
  el.view.querySelector(".fin-actions .btn")?.focus();
}

// ------------------------------------------------------------------ to delete

async function renderStaged() {
  const token = ++state.stagedToken;
  el.view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "busy" })));
  el.view.scrollTop = 0;
  let rows;
  try {
    rows = await api("staged_list", { rootId: state.rootId });
  } catch (e) {
    if (state.view === "staged" && token === state.stagedToken) {
      el.view.replaceChildren(h("div", { class: "empty" },
        h("h2", { text: "Couldn't load the deletion pile" }),
        h("p", { text: String(e) })));
    }
    return;
  }
  // The user may have left while the list was loading.
  if (state.view !== "staged" || token !== state.stagedToken) return;

  if (!rows.length) {
    el.view.replaceChildren(h("div", { class: "page narrow" }, h("div", { class: "empty" },
      h("div", { class: "empty-glyph ok" }, icon("check", { size: 26 })),
      h("h2", { text: "Nothing marked for deletion" }),
      h("p", { text: `Swipe a card left, or press ←, to put it here. Files stay on disk until you move them to the ${binName()} from this page.` }),
      h("button", { class: "btn primary", onclick: backToMonths }, "Back to the library"))));
    return;
  }

  const total = rows.reduce((n, r) => n + (Number(r.size) || 0), 0);
  el.view.replaceChildren(h("div", { class: "page" },
    h("section", { class: "pile-head" },
      h("div", {},
        h("h1", { text: "Marked for deletion" }),
        h("p", { class: "pile-sub", text: `${countOf(rows.length, "screenshot")} · ${formatBytes(total)} · still on disk until you move them` })),
      h("div", { class: "pile-actions" },
        h("button", { class: "btn", title: "Look at each one as a card before deleting", onclick: () => openQueue("staged", null, "Marked for deletion") },
          icon("play", { size: 16 }), "Check one by one"),
        h("button", { class: "btn danger solid", id: "btn-pile-commit", onclick: commit },
          icon("trash", { size: 16 }), `Move to ${binName()}`))),
    h("div", { class: "pile-grid", role: "list" }, rows.map(pileTile))));
}

function thumb(shot) {
  if (shot.viewable && !shot.missing) {
    return h("img", { src: convertFileSrc(shot.path), alt: shot.name, loading: "lazy", decoding: "async", draggable: "false" });
  }
  return h("span", { class: "thumb-ext", text: shot.missing ? "MISSING" : shot.ext.toUpperCase() });
}

function pileTile(shot) {
  return h("figure", { class: "tile", role: "listitem", dataset: { id: String(shot.id) } },
    h("button", { class: "tile-photo", title: `Open ${shot.name}`, onclick: () => openShotViewer(shot) }, thumb(shot)),
    h("figcaption", {},
      h("span", { class: "tile-name", text: shot.name, title: shot.name }),
      h("span", { class: "tile-meta", text: `${formatBytes(shot.size)} · ${formatDateTime(shot.taken_ms).slice(0, 10)}` })),
    h("button", { class: "btn sm tile-putback", title: "Take it off the pile; it goes back to the unsorted screenshots", onclick: (e) => unstageOne(shot.id, e.currentTarget.closest(".tile")) },
      icon("undo", { size: 14 }), "Don't delete"));
}

async function unstageOne(id, tile = null) {
  if (state.busy) return;
  let shot;
  try {
    shot = await api("unstage", { id });
  } catch (e) {
    toast(`Couldn't put it back: ${e}`, { tone: "error" });
    return;
  }
  state.cache.set(id, shot);
  state.history.push({ id, action: "unstage", prevInPass: undefined, pass: null });
  if (tile && !reducedMotion()) {
    tile.classList.add("leaving");
    await wait(220);
  }
  // The file is back either way; a failed count refresh only leaves the badge
  // a step behind.
  try {
    await refreshCounts();
  } catch (e) {
    log.warn("pile", `couldn't refresh counts: ${e}`);
  }
  if (state.view === "staged") renderStaged();
  toast(`${shot.name} is back in the unsorted pile`, { action: "Undo", onAction: () => undo() });
}

// --------------------------------------------------------------------- commit

async function commit() {
  if (state.busy) return;
  const n = state.summary?.pile || 0;
  if (!n) return;

  // The pile page behind the dialog is the preview, so the dialog only says
  // what will happen.
  const count = n;
  const bytes = state.summary?.bytes_pile || 0;

  const ok = await confirmDialog({
    title: `Move to the ${binName()}?`,
    message: `${countOf(count, "screenshot")}${bytes ? ` (${formatBytes(bytes)})` : ""} will go to the ${binName()}. Nothing is deleted permanently: you can restore files from there.`,
    confirmLabel: `Move ${countOf(count, "file")}`,
    confirmIcon: "trash",
    variant: "danger solid",
  });
  if (!ok) return;

  state.busy = true;
  document.getElementById("btn-pile-commit")?.setAttribute("disabled", "");
  log.info("commit", `moving ${count} files to the ${binName()}`);
  try {
    const report = await api("commit_deletes", { rootId: state.rootId });
    reportCommit(report);
    // The files are moved by now; a failed reload must not report otherwise.
    try {
      await loadMonths();
    } catch (e) {
      log.warn("commit", `couldn't reload the library: ${e}`);
    }
    state.busy = false;
    render();
  } catch (e) {
    log.error("commit", "couldn't move files", e);
    toast(`Couldn't move the files: ${e}`, { tone: "error" });
  } finally {
    state.busy = false;
    renderHeader();
    try {
      await refreshCounts();
    } catch (e) {
      log.warn("commit", `couldn't refresh counts: ${e}`);
    }
  }
}

/**
 * One toast for the whole commit. There is only one toast on screen, so a
 * toast per failed file was overwritten by the next one and never seen.
 */
function reportCommit(report) {
  const moved = report?.deleted || 0;
  const failed = (report?.failed || []).filter((f) => !f.gone);
  const gone = (report?.failed || []).filter((f) => f.gone).length;
  for (const f of failed) log.warn("commit", `${f.name}: ${f.error}`);
  const parts = [];
  if (moved) parts.push(`Moved ${countOf(moved, "screenshot")} to the ${binName()}${report.bytes_freed ? `, ${formatBytes(report.bytes_freed)} freed` : ""}`);
  if (gone) parts.push(`${countOf(gone, "file")} already gone`);
  if (failed.length) parts.push(`${countOf(failed.length, "file")} couldn't be moved`);
  log.info("commit", `${moved} moved, ${gone} gone, ${failed.length} failed, ${report?.still_staged || 0} still staged`);
  if (failed.length) {
    toast(parts.join(" · "), { tone: "error", ms: 9000, action: "Details", onAction: () => showFailures(failed) });
  } else {
    toast(parts.join(" · ") || "Nothing was moved", { tone: moved ? "ok" : "" });
  }
}

function showFailures(failed) {
  modal({
    title: "Some files couldn't be moved",
    body: [
      h("p", { class: "modal-lead", text: "They are still marked for deletion, so you can try again or put them back." }),
      h("ul", { class: "fail-list" }, failed.map((f) => h("li", {}, h("b", { text: f.name }), h("span", { text: f.error })))),
    ],
    actions: [{ label: "Close" }],
  });
}

// --------------------------------------------------------------------- folders

async function folderMenu() {
  if (menuOpen()) {
    closeMenu();
    return;
  }
  // The per-folder counts change with every decision, so read them fresh.
  try {
    await loadRoots();
  } catch (e) {
    log.warn("folder", `couldn't refresh folders: ${e}`);
  }
  const items = state.roots.map((r) => ({
    label: basename(r.path) || r.path,
    sub: r.path,
    meta: r.total ? `${formatCount(r.pending)} left` : "not scanned",
    title: `${r.path}\nScanned ${timeAgo(r.last_scan_ms)}`,
    checked: r.id === state.rootId,
    icon: r.id === state.rootId ? "check" : "folder",
    onClick: () => selectRoot(r),
  }));
  items.push({ separator: true }, { label: "Add a folder…", icon: "folder-plus", onClick: addFolder });
  const cur = currentRoot();
  if (cur) items.push({ label: `Forget “${basename(cur.path) || cur.path}”…`, icon: "close", danger: true, onClick: () => forgetRoot(cur) });
  openMenu(el.folderBtn, items);
}

/**
 * True, and says why, while a scan or a commit is running. Switching, adding
 * or forgetting a folder then would race it: a scan finishing after a forget
 * adds the folder straight back.
 */
function foldersBusy() {
  if (!state.busy && !state.scanning) return false;
  toast(state.busy ? commitRunning() : "Wait for the scan to finish first");
  return true;
}

async function addFolder() {
  if (foldersBusy()) return;
  let picked;
  try {
    picked = await api("pick_folder");
  } catch (e) {
    toast(`Couldn't open the folder picker: ${e}`, { tone: "error" });
    return;
  }
  if (!picked) return;
  log.info("folder", `picked: ${picked}`);
  await scanFolder(picked);
}

async function rescan() {
  const root = currentRoot() || state.roots[0];
  if (!root) return addFolder();
  return scanFolder(root.path);
}

/**
 * Scans `path` and lands on its library. Scanning is what adds a folder to the
 * database, so it has to happen before the folder can be selected.
 */
async function scanFolder(path) {
  if (state.busy || state.scanning) return;
  const known = state.roots.some((r) => r.path === path);
  const prevView = state.view;
  state.scanning = path;
  state.scanFound = 0;
  // A first scan has nothing to show yet; a rescan keeps the library on screen.
  if (!known || prevView === "setup") state.view = "scanning";
  render();
  try {
    const report = await api("scan_root", { path });
    await loadRoots();
    const root = state.roots.find((r) => r.path === path);
    if (!root) {
      log.warn("folder", `root not found after scan: ${path}`);
      toast(`Couldn't add ${path}`, { tone: "error" });
      state.view = prevView === "scanning" ? "setup" : prevView;
      return;
    }
    if (root.id !== state.rootId) state.libraryScroll = 0;
    state.rootId = root.id;
    // A rescan keeps the library usable, so the user may have opened a month
    // meanwhile: refresh the data, but do not pull them out of a review.
    if (state.view !== "review" && state.view !== "staged") state.view = "months";
    await loadMonths();
    log.info("scan", `${path}: ${scanSummary(report)} (${report.elapsed_ms} ms)`);
    toast(`${basename(path)}: ${scanSummary(report)}`);
  } catch (e) {
    log.error("scan", `${path} scan failed`, e);
    toast(`Scan failed: ${e}`, { tone: "error" });
    if (state.view === "scanning") state.view = state.roots.length ? "months" : "setup";
  } finally {
    state.scanning = null;
    state.scanFound = 0;
    // A full render would rebuild a review's deck under the user's hands.
    if (state.view === "review") renderHeader();
    else render();
  }
}

async function selectRoot(root) {
  if (foldersBusy()) return;
  state.rootId = root.id;
  state.libraryScroll = 0;
  if (!root.total) return scanFolder(root.path);
  state.view = "months";
  render();
  try {
    await loadMonths();
  } catch (e) {
    toast(`Couldn't load ${root.path}: ${e}`, { tone: "error" });
  }
  render();
}

async function forgetRoot(root) {
  if (foldersBusy()) return;
  const name = basename(root.path) || root.path;
  const ok = await confirmDialog({
    title: `Forget “${name}”?`,
    message: `Shotpile stops tracking ${root.path} and forgets what you decided for its ${countOf(root.total, "screenshot")}.${root.staged ? ` ${root.staged === 1 ? "The one marked for deletion is" : `The ${formatCount(root.staged)} marked for deletion are`} unmarked.` : ""} No files are touched, and you can add the folder again at any time.`,
    confirmLabel: "Forget folder",
  });
  if (!ok) return;
  try {
    await api("forget_root", { rootId: root.id });
    log.info("folder", `forgot ${root.path}`);
    await loadRoots();
    const nextRoot = state.roots.find((r) => r.total > 0) || state.roots[0] || null;
    state.rootId = nextRoot?.id ?? null;
    state.libraryScroll = 0;
    if (nextRoot) {
      state.view = "months";
      await loadMonths();
    } else {
      state.view = "setup";
      state.summary = null;
      state.months = [];
    }
    render();
    toast(`Forgot ${name}`);
  } catch (e) {
    toast(`Couldn't forget that folder: ${e}`, { tone: "error" });
  }
}

// ------------------------------------------------------------------- dialogs

/** Opens the file log in a modal, for diagnosing without DevTools. */
// ------------------------------------------------------------------- options

/** The zoom steps Ctrl+plus and Ctrl+minus walk through. */
const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function applyZoom(factor) {
  invoke("set_zoom", { factor }).catch((e) => log.warn("zoom", `couldn't set ${factor}: ${e}`));
}

/** `step` is +1 or -1 for the next step, 0 to reset. */
function zoomApp(step) {
  const now = prefs.get().zoom;
  let next = 1;
  if (step > 0) next = ZOOM_STEPS.find((z) => z > now + 0.001) ?? now;
  else if (step < 0) next = [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? now;
  const saved = prefs.set({ zoom: next });
  applyZoom(saved.zoom);
  log.info("zoom", `${Math.round(saved.zoom * 100)}%`);
  document.querySelectorAll(".zoom-value").forEach((n) => { n.textContent = `${Math.round(saved.zoom * 100)}%`; });
  if (step || now !== 1) toast(`Zoom ${Math.round(saved.zoom * 100)}%`, { ms: 1200 });
}

/** Opens a known place (the data or logs folder, or a screenshot) in the file manager. */
async function reveal(target, id = null) {
  try {
    await api("reveal", { target, id });
  } catch (e) {
    toast(`Couldn't open it: ${e}`, { tone: "error" });
  }
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, { ms: 1600 });
  } catch (e) {
    log.warn("clipboard", `couldn't copy: ${e}`);
    toast("Couldn't copy to the clipboard", { tone: "error" });
  }
}

async function copyImage(id) {
  try {
    await api("copy_image", { id });
    toast("Copied the image", { ms: 1600 });
  } catch (e) {
    log.warn("clipboard", `couldn't copy image: ${e}`);
    toast("Couldn't copy the image", { tone: "error" });
  }
}

/** What the library lists. Today that is whether sorted months show; more
    filters can join here. */
function showFilters() {
  const buttons = [[false, "Hide"], [true, "Show"]].map(([value, label]) => h("button", {
    type: "button",
    "aria-pressed": String(prefs.get().showDone === value),
    dataset: { showDone: String(value) },
    text: label,
    onclick: (e) => {
      prefs.set({ showDone: value });
      log.info("filter", `sorted months ${label.toLowerCase()}`);
      for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      render();
    },
  }));
  modal({
    title: "Filter",
    cls: "options-sheet",
    body: h("section", { class: "opt-group" },
      h("div", { class: "opt-row" },
        h("div", { class: "opt-label" }, "Sorted months", h("small", { text: "Months with nothing left to sort. Their screenshots still count in the totals." })),
        h("div", { class: "segmented", role: "group", "aria-label": "Sorted months" }, buttons))),
    actions: [{ label: "Close" }],
  });
}

const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" };

function showOptions() {
  const info = state.info || {};
  const current = prefs.get();
  const themeButtons = prefs.THEMES.map((t) => h("button", {
    type: "button",
    "aria-pressed": String(current.theme === t),
    dataset: { theme: t },
    text: THEME_LABEL[t],
    onclick: (e) => {
      prefs.set({ theme: t });
      log.info("options", `theme ${t}`);
      for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
    },
  }));
  const place = (label, path, target) => h("div", { class: "opt-row" },
    h("div", { class: "opt-label" }, label, h("small", { class: "opt-path", text: path || "unknown" })),
    h("button", { class: "btn sm", title: "Copy the path", "aria-label": `Copy the ${label.toLowerCase()} path`, onclick: () => copyText(path, "the path") }, icon("copy", { size: 15 })),
    h("button", { class: "btn sm", onclick: () => reveal(target) }, icon("folder", { size: 15 }), "Open"));
  const fact = (k, v) => [h("dt", { text: k }), h("dd", { text: v || "unknown" })];

  modal({
    title: "Options",
    cls: "options-sheet",
    body: [
      h("section", { class: "opt-group" },
        h("h3", { text: "Appearance" }),
        h("div", { class: "opt-row" },
          h("div", { class: "opt-label" }, "Theme", h("small", { text: "System follows the operating system" })),
          h("div", { class: "segmented", role: "group", "aria-label": "Theme" }, themeButtons)),
        h("div", { class: "opt-row" },
          h("div", { class: "opt-label" }, "Zoom", h("small", { text: "Ctrl and + or −, or Ctrl and the mouse wheel" })),
          h("button", { class: "btn sm icon", "aria-label": "Zoom out", onclick: () => zoomApp(-1) }, icon("zoom-out", { size: 15 })),
          h("span", { class: "zoom-value", text: `${Math.round(current.zoom * 100)}%` }),
          h("button", { class: "btn sm icon", "aria-label": "Zoom in", onclick: () => zoomApp(1) }, icon("zoom-in", { size: 15 })),
          h("button", { class: "btn sm ghost", onclick: () => zoomApp(0), text: "Reset" }))),
      h("section", { class: "opt-group" },
        h("h3", { text: "Your data" }),
        h("p", { class: "about-note", text: "Decisions live in one database file on this computer. Your screenshots are never copied or uploaded." }),
        place("Data folder", info.data_dir, "data"),
        place("Logs", info.log_path, "logs"),
        h("div", { class: "opt-row" },
          h("button", { class: "btn sm", onclick: () => { closeModal(); showLog(); } }, icon("log", { size: 15 }), "View the log"),
          h("button", { class: "btn sm", onclick: () => { closeModal(); showShortcuts(); } }, icon("keyboard", { size: 15 }), "Keyboard shortcuts"))),
      h("section", { class: "opt-group" },
        h("h3", { text: "About" }),
        h("dl", { class: "about-list" },
          fact("Shotpile", info.app_version ? `v${info.app_version}, by SametHope` : ""),
          fact("Tauri", info.tauri_version),
          fact("WebView2", info.webview_version),
          fact("SQLite", info.sqlite_version ? `${info.sqlite_version}, built in` : ""),
          fact("Database schema", info.schema_version != null ? String(info.schema_version) : "")),
        h("p", { class: "about-note", text: "Made by SametHope. Free for any noncommercial use under the PolyForm Noncommercial License 1.0.0; selling it or using it to make money is not allowed." }),
        h("p", { class: "about-note", text: "Built on Tauri and Microsoft Edge WebView2, with rusqlite, SQLite (public domain), trash, walkdir, chrono, regex, serde and rfd, all under MIT, Apache-2.0 or similar permissive licences. Every release lists them in full in THIRD-PARTY-LICENSES.html." }),
        h("div", { class: "opt-row" },
          h("button", { class: "btn sm", onclick: () => reveal("repo") }, icon("expand", { size: 15 }), "Open on GitHub"))),
    ],
    actions: [{ label: "Close" }],
  });
}

// -------------------------------------------------------------- context menus

/** The shot a right-click landed on: a deck card, a pile tile, a filmstrip item. */
function shotAt(target) {
  const node = target.closest?.(".card[data-id], .tile[data-id], .film-item[data-id]");
  if (!node) return null;
  return { node, shot: state.cache.get(Number(node.dataset.id)) || null };
}

function onContextMenu(e) {
  const t = e.target;
  // Text fields and selected text keep the native menu, for copy and paste.
  if (t.closest?.("input, textarea, [contenteditable]") || String(window.getSelection?.() || "")) return;
  e.preventDefault();
  if (modalOpen() || viewerOpen()) return;
  const at = { x: e.clientX, y: e.clientY };
  const items = [];
  const hit = shotAt(t);
  if (hit?.shot) {
    const { shot, node } = hit;
    const isCard = node.classList.contains("card");
    const isTile = node.classList.contains("tile");
    const onTop = isCard && node === topCard() && state.card?.id === shot.id;
    items.push({ label: "Open full screen", icon: "expand", meta: onTop ? "Space" : null, onClick: () => openShotViewer(shot, onTop ? node : null) });
    if (onTop) {
      items.push(
        { label: "Keep", icon: "check", meta: "→", onClick: () => decide(ACTION.KEEP, { via: "button" }) },
        { label: "Mark for deletion", icon: "trash", meta: "←", danger: true, onClick: () => decide(ACTION.DELETE, { via: "button" }) });
      if (state.scope?.scope !== "staged") items.push({ label: "Skip for now", icon: "skip", meta: "↑", onClick: () => decide(ACTION.SKIP, { via: "button" }) });
    }
    if (isTile) {
      items.push({ label: "Restore", sub: "Take it off the deletion pile", icon: "undo", onClick: () => unstageOne(shot.id, node) });
    }
    items.push({ separator: true });
    if (isCard && shot.viewable) items.push({ label: "Copy image", icon: "image", onClick: () => copyImage(shot.id) });
    items.push(
      { label: `Show in ${fileManager()}`, icon: "folder", onClick: () => reveal("shot", shot.id) },
      { label: "Copy file path", icon: "copy", onClick: () => copyText(shot.path, "the file path") },
      { label: "Copy file name", icon: "copy", onClick: () => copyText(basename(shot.path), "the file name") });
  } else {
    const month = t.closest?.(".month[data-month]");
    if (month) {
      items.push({ label: "Sort this month", icon: "play", onClick: () => month.click() }, { separator: true });
    }
    items.push(
      { label: "Undo", icon: "undo", meta: "Ctrl+Z", onClick: () => undo() },
      { label: "Redo", icon: "redo", meta: "Ctrl+Y", onClick: () => redo() },
      { separator: true },
      { label: "Options", icon: "sliders", meta: "Ctrl+,", onClick: showOptions },
      { label: "Keyboard shortcuts", icon: "keyboard", meta: "?", onClick: showShortcuts });
  }
  openMenu(null, items, { at });
}

async function showLog() {
  log.info("log", "opening log");
  let text;
  try {
    text = await api("log_read", { maxLines: 500 });
  } catch (e) {
    text = `Couldn't read the log: ${e}`;
  }
  const where = state.info?.log_path ? h("p", { class: "modal-lead", text: state.info.log_path }) : null;
  modal({
    title: "Log",
    wide: true,
    body: [where, h("pre", { class: "logview", text: text || "(the log is empty)" })],
    actions: [{ label: "Close" }],
  });
  const pre = document.querySelector(".logview");
  if (pre) pre.scrollTop = pre.scrollHeight;
}

function showShortcuts() {
  const row = (keys, what) => h("div", { class: "keys-row" },
    h("span", { class: "keys" }, keys.map((k) => kbd(k))),
    h("span", { text: what }));
  const group = (title, ...rows) => h("div", { class: "keys-group" }, h("h3", { text: title }), rows);
  modal({
    title: "Keyboard shortcuts",
    cls: "keys-sheet",
    body: [
      group("Sorting",
        row(["←"], "Mark for deletion"),
        row(["→"], "Keep"),
        row(["↑"], "Skip for now (comes back once, at the end)"),
        row(["Z"], "Undo the last decision"),
        row(["Ctrl", "Z"], "Undo, from any page"),
        row(["Ctrl", "Y"], "Redo (also Ctrl+Shift+Z, or Y while sorting)")),
      group("Looking closer",
        row(["Space"], "Open full screen"),
        row(["+", "−"], "Zoom the card"),
        row(["0"], "Back to 100%"),
        row(["Esc"], "Close full screen")),
      group("Window",
        row(["Ctrl", "+"], "Zoom the app in"),
        row(["Ctrl", "−"], "Zoom the app out"),
        row(["Ctrl", "0"], "Reset the app zoom"),
        row(["Ctrl", ","], "Options")),
      group("Troubleshooting",
        row(["F12"], "Developer tools"),
        row(["Ctrl", "Shift", "L"], "Show the log")),
    ],
    actions: [{ label: "Close" }],
  });
}

// ------------------------------------------------------------------ keyboard

document.addEventListener("keydown", (e) => {
  // DevTools on F12 / Ctrl+Shift+I, before anything else, so it works in a
  // release build and even while a modal is up.
  if (e.key === "F12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i")) {
    e.preventDefault();
    log.info("devtools", "opening");
    api("open_devtools").catch((err) => log.warn("devtools", `couldn't open: ${err}`));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    showLog();
    return;
  }
  // App zoom works everywhere, dialogs included, like a browser's.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const step = { "=": 1, "+": 1, "-": -1, "_": -1, "0": 0 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      zoomApp(step);
      return;
    }
  }

  // A dialog owns the keyboard first: the log can open over the viewer, and
  // Enter on its Close button must close the log, not the viewer behind it.
  if (menuOpen() || modalOpen()) return;
  // While the viewer is open it owns the keyboard.
  if (viewerOpen()) {
    viewerKeydown(e);
    return;
  }
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;

  if (e.key === "?") {
    e.preventDefault();
    showShortcuts();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === ",") {
    e.preventDefault();
    showOptions();
    return;
  }
  if (ctrl && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
    e.preventDefault();
    if (!e.repeat) redo();
    return;
  }
  if (ctrl && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (!e.repeat) undo();
    return;
  }
  if (state.view !== "review") return;
  if (e.key === "z" || e.key === "Z" || e.key === "Backspace") {
    e.preventDefault();
    if (!e.repeat) undo();
    return;
  }
  if (e.key === "y" || e.key === "Y") {
    e.preventDefault();
    if (!e.repeat) redo();
    return;
  }
  // On the end-of-pass summary the focused button handles Enter and Space.
  if (!state.card) return;

  const zoom = zoomOf(topCard());
  // While the card is zoomed in, the arrows pan the image instead of deciding.
  if (zoom?.panning()) {
    const pan = 60;
    const z = zoom.zoom;
    switch (e.key) {
      case "ArrowLeft": z.x += pan; break;
      case "ArrowRight": z.x -= pan; break;
      case "ArrowUp": z.y += pan; break;
      case "ArrowDown": z.y -= pan; break;
      case "0": zoom.reset(); e.preventDefault(); return;
      case "+": case "=": zoom.zoomBy(1.25); e.preventDefault(); return;
      case "-": case "_": zoom.zoomBy(1 / 1.25); e.preventDefault(); return;
      case " ": e.preventDefault(); openShotViewer(state.card, topCard()); return;
      default: return;
    }
    e.preventDefault();
    zoom.clampPan();
    zoom.apply();
    return;
  }

  // Holding a key down must not machine-gun through the queue: one press, one
  // decision.
  const decisionKey = { ArrowLeft: ACTION.DELETE, ArrowRight: ACTION.KEEP, ArrowUp: ACTION.SKIP }[e.key];
  if (decisionKey) {
    e.preventDefault();
    // A key during a drag would decide the card under the pointer, and the
    // release would then decide the next one with the drag's direction.
    if (!e.repeat && !state.drag) decide(decisionKey, { via: "key" });
    return;
  }
  switch (e.key) {
    case " ":
      e.preventDefault();
      openShotViewer(state.card, topCard());
      break;
    case "+": case "=":
      e.preventDefault();
      zoom?.zoomBy(1.25);
      break;
    case "-": case "_":
      e.preventDefault();
      zoom?.zoomBy(1 / 1.25);
      break;
    case "0":
      zoom?.reset();
      break;
    default:
      break;
  }
});

// Test hooks for the GUI harness, so flows can be driven without a native
// dialog. Not used in production.
window.__shotpileTest = {
  addFolder,
  openViewer: () => openShotViewer(state.card, topCard()),
  closeViewer,
  resetCardZoom: () => zoomOf(topCard())?.reset(),
  snapshot: () => ({ view: state.view, deciding: state.deciding, cursor: state.queue.cursor, ids: state.queue.ids.slice() }),
  dropCache: () => state.cache.clear(),
  resetToSetup() {
    state.roots = [];
    state.rootId = null;
    state.months = [];
    state.summary = null;
    state.view = "setup";
    render();
  },
};

// --------------------------------------------------------------------- wiring

initModal();
el.back.addEventListener("click", backToMonths);
el.folderBtn.addEventListener("click", folderMenu);
el.scan.addEventListener("click", rescan);
// The footer leads to the pile, which is the preview; the commit itself is
// confirmed there.
el.commit.addEventListener("click", openStaged);
el.undo.addEventListener("click", () => undo());
el.redo.addEventListener("click", () => redo());
el.options.addEventListener("click", showOptions);
document.addEventListener("contextmenu", onContextMenu);
const WHEEL_STEP = 40;
let wheelAcc = 0;
// Ctrl + wheel zooms the app in steps, through the same preference.
window.addEventListener("wheel", (e) => {
  // Over a photo the wheel (and a pinch, which arrives as ctrl+wheel) already
  // zoomed the photo; elsewhere ctrl zooms the app. A pinch is many tiny
  // events, so they add up to a step instead of stepping once each.
  if (!e.ctrlKey || e.defaultPrevented) return;
  e.preventDefault();
  wheelAcc += e.deltaMode === 0 ? e.deltaY : e.deltaY * 16;
  if (Math.abs(wheelAcc) < WHEEL_STEP) return;
  zoomApp(wheelAcc < 0 ? 1 : -1);
  wheelAcc = 0;
}, { passive: false });
el.stagedBtn.addEventListener("click", openStaged);
el.help.addEventListener("click", showShortcuts);
// Progress is optional: without the event API the scan still completes.
window.__TAURI__.event?.listen?.("scan-progress", (e) => onScanProgress(e.payload))
  ?.catch?.((err) => log.warn("scan", `no scan progress: ${err}`));

/** Takes the splash down and shows the native window (it starts hidden, so
    nothing paints before the page has). */
function revealApp() {
  if (document.body.classList.contains("ready")) return;
  requestAnimationFrame(() => {
    document.body.classList.add("ready");
    invoke("app_ready").catch((e) => log.warn("boot", `couldn't show the window: ${e}`));
  });
}

(async function boot() {
  log.info("boot", "starting");
  applyZoom(prefs.get().zoom);
  try {
    state.info = await api("app_info");
    log.info("app_info", `v${state.info.app_version}, db ${state.info.db_path} (schema ${state.info.schema_version})`);
  } catch (e) {
    log.error("boot", "couldn't open backend", e);
    el.view.replaceChildren(h("div", { class: "empty" },
      h("h2", { text: "Couldn't start the app backend" }),
      h("p", { text: String(e) }),
      h("p", { class: "muted", text: "Press Ctrl+Shift+L for the log, or F12 for developer tools." })));
    revealApp();
    return;
  }
  try {
    await loadRoots();
    const active = state.roots.find((r) => r.total > 0) || state.roots[0] || null;
    if (!active) {
      log.info("boot", "no saved folders, setup screen");
      state.view = "setup";
      render();
      revealApp();
      return;
    }
    state.rootId = active.id;
    state.view = "months";
    await loadMonths();
  } catch (e) {
    log.error("boot", "couldn't load the library", e);
    toast(`Couldn't load the library: ${e}`, { tone: "error" });
  }
  render();
  revealApp();
})();
