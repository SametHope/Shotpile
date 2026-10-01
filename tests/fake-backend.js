// In-memory stand-in for the Rust command surface, loaded before src/app.js by
// tests/serve.cjs. It mirrors src-tauri/src/{db,commands,undo}.rs closely enough
// that the GUI test exercises the real app logic: same statuses, same queue
// orders, the same undo-stack rules (stale entries skipped, committed files
// never resurrected), missing files kept out of review queues.
//
// Also used by `npm run preview` to click through the UI without Rust.
//
// Default data is the GUI test's fixture:
//   Root A: 3 PNGs in 2026-09 + 1 unviewable HEIC in 2026-08.
//   Root B: 2 PNGs in 2026-08, used to prove staged counts are global.
// With `?demo` in the URL it seeds a realistic library instead (two folders,
// ~130 screenshots over seven months, some already sorted), which is what
// `npm run preview` and the README screenshots (tools/screenshots.cjs) use.
(function () {
  "use strict";

  const LOG = []; // command trace the test asserts on
  const FAILS = []; // page errors, collected for the test
  const UI_LOG = []; // entries the frontend forwarded through log_write
  let nextId = 1;
  const shots = new Map();
  const undoStack = [];
  const redoStack = [];
  const UNDO_LIMIT = 200;

  // Fault injection, for the edge cases the logic tests cannot reach.
  const faults = { decide: false, summary: false, undoOutOfScope: false, scanDelayMs: 0, itemsDelayMs: 0, commitDelayMs: 0 };

  function addShot(rootId, name, ext, takenMs, viewable, look = {}, extra = {}) {
    const id = nextId++;
    shots.set(id, {
      id, path: `C:/${rootId}/${name}`, root_id: rootId, name, ext,
      size: 120000 + id * 37000, taken_ms: takenMs, created_ms: null, modified_ms: null,
      date_source: "filename", status: "pending", decided_ms: null,
      missing: false, viewable, ...extra,
    });
    looks.set(`C:/${rootId}/${name}`, { hue: 210, w: 2000, h: 1500, kind: "desktop", ...look });
    return id;
  }

  const looks = new Map();
  const A = 1, B = 2;
  const roots = [];
  const DEMO = (() => {
    try {
      return new URLSearchParams(location.search).has("demo");
    } catch {
      return false;
    }
  })();
  if (DEMO) seedDemo();
  else seedFixture();

  function seedFixture() {
    roots.push(
      { id: A, path: "C:/Users/me/Pictures/Screenshots", last_scan_ms: Date.UTC(2026, 8, 30, 9) },
      { id: B, path: "D:/Archive/shots-b", last_scan_ms: Date.UTC(2026, 8, 29, 18) },
    );
    const sept = Date.UTC(2026, 8, 14);
    const aug = Date.UTC(2026, 7, 19);
    // Deliberately seeded out of id order so the taken_ms sort is exercised.
    addShot(A, "Screenshot 2026-09-14 21-15-41.png", "png", sept + 2000, true, { hue: 152, kind: "chat", w: 1080, h: 2340 });
    addShot(A, "Screenshot 2026-09-02 09-03-11.png", "png", sept - 86400000 * 12, true, { hue: 216, kind: "desktop" });
    addShot(A, "Screenshot 2026-09-14 21-14-05.png", "png", sept + 1000, true, { hue: 268, kind: "code", w: 1920, h: 1080 });
    addShot(A, "IMG_20260816_120000.heic", "heic", aug, false);
    addShot(B, "Screenshot 2026-08-19 18-22-30.png", "png", aug + 1000, true, { hue: 24, kind: "desktop", w: 1600, h: 1000 });
    addShot(B, "Screenshot 2026-08-19 18-24-02.png", "png", aug + 2000, true, { hue: 330, kind: "chat", w: 1170, h: 2532 });
  }

  // A library that looks lived-in: realistic names from the usual tools,
  // a mix of desktop and phone shots, and some months already sorted.
  // Deterministic (seeded), so screenshots regenerate identically.
  function seedDemo() {
    const now = Date.now();
    roots.push(
      { id: A, path: "C:/Users/me/Pictures/Screenshots", last_scan_ms: now - 2 * 3600000 },
      { id: B, path: "D:/Captures/Desktop", last_scan_ms: now - 3 * 86400000 },
    );
    let seed = 20260968;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const p2 = (n) => String(n).padStart(2, "0");
    const hues = [214, 152, 262, 24, 330, 190, 45, 352, 120];
    const kinds = [
      { kind: "desktop", w: 1920, h: 1080, mb: [0.3, 1.2] },
      { kind: "code", w: 1920, h: 1080, mb: [0.4, 1.1] },
      { kind: "chat", w: 1080, h: 2340, mb: [0.2, 0.7] },
      { kind: "chart", w: 1600, h: 1000, mb: [0.3, 0.9] },
      { kind: "photo", w: 1920, h: 1080, mb: [1.1, 3.2] },
      { kind: "doc", w: 1240, h: 1754, mb: [0.2, 0.6] },
    ];
    const name = (kind, d) => {
      const [y, mo, dd, hh, mi, ss] = [d.getFullYear(), p2(d.getMonth() + 1), p2(d.getDate()), p2(d.getHours()), p2(d.getMinutes()), p2(d.getSeconds())];
      if (kind === "chat") return `Screenshot_${y}${mo}${dd}-${hh}${mi}${ss}_${pick(["WhatsApp", "Messages", "Chrome", "Instagram"])}.jpg`;
      if (kind === "photo") return `Snipaste_${y}-${mo}-${dd}_${hh}-${mi}-${ss}.png`;
      if (kind === "doc") return `CleanShot ${y}-${mo}-${dd} at ${hh}.${mi}.${ss}.png`;
      return `Screenshot ${y}-${mo}-${dd} ${hh}${mi}${ss}.png`;
    };
    // [root, year, month, how many, decisions already made (the rest pending)]
    const plan = [
      [A, 2026, 9, 18, { kept: 3, staged: 2, skipped: 1 }],
      [A, 2026, 8, 24, { kept: 15, deleted: 6, staged: 3 }],
      [A, 2026, 7, 31, { kept: 12, deleted: 9, skipped: 2 }],
      [A, 2026, 6, 9, { kept: 6, deleted: 3 }],
      [A, 2026, 5, 14, {}],
      [A, 2025, 12, 7, { kept: 4, deleted: 3 }],
      [A, 2025, 11, 12, { kept: 2 }],
      [B, 2026, 9, 6, { kept: 1 }],
      [B, 2026, 4, 11, { kept: 5, deleted: 6 }],
    ];
    for (const [root, year, month, n, decided] of plan) {
      const times = [];
      for (let i = 0; i < n; i++) {
        times.push(new Date(year, month - 1, 1 + Math.floor(rand() * 27), 8 + Math.floor(rand() * 15), Math.floor(rand() * 60), Math.floor(rand() * 60)).getTime());
      }
      times.sort((x, y) => x - y);
      // The oldest ones are the ones already sorted, as after a real session.
      const statuses = [];
      for (const [status, k] of Object.entries(decided)) for (let i = 0; i < k; i++) statuses.push(status);
      for (let i = statuses.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [statuses[i], statuses[j]] = [statuses[j], statuses[i]];
      }
      times.forEach((t, i) => {
        const status = statuses[i] || "pending";
        // Now and then a phone photo in a format WebView2 cannot show.
        if (rand() < 0.04) {
          addShot(root, `IMG_${new Date(t).getFullYear()}${p2(new Date(t).getMonth() + 1)}${p2(new Date(t).getDate())}_${p2(new Date(t).getHours())}${p2(new Date(t).getMinutes())}00.heic`, "heic", t, false, {}, {
            size: Math.round((1.4 + rand() * 1.8) * 1048576), status, decided_ms: status === "pending" ? null : t + 86400000,
          });
          return;
        }
        const k = pick(kinds);
        const file = name(k.kind, new Date(t));
        addShot(root, file, file.split(".").pop(), t, true, { kind: k.kind, w: k.w, h: k.h, hue: pick(hues) }, {
          size: Math.round((k.mb[0] + rand() * (k.mb[1] - k.mb[0])) * 1048576),
          status,
          decided_ms: status === "pending" ? null : t + 86400000,
        });
      });
    }
  }

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
    redoStack.length = 0;
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
      data_dir: "C:/fake", db_path: "C:/fake/shotpile.db", log_path: "C:/fake/logs/shotpile.log",
      schema_version: 1, app_version: "1.0.0", image_exts: ["png"], unviewable_exts: ["heic"],
      tauri_version: "2.11.6", webview_version: "131.0.2903.70", sqlite_version: "3.50.4",
      trash_name: "Recycle Bin", file_manager: "File Explorer",
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
        // The pile follows the folder, like staged_list and commit_deletes,
        // and keeps missing files: the commit still has to settle them.
        pile: count(mine, "staged"), bytes_pile: bytes(mine, "staged"),
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
      // Like db.rs: files on disk only, so nothing already in the Recycle Bin.
      for (const s of present(inRoot(a.rootId)).filter((x) => x.status !== "deleted").sort(byTaken(-1))) {
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
      if (!s) throw new Error("no such screenshot: " + a.id);
      const status = { keep: "kept", skip: "skipped", delete: "staged" }[a.kind];
      if (!status) throw new Error("invalid decision: " + a.kind);
      // Like apply_decision: a committed file is in the Recycle Bin.
      if (s.status === "deleted") throw new Error(s.name + " is already in the Recycle Bin");
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
        redoStack.push({ ...e, next_decided_ms: s.decided_ms });
        s.status = e.prev;
        s.decided_ms = e.prev_decided_ms;
        LOG.push("undo:" + s.name);
        return { ...s };
      }
      return null;
    },
    // Like apply_redo: the mirror rule, the row must still show `prev`.
    redo_last: () => {
      while (redoStack.length) {
        const e = redoStack.pop();
        const s = shots.get(e.id);
        if (!s || s.status !== e.prev || s.status === "deleted") continue;
        s.status = e.next;
        s.decided_ms = e.next_decided_ms;
        undoStack.push(e);
        LOG.push("redo:" + s.name);
        return { ...s };
      }
      return null;
    },
    reveal: (a) => { LOG.push("reveal:" + a.target + (a.id != null ? ":" + a.id : "")); return null; },
    // The real command zooms the WebView; CSS zoom is the closest stand-in.
    set_zoom: (a) => { document.documentElement.style.zoom = String(a.factor); LOG.push("zoom:" + a.factor); return null; },
    app_ready: () => { LOG.push("ready"); return null; },
    unstage: (a) => {
      const s = shots.get(a.id);
      if (!s) throw new Error("no such screenshot: " + a.id);
      // Like apply_unstage: only a staged row changes.
      if (s.status === "deleted") throw new Error(s.name + " is already in the Recycle Bin");
      if (s.status !== "staged") return { ...s };
      pushUndo({ id: s.id, prev: s.status, prev_decided_ms: s.decided_ms, next: "pending" });
      s.status = "pending";
      s.decided_ms = null;
      LOG.push("unstage:" + s.name);
      return { ...s };
    },
    unstage_multiple: (a) => {
      let count = 0;
      for (const id of a.ids) {
        const s = shots.get(id);
        if (!s) continue;
        // Like apply_unstage: only a staged row changes.
        if (s.status === "deleted" || s.status !== "staged") continue;
        pushUndo({ id: s.id, prev: s.status, prev_decided_ms: s.decided_ms, next: "pending" });
        s.status = "pending";
        s.decided_ms = null;
        LOG.push("unstage:" + s.name);
        count += 1;
      }
      return count;
    },
    staged_list: (a) => inRoot(a.rootId).filter((s) => s.status === "staged").sort(byTaken(1)).map((s) => ({ ...s })),
    commit_deletes: (a) => {
      const staged = inRoot(a.rootId).filter((s) => s.status === "staged");
      const moved = staged.filter((s) => !s.__failCommit);
      const failed = staged.filter((s) => s.__failCommit).map((s) => ({ id: s.id, name: s.name, error: "simulated: the file is in use", gone: false }));
      for (const s of moved) {
        s.status = "deleted";
        s.decided_ms = Date.UTC(2026, 8, 30);
      }
      const ids = new Set(moved.map((s) => s.id));
      for (let i = undoStack.length - 1; i >= 0; i--) if (ids.has(undoStack[i].id)) undoStack.splice(i, 1);
      for (let i = redoStack.length - 1; i >= 0; i--) if (ids.has(redoStack[i].id)) redoStack.splice(i, 1);
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
      return { root: a.path, found: n, added: 0, refreshed: n, restored: 0, skipped_other: 2, unreadable: 0, unviewable: 1, missing: 0, total_in_root: n, elapsed_ms: 12 };
    },
    forget_root: (a) => {
      const at = roots.findIndex((r) => r.id === a.rootId);
      if (at === -1) throw new Error("no such folder");
      roots.splice(at, 1);
      for (const s of all()) if (s.root_id === a.rootId) shots.delete(s.id);
      for (let i = undoStack.length - 1; i >= 0; i--) if (!shots.has(undoStack[i].id)) undoStack.splice(i, 1);
      for (let i = redoStack.length - 1; i >= 0; i--) if (!shots.has(redoStack[i].id)) redoStack.splice(i, 1);
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
    } else if (look.kind === "chart") {
      // A dashboard: sidebar, three figures, a bar chart.
      g.fillStyle = "#f3f5f9";
      g.fillRect(0, 0, W, H);
      box(0, 0, W * 0.17, H, `hsl(${hue} 32% 20%)`, 0);
      for (let i = 0; i < 6; i++) box(W * 0.025, H * (0.12 + i * 0.07), W * 0.11, H * 0.025, `hsl(${hue} 20% ${i ? 40 : 70}%)`, u * 0.6);
      for (let i = 0; i < 3; i++) {
        box(W * 0.21 + i * W * 0.26, H * 0.07, W * 0.235, H * 0.17, "#fff", u * 1.5);
        box(W * 0.23 + i * W * 0.26, H * 0.11, W * 0.08, H * 0.025, "#c9cfd8", u * 0.5);
        box(W * 0.23 + i * W * 0.26, H * 0.16, W * 0.12, H * 0.045, `hsl(${(hue + i * 50) % 360} 60% 48%)`, u * 0.6);
      }
      box(W * 0.21, H * 0.29, W * 0.755, H * 0.64, "#fff", u * 1.5);
      for (let i = 0; i < 12; i++) {
        const bh = H * (0.12 + (((i * 37) + hue) % 38) / 100);
        box(W * 0.25 + i * W * 0.058, H * 0.88 - bh, W * 0.036, bh, `hsl(${hue} 62% ${46 + (i % 3) * 9}%)`, u * 0.6);
      }
    } else if (look.kind === "photo") {
      // A landscape: sky, sun, two ridges.
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, `hsl(${hue} 55% 62%)`);
      sky.addColorStop(1, `hsl(${(hue + 35) % 360} 70% 86%)`);
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      g.fillStyle = "rgba(255,244,214,.92)";
      g.beginPath();
      g.arc(W * 0.7, H * 0.32, u * 7, 0, Math.PI * 2);
      g.fill();
      const ridge = (base, amp, color, phase) => {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W; x += W / 48) {
          g.lineTo(x, base + Math.sin((x / W) * Math.PI * 3 + phase) * amp + Math.sin((x / W) * Math.PI * 8 + phase * 2) * amp * 0.3);
        }
        g.lineTo(W, H);
        g.closePath();
        g.fill();
      };
      ridge(H * 0.56, H * 0.08, `hsl(${(hue + 190) % 360} 22% 46%)`, hue / 40);
      ridge(H * 0.7, H * 0.07, `hsl(${(hue + 170) % 360} 28% 28%)`, hue / 25);
    } else if (look.kind === "doc") {
      // A page: title, paragraphs, a highlighted box.
      g.fillStyle = "#e7eaf0";
      g.fillRect(0, 0, W, H);
      box(W * 0.07, H * 0.04, W * 0.86, H * 0.92, "#fff", u * 0.8);
      box(W * 0.13, H * 0.09, W * 0.48, H * 0.028, `hsl(${hue} 45% 32%)`, u * 0.5);
      for (let i = 0; i < 24; i++) {
        if (i % 6 === 5) continue;
        box(W * 0.13, H * (0.16 + i * 0.026), W * (0.58 + ((i * 31) % 17) / 100), H * 0.01, "#cbd1da", u * 0.4);
      }
      box(W * 0.13, H * 0.82, W * 0.34, H * 0.08, `hsl(${hue} 60% 93%)`, u);
    } else {
      // An app window on a wallpaper, with Windows title-bar buttons.
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, `hsl(${hue} 70% 62%)`);
      grad.addColorStop(1, `hsl(${(hue + 40) % 360} 65% 45%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      box(W * 0.08, H * 0.1, W * 0.84, H * 0.78, "rgba(255,255,255,.95)", u * 1.2);
      box(W * 0.08, H * 0.1, W * 0.84, H * 0.07, `hsl(${hue} 25% 93%)`, u * 1.2);
      for (let i = 0; i < 3; i++) box(W * 0.89 - i * u * 6, H * 0.125, u * 2.6, u * 0.5 + (i === 1 ? u * 2 : 0), "#5b6474", u * 0.3);
      box(W * 0.11, H * 0.22, W * 0.2, H * 0.6, `hsl(${hue} 30% 95%)`, u);
      for (let i = 0; i < 6; i++) box(W * 0.34, H * (0.23 + i * 0.09), W * (0.3 + ((i * 41) % 25) / 100), H * 0.05, `hsl(${hue} 40% ${84 - i * 3}%)`, u);
    }
    if (!DEMO) {
      // The test fixture writes each file's name on it, so cards are easy to
      // tell apart when a test fails.
      g.fillStyle = look.kind === "code" ? "rgba(255,255,255,.88)" : "rgba(10,14,21,.78)";
      g.font = `700 ${u * 4.2}px sans-serif`;
      g.fillText(path.split("/").pop().replace(/\.\w+$/, ""), u * 6, H - u * 6);
    }
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
        if (cmd === "items" && faults.itemsDelayMs) await new Promise((r) => setTimeout(r, faults.itemsDelayMs));
        if (cmd === "commit_deletes" && faults.commitDelayMs) await new Promise((r) => setTimeout(r, faults.commitDelayMs));
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
    roots, shots, undoStack, redoStack, faults, LOG, UI_LOG,
    resetShots() {
      for (const s of shots.values()) {
        s.status = "pending";
        s.decided_ms = null;
        s.missing = false;
        delete s.__failCommit;
      }
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
})();
