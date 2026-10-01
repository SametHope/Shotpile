// In-memory stand-in for the Rust command surface, loaded before src/app.js by
// tests/serve.cjs. It mirrors src-tauri/src/{db,commands,undo}.rs closely enough
// that the GUI test exercises the real app logic: same statuses, same queue
// orders, the same undo-stack rules (stale entries skipped, committed files
// never resurrected), missing files kept out of review queues.
//
// Also used by `npm run preview` to click through the UI without Rust.
//
// Root A: 3 PNGs in 2026-09 + 1 unviewable HEIC in 2026-08.
// Root B: 2 PNGs in 2026-08, used to prove staged counts are global.
(function () {
  "use strict";

  const LOG = []; // command trace the test asserts on
  const FAILS = []; // page errors, collected for the test
  const UI_LOG = []; // entries the frontend forwarded through log_write
  let nextId = 1;
  const shots = new Map();
  const undoStack = [];
  const UNDO_LIMIT = 200;

  // Fault injection, for the edge cases the logic tests cannot reach.
  const faults = { decide: false, summary: false, undoOutOfScope: false, scanDelayMs: 0 };

  function addShot(rootId, name, ext, takenMs, viewable, look = {}) {
    const id = nextId++;
    shots.set(id, {
      id, path: `C:/${rootId}/${name}`, root_id: rootId, name, ext,
      size: 120000 + id * 37000, taken_ms: takenMs, created_ms: null, modified_ms: null,
      date_source: "filename", status: "pending", decided_ms: null,
      missing: false, viewable,
    });
    looks.set(`C:/${rootId}/${name}`, { hue: 210, w: 2000, h: 1500, kind: "desktop", ...look });
    return id;
  }

  const looks = new Map();
  const A = 1, B = 2;
  const roots = [
    { id: A, path: "C:/Users/me/Pictures/Screenshots", last_scan_ms: Date.UTC(2026, 8, 30, 9) },
    { id: B, path: "D:/Archive/shots-b", last_scan_ms: Date.UTC(2026, 8, 29, 18) },
  ];
  const sept = Date.UTC(2026, 8, 14);
  const aug = Date.UTC(2026, 7, 19);
  // Deliberately seeded out of id order so the taken_ms sort is exercised.
  addShot(A, "Screenshot 2026-09-14 21-15-41.png", "png", sept + 2000, true, { hue: 152, kind: "chat", w: 1080, h: 2340 });
  addShot(A, "Screenshot 2026-09-02 09-03-11.png", "png", sept - 86400000 * 12, true, { hue: 216, kind: "desktop" });
  addShot(A, "Screenshot 2026-09-14 21-14-05.png", "png", sept + 1000, true, { hue: 268, kind: "code", w: 1920, h: 1080 });
  addShot(A, "IMG_20260816_120000.heic", "heic", aug, false);
  addShot(B, "Screenshot 2026-08-19 18-22-30.png", "png", aug + 1000, true, { hue: 24, kind: "desktop", w: 1600, h: 1000 });
  addShot(B, "Screenshot 2026-08-19 18-24-02.png", "png", aug + 2000, true, { hue: 330, kind: "chat", w: 1170, h: 2532 });

  // The month key the backend produces: local-time year-month.
  function monthKey(ms) {
    const l = new Date(ms + (-new Date().getTimezoneOffset() * 60000));
    return l.getUTCFullYear() + "-" + String(l.getUTCMonth() + 1).padStart(2, "0");
  }
  const all = () => [...shots.values()];
  const inRoot = (rootId) => (rootId == null ? all() : all().filter((s) => s.root_id === rootId));
  const present = (list) => list.filter((s) => !s.missing);
  const count = (list, st) => list.filter((s) => s.status === st).length;
  const bytes = (list, st) => list.filter((s) => !st || s.status === st).reduce((n, s) => n + s.size, 0);
  const byTaken = (dir) => (x, y) => dir * (x.taken_ms - y.taken_ms || x.id - y.id);

  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.splice(0, undoStack.length - UNDO_LIMIT);
  }

  // Deterministic "random" order, so a test can rely on it.
  function shuffled(list) {
    const out = list.slice();
    let seed = 7;
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      const j = Math.floor((seed / 233280) * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  const handlers = {
    app_info: () => ({
      data_dir: "C:/fake", db_path: "C:/fake/sifter.db", log_path: "C:/fake/logs/sifter.log",
      schema_version: 1, app_version: "1.0.0", image_exts: ["png"], unviewable_exts: ["heic"],
    }),
    list_roots: () => roots
      .slice()
      .sort((x, y) => (y.last_scan_ms || 0) - (x.last_scan_ms || 0) || x.path.localeCompare(y.path))
      .map((r) => {
        const mine = inRoot(r.id);
        return {
          ...r, total: mine.length, pending: count(mine, "pending"), kept: count(mine, "kept"),
          deleted: count(mine, "deleted"), skipped: count(mine, "skipped"), staged: count(mine, "staged"),
          missing: mine.filter((s) => s.missing).length,
        };
      }),
    summary: (a) => {
      if (faults.summary) {
        faults.summary = false;
        throw new Error("simulated summary failure");
      }
      const mine = inRoot(a.rootId);
      const live = present(mine);
      return {
        total: live.length, pending: count(live, "pending"), staged: count(live, "staged"),
        // Global, because staged_list and commit_deletes ignore the root filter.
        staged_all: count(all(), "staged"), bytes_staged_all: bytes(all(), "staged"),
        kept: count(live, "kept"), deleted: count(live, "deleted"), skipped: count(live, "skipped"),
        missing: mine.filter((s) => s.missing).length,
        bytes_pending: bytes(live, "pending"), bytes_total: bytes(live), bytes_deleted: bytes(live, "deleted"),
        months: new Set(live.map((s) => monthKey(s.taken_ms))).size,
      };
    },
    months: (a) => {
      const by = new Map();
      for (const s of present(inRoot(a.rootId))) {
        const k = monthKey(s.taken_ms);
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(s);
      }
      return [...by.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([month, list]) => ({
        month, total: list.length,
        // Like db.rs: only keep/delete are final answers.
        reviewed: count(list, "kept") + count(list, "deleted"),
        kept: count(list, "kept"), deleted: count(list, "deleted"),
        skipped: count(list, "skipped"), staged: count(list, "staged"),
        remaining: count(list, "pending"),
      }));
    },
    month_thumbs: (a) => {
      const by = new Map();
      for (const s of present(inRoot(a.rootId)).sort(byTaken(-1))) {
        const k = monthKey(s.taken_ms);
        if (!by.has(k)) by.set(k, []);
        if (by.get(k).length < (a.limit || 5)) by.get(k).push(s.path);
      }
      return [...by.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([month, paths]) => ({ month, paths }));
    },
    queue_ids: (a) => {
      let out = inRoot(a.rootId);
      if (a.scope !== "staged") out = present(out);
      switch (a.scope) {
        case "month": out = out.filter((s) => s.status === "pending" && monthKey(s.taken_ms) === a.month).sort(byTaken(1)); break;
        case "unreviewed": out = out.filter((s) => s.status === "pending").sort(byTaken(-1)); break;
        case "random": out = shuffled(out.filter((s) => s.status === "pending").sort(byTaken(1))); break;
        case "skipped": out = out.filter((s) => s.status === "skipped").sort(byTaken(1)); break;
        case "staged": out = out.filter((s) => s.status === "staged").sort(byTaken(1)); break;
        default: throw new Error("invalid queue scope: " + a.scope);
      }
      return out.map((s) => s.id);
    },
    items: (a) => a.ids.map((id) => shots.get(id)).filter(Boolean).map((s) => ({ ...s })),
    decide: (a) => {
      if (faults.decide) throw new Error("simulated write failure");
      const s = shots.get(a.id);
      if (!s) throw new Error("no such id " + a.id);
      const status = { keep: "kept", skip: "skipped", delete: "staged" }[a.kind];
      if (!status) throw new Error("invalid decision: " + a.kind);
      pushUndo({ id: s.id, prev: s.status, prev_decided_ms: s.decided_ms, next: status });
      s.status = status;
      s.decided_ms = Date.UTC(2026, 8, 30);
      LOG.push("decide:" + a.kind + ":" + s.name);
      return { ...s };
    },
    undo_last: () => {
      // The session-wide stack can hold an id from another queue entirely.
      if (faults.undoOutOfScope) {
        faults.undoOutOfScope = false;
        const other = all().find((s) => s.root_id === B);
        if (other) {
          other.status = "pending";
          other.decided_ms = null;
          LOG.push("undo:out-of-scope:" + other.name);
          return { ...other };
        }
      }
      // Like undo.rs: discard entries whose row changed since (a commit moved
      // it to the Recycle Bin, say). A deleted row is never resurrected.
      while (undoStack.length) {
        const e = undoStack.pop();
        const s = shots.get(e.id);
        if (!s || s.status !== e.next || s.status === "deleted") continue;
        s.status = e.prev;
        s.decided_ms = e.prev_decided_ms;
        LOG.push("undo:" + s.name);
        return { ...s };
      }
      return null;
    },
    unstage: (a) => {
      const s = shots.get(a.id);
      if (!s) throw new Error("no such id " + a.id);
      pushUndo({ id: s.id, prev: s.status, prev_decided_ms: s.decided_ms, next: "pending" });
      s.status = "pending";
      s.decided_ms = null;
      LOG.push("unstage:" + s.name);
      return { ...s };
    },
    staged_list: () => all().filter((s) => s.status === "staged").sort(byTaken(1)).map((s) => ({ ...s })),
    commit_deletes: () => {
      const staged = all().filter((s) => s.status === "staged");
      const moved = staged.filter((s) => !s.__failCommit);
      const failed = staged.filter((s) => s.__failCommit).map((s) => ({ id: s.id, name: s.name, error: "simulated: the file is in use", gone: false }));
      for (const s of moved) {
        s.status = "deleted";
        s.decided_ms = Date.UTC(2026, 8, 30);
      }
      const ids = new Set(moved.map((s) => s.id));
      for (let i = undoStack.length - 1; i >= 0; i--) if (ids.has(undoStack[i].id)) undoStack.splice(i, 1);
      LOG.push("commit:" + moved.length);
      return { deleted: moved.length, failed, still_staged: failed.length, bytes_freed: bytes(moved) };
    },
    // Mirrors the real command: scanning is what adds the root to the database.
    scan_root: (a) => {
      let root = roots.find((r) => r.path === a.path);
      if (!root) {
        root = { id: roots.length + 1, path: a.path, last_scan_ms: Date.now() };
        roots.push(root);
      } else {
        root.last_scan_ms = Date.now();
      }
      LOG.push("scan:" + a.path);
      const n = inRoot(root.id).length;
      return { root: a.path, found: n, added: 0, refreshed: n, skipped_other: 2, unreadable: 0, unviewable: 1, missing: 0, total_in_root: n, elapsed_ms: 12 };
    },
    forget_root: (a) => {
      const at = roots.findIndex((r) => r.id === a.rootId);
      if (at === -1) throw new Error("no such folder");
      roots.splice(at, 1);
      for (const s of all()) if (s.root_id === a.rootId) shots.delete(s.id);
      for (let i = undoStack.length - 1; i >= 0; i--) if (!shots.has(undoStack[i].id)) undoStack.splice(i, 1);
      LOG.push("forget:" + a.rootId);
      return null;
    },
    pick_folder: () => window.__pickFolder ?? "C:/Users/me/Pictures/Screenshots",
    open_devtools: () => { LOG.push("devtools"); return null; },
    log_read: () => "[2026-09-30 10:00:00.000] INFO  [boot] fake log line",
    log_write: (a) => { UI_LOG.push(a); return null; },
  };

  window.__FAILS = FAILS;
  window.__LOG = LOG;
  window.__UI_LOG = UI_LOG;
  window.__shots = shots;
  window.__faults = faults;
  window.addEventListener("error", (e) => FAILS.push("window error: " + e.message));
  window.addEventListener("unhandledrejection", (e) => FAILS.push("unhandled rejection: " + ((e.reason && e.reason.message) || e.reason)));

  // ---- events (window.__TAURI__.event) ----
  const listeners = {};
  function emit(name, payload) {
    for (const cb of listeners[name] || []) cb({ event: name, payload });
  }

  // ---- fake screenshots ----
  // Every path gets its own picture, so a test (or a person) can tell cards
  // apart, and the sizes vary so letterboxing is exercised both ways.
  const images = new Map();
  function render(path) {
    const look = looks.get(path) || { hue: 210, w: 1600, h: 1000, kind: "desktop" };
    const c = document.createElement("canvas");
    c.width = look.w;
    c.height = look.h;
    const g = c.getContext("2d");
    const W = look.w, H = look.h, u = Math.min(W, H) / 100;
    const hue = look.hue;
    const box = (x, y, w, h, color, r = u) => {
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(x, y, w, h, r);
      g.fill();
    };
    if (look.kind === "chat") {
      g.fillStyle = `hsl(${hue} 35% 96%)`;
      g.fillRect(0, 0, W, H);
      box(0, 0, W, H * 0.09, `hsl(${hue} 55% 42%)`, 0);
      g.fillStyle = "#fff";
      g.font = `600 ${u * 5}px sans-serif`;
      g.fillText("Group chat", u * 8, H * 0.06);
      let y = H * 0.13;
      for (let i = 0; i < 9; i++) {
        const mine = i % 3 === 1;
        const w = W * (0.38 + ((i * 37) % 30) / 100);
        box(mine ? W - w - u * 6 : u * 6, y, w, H * 0.055, mine ? `hsl(${hue} 60% 55%)` : "#fff", u * 4);
        y += H * 0.075;
      }
    } else if (look.kind === "code") {
      g.fillStyle = `hsl(${hue} 25% 13%)`;
      g.fillRect(0, 0, W, H);
      box(0, 0, W * 0.2, H, `hsl(${hue} 22% 17%)`, 0);
      for (let i = 0; i < 22; i++) {
        const y = H * 0.08 + i * H * 0.04;
        box(W * 0.24 + (i % 4) * u * 4, y, W * (0.12 + ((i * 53) % 40) / 100), H * 0.018, `hsl(${(hue + i * 29) % 360} 60% 66%)`, u * 0.6);
        box(W * 0.03, y, W * (0.08 + (i % 3) * 0.03), H * 0.016, `hsl(${hue} 15% 40%)`, u * 0.6);
      }
    } else {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, `hsl(${hue} 70% 62%)`);
      grad.addColorStop(1, `hsl(${(hue + 40) % 360} 65% 45%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      box(W * 0.08, H * 0.1, W * 0.84, H * 0.78, "rgba(255,255,255,.94)", u * 2);
      box(W * 0.08, H * 0.1, W * 0.84, H * 0.07, `hsl(${hue} 30% 92%)`, u * 2);
      for (let i = 0; i < 3; i++) box(W * 0.1 + i * u * 4, H * 0.125, u * 2.4, u * 2.4, ["#ef6b5f", "#f5be4f", "#5ec554"][i], u * 2);
      box(W * 0.11, H * 0.22, W * 0.2, H * 0.6, `hsl(${hue} 30% 95%)`, u);
      for (let i = 0; i < 6; i++) box(W * 0.34, H * (0.23 + i * 0.09), W * (0.3 + ((i * 41) % 25) / 100), H * 0.05, `hsl(${hue} 40% ${84 - i * 3}%)`, u);
    }
    g.fillStyle = look.kind === "code" ? "rgba(255,255,255,.88)" : "rgba(10,14,21,.78)";
    g.font = `700 ${u * 4.2}px sans-serif`;
    g.fillText(path.split("/").pop().replace(/\.\w+$/, ""), u * 6, H - u * 6);
    return c.toDataURL("image/jpeg", 0.88);
  }

  window.__TAURI__ = {
    core: {
      convertFileSrc: (p) => {
        if (!images.has(p)) images.set(p, render(p));
        return images.get(p);
      },
      invoke: async (cmd, args = {}) => {
        LOG.push("invoke:" + cmd);
        const fn = handlers[cmd];
        if (!fn) throw new Error("unmocked command: " + cmd);
        if (cmd === "scan_root" && faults.scanDelayMs) {
          // A slow scan reports progress the way scan_root's events do.
          for (const found of [37, 412, 1280]) {
            await new Promise((r) => setTimeout(r, faults.scanDelayMs / 4));
            emit("scan-progress", { path: args.path, found });
          }
          await new Promise((r) => setTimeout(r, faults.scanDelayMs / 4));
        }
        return fn(args);
      },
    },
    event: {
      listen: async (name, cb) => {
        (listeners[name] ||= []).push(cb);
        return () => { listeners[name] = listeners[name].filter((x) => x !== cb); };
      },
    },
  };

  window.__fake = {
    roots, shots, undoStack, faults, LOG, UI_LOG,
    resetShots() {
      for (const s of shots.values()) {
        s.status = "pending";
        s.decided_ms = null;
        s.missing = false;
        delete s.__failCommit;
      }
      undoStack.length = 0;
    },
  };
})();
