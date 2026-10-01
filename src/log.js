/**
 * Tiny leveled logger for the frontend.
 *
 * Every entry goes to the console (DevTools: F12 or Ctrl+Shift+I) and into an
 * in-memory ring buffer, so the recent history can be printed after something
 * goes wrong without having to reproduce it. Warnings and errors are also
 * handed to an optional sink, which the app points at the backend file log so
 * a release build keeps them after the window is closed.
 *
 * No DOM and no Tauri calls, so this stays importable by `node --test` just
 * like logic.js.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// `?log=debug` on the URL lowers the floor; everything at or above the level is
// kept. Release default is info, which stays quiet during normal use. An
// unknown level falls back to info instead of silently logging everything.
const threshold = (() => {
  try {
    const asked = new URLSearchParams(location.search).get("log");
    return asked in LEVELS ? asked : "info";
  } catch {
    return "info";
  }
})();

const RING_CAP = 500;
const ring = [];

/** Receives `(level, scope, text)` for warn/error entries; see `setSink`. */
let sink = null;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, "0")}`;
}

/** Flattens the optional data argument into text for the ring and the sink. */
function describe(data) {
  if (data === undefined) return "";
  if (data instanceof Error) return data.message;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function emit(level, scope, msg, data) {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const extra = describe(data);
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra ? ` | ${extra}` : ""}`;
  ring.push(line);
  if (ring.length > RING_CAP) ring.shift();

  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.info;
  if (data !== undefined) fn(line, data);
  else fn(line);

  if (sink && LEVELS[level] >= LEVELS.warn) {
    try {
      sink(level, scope, extra ? `${msg} | ${extra}` : msg);
    } catch {
      /* a broken sink must never take logging down with it */
    }
  }
}

export const log = {
  debug: (scope, msg, data) => emit("debug", scope, msg, data),
  info: (scope, msg, data) => emit("info", scope, msg, data),
  warn: (scope, msg, data) => emit("warn", scope, msg, data),
  error: (scope, msg, data) => emit("error", scope, msg, data),

  /** Prints the whole ring buffer, oldest first. Handy from DevTools. */
  dump() {
    console.info(`--- log dump (${ring.length} entries, threshold ${threshold}) ---`);
    for (const line of ring) console.info(line);
    console.info("--- end of log dump ---");
  },

  /** Recent entries as plain text, for copying out of the app. */
  text() {
    return ring.join("\n");
  },

  /**
   * Forwards warn/error entries to `fn(level, scope, text)`. Pass null to
   * stop. The sink must not log through this logger, or it would recurse.
   */
  setSink(fn) {
    sink = typeof fn === "function" ? fn : null;
  },

  get threshold() {
    return threshold;
  },
};

// Lets DevTools call `__shotpileLog.dump()` / `.text()` directly.
if (typeof window !== "undefined") {
  window.__shotpileLog = log;
}
