/**
 * Tiny leveled logger for the frontend.
 *
 * Every entry goes to the console (DevTools: F12 or Ctrl+Shift+I) and into an
 * in-memory ring buffer, so the recent history can be printed after something
 * goes wrong without having to reproduce it.
 *
 * No DOM and no Tauri calls, so this stays importable by `node --test` just
 * like logic.js.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// `?log=debug` on the URL raises the floor; everything at or above the level is
// kept. Release default is info, which stays quiet during normal use.
const threshold = (() => {
  try {
    return new URLSearchParams(location.search).get("log") || "info";
  } catch {
    return "info";
  }
})();

const RING_CAP = 500;
const ring = [];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, "0")}`;
}

function emit(level, scope, msg, data) {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
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

  get threshold() {
    return threshold;
  },
};

// Lets DevTools call `__sifterLog.dump()` / `.text()` directly.
if (typeof window !== "undefined") {
  window.__sifterLog = log;
}
