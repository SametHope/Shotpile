/**
 * Screenshot Sifter — UI controller.
 *
 * All filesystem, database and Recycle Bin work happens in Rust behind the
 * commands in src-tauri/src/commands.rs. This file only orchestrates views,
 * gestures and keyboard input.
 */

import {
  ACTION,
  DATE_SOURCE_LABELS,
  GESTURE_THRESHOLD,
  ReviewQueue,
  classifyGesture,
  exitVector,
  formatBytes,
  formatDateTime,
  gestureVisual,
  monthLabel,
  progressOf,
  tzOffsetMinutes,
} from "./logic.js";

const { invoke } = window.__TAURI__.core;
const convertFileSrc = window.__TAURI__.core.convertFileSrc;

const el = {
  view: document.getElementById("view"),
  back: document.getElementById("btn-back"),
  scan: document.getElementById("btn-scan"),
  folder: document.getElementById("btn-folder"),
  stagedBtn: document.getElementById("btn-staged"),
  scannedNote: document.getElementById("scanned-note"),
  footbar: document.getElementById("footbar"),
  stagedN: document.getElementById("staged-n"),
  commit: document.getElementById("btn-commit"),
  undo: document.getElementById("btn-undo"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalFoot: document.getElementById("modal-foot"),
  toast: document.getElementById("toast"),
};

const state = {
  view: "loading", // loading | setup | months | review | staged
  info: null,
  roots: [],
  rootId: null,
  months: [],
  summary: null,
  queue: new ReviewQueue(),
  cache: new Map(), // id -> shot
  scope: null, // { scope, month }
  card: null, // current shot
  drag: null,
  busy: false,
  toastTimer: null,
};

// ---------------------------------------------------------------- tauri glue

async function api(cmd, args = {}) {
  return invoke(cmd, args);
}

function tzArgs() {
  return { rootId: state.rootId ?? null, tz: tzOffsetMinutes() };
}

async function refreshCounts() {
  state.summary = await api("summary", tzArgs());
  const staged = state.summary.staged || 0;
  el.stagedN.textContent = String(staged);
  el.footbar.hidden = staged === 0;
  el.stagedBtn.hidden = staged === 0;
  el.stagedBtn.textContent = `Silinecekler (${staged})`;
}

// ------------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(message, { action, onAction, ms = 4200 } = {}) {
  const msg = el.toast.querySelector(".msg");
  const btn = el.toast.querySelector("button");
  msg.textContent = message;
  clearTimeout(state.toastTimer);
  if (action) {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => {
      hideToast();
      onAction?.();
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  el.toast.classList.add("on");
  state.toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  el.toast.classList.remove("on");
  clearTimeout(state.toastTimer);
}

function modal({ title, body, actions }) {
  el.modalTitle.textContent = title;
  el.modalBody.replaceChildren(...[body].flat().filter(Boolean));
  el.modalFoot.replaceChildren(
    ...actions.map((a) =>
      h("button", {
        class: `btn ${a.variant || ""}`.trim(),
        onclick: () => {
          closeModal();
          a.onClick?.();
        },
      }, a.label)
    )
  );
  el.modal.hidden = false;
  el.modalFoot.querySelector("button")?.focus();
}

function closeModal() {
  el.modal.hidden = true;
}

el.modal.addEventListener("click", (e) => {
  if (e.target === el.modal) closeModal();
});

function confirmDialog({ title, message, confirmLabel, variant = "danger", extra }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (el.modal.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        done(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    modal({
      title,
      body: [h("div", { text: message }), extra].filter(Boolean),
      actions: [
        { label: "Vazgeç", onClick: () => done(false) },
        { label: confirmLabel, variant, onClick: () => done(true) },
      ],
    });
  });
}

// ----------------------------------------------------------------- data load

async function loadRoots() {
  state.roots = await api("list_roots");
}

async function loadMonths() {
  const [months, summary] = await Promise.all([
    api("months", tzArgs()),
    api("summary", tzArgs()),
  ]);
  state.months = months;
  state.summary = summary;
  await refreshCounts();
}

async function hydrate(ids) {
  const missing = ids.filter((id) => !state.cache.has(id));
  if (missing.length) {
    const rows = await api("items", { ids: missing });
    for (const row of rows) state.cache.set(row.id, row);
  }
  return ids.map((id) => state.cache.get(id)).filter(Boolean);
}

async function openQueue(scope, month = null, label = "") {
  const ids = await api("queue_ids", { scope, month, ...tzArgs() });
  state.cache.clear();
  state.queue = new ReviewQueue(ids);
  state.scope = { scope, month, label };
  if (ids.length === 0) {
    state.view = "months";
    render();
    toast("Bu kuyrukta incelenecek dosya yok");
    return;
  }
  state.view = "review";
  await showCurrent();
}

async function showCurrent() {
  const id = state.queue.current();
  state.card = id === null ? null : state.cache.get(id) || null;
  if (id !== null && !state.card) {
    const [shot] = await hydrate([id]);
    state.card = shot || null;
  }
  render();
  if (id !== null) preload();
}

function preload() {
  const next = state.queue.upcoming(3, 1);
  if (next.length) hydrate(next).catch(() => {});
}

// -------------------------------------------------------------------- render

function render() {
  el.back.hidden = state.view !== "review";
  const busy = state.busy;
  el.scan.disabled = busy;
  el.folder.disabled = busy;
  el.stagedBtn.hidden = (state.summary?.staged || 0) === 0;

  if (state.view === "loading") {
    el.view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "busy" })));
    return;
  }
  if (state.view === "setup") return renderSetup();
  if (state.view === "months") return renderMonths();
  if (state.view === "review") return renderReview();
  if (state.view === "staged") return renderStaged();
}

function renderSetup() {
  const nodes = [
    h("div", { class: "empty" },
      h("h2", { text: "Ekran görüntülerini incelemeye başla" }),
      h("p", { text: "Bir klasör seç. Aylara göre ya da rastgele sırayla gez, beğenmediklerini geri dönüşüm kutusuna taşı." }),
      h("button", { class: "btn primary", onclick: addFolder }, "Klasör seç")
    ),
  ];

  if (state.roots.length) {
    nodes.push(h("div", { class: "panel", style: "padding:14px" },
      h("div", { class: "hint", style: "margin-bottom:8px", text: "Kayıtlı klasörler" }),
      h("div", { class: "staged-list" }, state.roots.map(rootRow))
    ));
  }
  el.view.replaceChildren(...nodes);
}

function rootRow(root) {
  return h("div", { class: "root" },
    h("div", { style: "flex:1;min-width:0" },
      h("div", { class: "path", text: root.path }),
      h("div", { class: "meta", text: root.total === 0
        ? "henüz taranmadı"
        : `${root.total} dosya · ${root.pending} bekliyor${root.staged ? ` · ${root.staged} silinmeyi bekliyor` : ""}${root.last_scan_ms ? ` · son tarama ${formatDateTime(root.last_scan_ms)}` : ""}` })
    ),
    h("button", {
      class: "btn primary sm",
      onclick: () => selectRoot(root),
    }, root.total === 0 ? "Tara" : "Aç")
  );
}

function renderMonths() {
  const s = state.summary;
  const strip = h("div", { class: "stat-strip" },
    stat(s?.total, "toplam"),
    stat(s?.pending, "bekleyen"),
    stat(s?.kept, "saklanan"),
    stat(s?.deleted, "silinen"),
    stat(s?.skipped, "atlanan"),
    stat(formatBytes(s?.bytes_pending || 0), "bekleyen boyut")
  );

  const actions = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px" },
    h("button", { class: "btn primary", onclick: () => openQueue("unreviewed", null, "Tümü") },
      "İncelenmemişler"),
    h("button", { class: "btn", onclick: () => openQueue("random", null, "Rastgele") }, "Rastgele"),
    h("button", { class: "btn", onclick: () => openQueue("skipped", null, "Atlananlar") }, "Atlananlar"),
    h("button", { class: "btn", onclick: () => openQueue("staged", null, "Silinecekler") }, "Silinecekler")
  );

  const list = state.months.length
    ? h("div", { class: "months" }, state.months.map(monthRow))
    : h("div", { class: "empty" },
        h("h2", { text: "Henüz ekran görüntüsü yok" }),
        h("p", { text: "Klasörü tara." }),
        h("button", { class: "btn primary", onclick: rescan }, "Yeniden tara"));

  el.view.replaceChildren(strip, actions, list);
}

function stat(n, k) {
  return h("div", { class: "stat" }, h("div", { class: "n", text: String(n ?? 0) }), h("div", { class: "k", text: k }));
}

function monthRow(m) {
  const p = progressOf(m);
  const chips = [];
  if (p.kept) chips.push(h("span", { class: "chip kept", text: `${p.kept} saklandı` }));
  if (p.deleted) chips.push(h("span", { class: "chip", text: `${p.deleted} silindi` }));
  if (p.staged) chips.push(h("span", { class: "chip staged", text: `${p.staged} silinmeyi bekliyor` }));
  if (p.skipped) chips.push(h("span", { class: "chip skipped", text: `${p.skipped} atlandı` }));

  return h("button", {
    class: "month",
    disabled: p.total === 0,
    onclick: () => openQueue("month", m.month, monthLabel(m.month)),
  },
    h("div", {},
      h("div", { class: "label", text: monthLabel(m.month) }),
      h("div", { class: "counts", text: `${p.total} dosya` })
    ),
    h("div", { class: "right" },
      p.done
        ? h("span", { class: "done-tag", text: "tamam" })
        : h("span", { text: `${p.remaining} kaldı` })
    ),
    h("div", { class: `bar${p.done ? " complete" : ""}` }, h("i", { style: `width:${Math.round(p.ratio * 100)}%` })),
    chips.length ? h("div", { class: "chips" }, chips) : null
  );
}

function renderReview() {
  const q = state.queue;
  const label = state.scope?.label || "";
  const total = q.length;
  const pos = q.position();

  const head = h("div", { class: "progress-row" },
    h("span", { text: label }),
    h("span", { class: "bar" }, h("i", { style: `width:${total ? Math.round((pos / total) * 100) : 0}%` })),
    h("span", { text: total ? `${pos} / ${total}` : "0 / 0" }),
    q.deferred ? h("span", { class: "chip skipped", text: `${q.deferred} atlandı` }) : null
  );

  let body;
  if (!state.card) {
    body = h("div", { class: "panel finale" },
      h("div", { class: "big", text: String(q.deferred) }),
      h("h2", { text: q.deferred ? "Tüm dosyalar tarandı" : "Bu kuyruk bitti" }),
      h("p", { class: "hint", text: q.deferred ? "Atladıkların aynı turda tekrar karşına çıktı." : "Başka bir ay ya da rastgele mod seçebilirsin." }),
      h("div", { style: "display:flex;gap:8px;justify-content:center;margin-top:12px" },
        h("button", { class: "btn primary", onclick: backToMonths }, "Aylara dön"),
        h("button", { class: "btn", onclick: () => openQueue("random", null, "Rastgele") }, "Rastgele devam")
      )
    );
  } else {
    body = h("div", { class: "stage", id: "stage" }, card(state.card));
  }

  const actions = h("div", { class: "actions" },
    h("button", { class: "btn danger", onclick: () => decide(ACTION.DELETE), title: "←" },
      "Sil ", kbd("←")),
    h("button", { class: "btn", onclick: () => decide(ACTION.SKIP), title: "↑" },
      "Atla ", kbd("↑")),
    h("button", { class: "btn ok", onclick: () => decide(ACTION.KEEP), title: "→" },
      "Sakla ", kbd("→")),
    h("button", { class: "btn ghost", onclick: undo, title: "Ctrl+Z" }, "Geri al ", kbd("Z"))
  );

  el.view.replaceChildren(h("div", { class: "review" }, h("div", { class: "wrap" }, head, body, actions)));
  attachGestures();
}

function kbd(text) {
  return h("kbd", { text });
}

function card(shot) {
  const img = shot.viewable
    ? h("img", { src: convertFileSrc(shot.path), alt: shot.name, draggable: "false" })
    : h("div", { class: "noimg" },
        h("div", { text: `${shot.ext.toUpperCase()} önizlemesi yok` }),
        h("code", { text: "Bu biçim WebView2 ile açılamıyor; dosya adı ve boyutundan karar verebilirsin." }));

  return h("div", { class: "card", id: "card" },
    h("div", { class: "stamp left", text: "Sil" }),
    h("div", { class: "stamp right", text: "Sakla" }),
    h("div", { class: "stamp up", text: "Atla" }),
    h("div", { class: "imgwrap" }, img),
    h("div", { class: "foot" },
      h("div", { class: "fname", text: shot.name }),
      h("div", { class: "fmeta" },
        h("span", { text: formatDateTime(shot.taken_ms) }),
        h("span", { text: formatBytes(shot.size) }),
        h("span", { text: shot.ext.toUpperCase() }),
        h("span", { class: "hint", text: DATE_SOURCE_LABELS[shot.date_source] || shot.date_source }),
        shot.missing ? h("span", { class: "missing", text: "dosya diskte yok" }) : null
      )
    )
  );
}

function renderStaged() {
  el.view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "busy" })));
  api("staged_list").then((rows) => {
    if (!rows.length) {
      el.view.replaceChildren(h("div", { class: "empty" },
        h("h2", { text: "Silinecek dosya yok" }),
        h("p", { text: "Karta sola kaydırdıkça burada birikir." }),
        h("button", { class: "btn primary", onclick: backToMonths }, "Aylara dön")));
      return;
    }
    const total = rows.reduce((n, r) => n + r.size, 0);
    el.view.replaceChildren(
      h("div", { class: "panel", style: "padding:14px;margin-bottom:12px" },
        h("div", { style: "font-weight:620" , text: `${rows.length} dosya · ${formatBytes(total)}` }),
        h("div", { class: "hint", style: "margin-top:2px", text: "Bu dosyalar henüz diskte. Onaylayana kadar hiçbiri silinmez." })
      ),
      h("div", { class: "staged-list" }, rows.map(stagedRow)),
      h("div", { style: "display:flex;gap:8px;margin-top:14px" },
        h("button", { class: "btn danger", onclick: commit }, "Geri dönüşüm kutusuna taşı"),
        h("button", { class: "btn", onclick: backToMonths }, "Aylara dön")
      )
    );
  }).catch((e) => toast(`Hata: ${e}`));
}

function stagedRow(shot) {
  return h("div", { class: "staged-row" },
    h("span", { class: "n", text: shot.name }),
    h("span", { class: "s", text: formatDateTime(shot.taken_ms) }),
    h("span", { class: "s", text: formatBytes(shot.size) }),
    h("button", { class: "btn sm", onclick: () => unstageOne(shot.id) }, "Geri al")
  );
}

// ------------------------------------------------------------------- actions

async function decide(action) {
  if (state.view !== "review" || !state.card || state.busy) return;
  const shot = state.card;
  const id = shot.id;

  // Move on immediately; the card animates out while the write happens.
  if (action === ACTION.SKIP) state.queue.deferCurrent();
  else state.queue.advance();
  state.card = null;
  render();

  try {
    const updated = await api("decide", { id, kind: action });
    state.cache.set(id, updated);
    if (action === ACTION.DELETE) {
      await refreshCounts();
      toast(`${updated.name} silinmeyi bekliyor`, {
        action: "Geri al",
        onAction: () => undo(),
      });
    }
  } catch (e) {
    toast(`Karar kaydedilemedi: ${e}`);
  }

  if (state.queue.atEnd()) {
    state.view = "months";
    await loadMonths();
    render();
  } else {
    await showCurrent();
  }
}

async function undo() {
  try {
    const shot = await api("undo_last");
    if (!shot) {
      toast("Geri alınacak bir karar yok");
      return;
    }
    state.cache.set(shot.id, shot);
    if (state.view !== "review") {
      await loadMonths();
    } else {
      state.queue.cursor = Math.max(0, state.queue.cursor - 1);
      state.scope = { ...state.scope };
      await showCurrent();
    }
    await refreshCounts();
    toast(`Geri alındı: ${shot.name}`);
  } catch (e) {
    toast(`Geri alınamadı: ${e}`);
  }
}

async function unstageOne(id) {
  try {
    const shot = await api("unstage", { id });
    state.cache.set(id, shot);
    await refreshCounts();
    renderStaged();
    toast(`${shot.name} silme listesinden çıkarıldı`);
  } catch (e) {
    toast(`Hata: ${e}`);
  }
}

async function commit() {
  const n = state.summary?.staged || 0;
  if (!n) return;
  const ok = await confirmDialog({
    title: "Geri dönüşüm kutusuna taşı",
    message: `${n} dosya geri dönüşüm kutusuna taşınacak. Diskten kalıcı olarak silinmez; geri dönüşüm kutusundan istediğin zaman geri alabilirsin.`,
    confirmLabel: `${n} dosyayı taşı`,
    variant: "danger",
  });
  if (!ok) return;

  state.busy = true;
  el.commit.disabled = true;
  el.commit.textContent = "Taşınıyor...";
  try {
    const report = await api("commit_deletes");
    for (const f of report.failed) {
      if (!f.gone) toast(`${f.name}: ${f.error}`, { ms: 7000 });
    }
    if (report.deleted) {
      toast(`${report.deleted} dosya geri dönüşüm kutusuna taşındı`);
    }
    if (report.still_staged) {
      toast(`${report.still_staged} dosya hâlâ bekliyor`, { ms: 6000 });
    }
    await loadMonths();
    if (state.view === "staged") {
      state.view = "months";
      render();
    }
  } catch (e) {
    toast(`Taşınamadı: ${e}`);
  } finally {
    state.busy = false;
    el.commit.disabled = false;
    el.commit.textContent = "Geri dönüşüm kutusuna taşı";
    await refreshCounts();
  }
}

async function addFolder() {
  try {
    const picked = await api("pick_folder");
    if (!picked) return;
    await loadRoots();
    const root = state.roots.find((r) => r.path === picked);
    if (root) await selectRoot(root);
  } catch (e) {
    toast(`Klasör seçilemedi: ${e}`);
  }
}

async function rescan() {
  const root = state.roots.find((r) => r.id === state.rootId) || state.roots[0];
  if (!root) return addFolder();
  state.busy = true;
  render();
  try {
    const report = await api("scan_root", { path: root.path });
    el.scannedNote.textContent = `${report.found} dosya · ${report.elapsed_ms} ms`;
    await loadRoots();
    await loadMonths();
    if (state.view === "loading" || state.view === "setup") state.view = "months";
    render();
    const bits = [`${report.added} yeni`, `${report.refreshed} güncel`];
    if (report.unviewable) bits.push(`${report.unviewable} önizlemesiz`);
    if (report.missing) bits.push(`${report.missing} dosya diskte yok`);
    toast(`Tarama: ${bits.join(" · ")}`);
  } catch (e) {
    toast(`Tarama başarısız: ${e}`);
  } finally {
    state.busy = false;
    render();
  }
}

async function selectRoot(root) {
  state.rootId = root.id;
  state.view = "months";
  render();
  if (root.total === 0) return rescan();
  await loadMonths();
  render();
}

function backToMonths() {
  if ((state.summary?.staged || 0) > 0 && state.view === "review") {
    // Leaving a pass is fine; staged files stay put.
  }
  state.view = "months";
  loadMonths().then(render);
}

// ------------------------------------------------------------------ gestures

function attachGestures() {
  const stage = document.getElementById("stage");
  const cardEl = document.getElementById("card");
  if (!stage || !cardEl) return;

  const onDown = (e) => {
    if (state.busy || !state.card || e.button !== 0) return;
    state.drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      dy: 0,
      action: null,
      active: false,
    };
    cardEl.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e) => {
    const d = state.drag;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    d.active = true;

    const v = gestureVisual(d.dx, d.dy, GESTURE_THRESHOLD);
    d.action = v.action;

    const angle = (v.vertical ? d.dy : d.dx) * 0.035;
    cardEl.style.transform = `translate(${d.dx}px, ${d.dy}px) rotate(${angle}deg)`;
    cardEl.classList.add("dragging");

    const left = cardEl.querySelector(".stamp.left");
    const right = cardEl.querySelector(".stamp.right");
    const up = cardEl.querySelector(".stamp.up");
    left.style.opacity = v.action === ACTION.DELETE ? String(v.progress) : "0";
    right.style.opacity = v.action === ACTION.KEEP ? String(v.progress) : "0";
    up.style.opacity = v.action === ACTION.SKIP ? String(v.progress) : "0";
  };

  const finish = (e) => {
    const d = state.drag;
    if (!d || d.id !== e.pointerId) return;
    state.drag = null;
    cardEl.classList.remove("dragging");
    for (const s of cardEl.querySelectorAll(".stamp")) s.style.opacity = "0";

    const action = classifyGesture(d.dx, d.dy, GESTURE_THRESHOLD);
    if (!action) {
      cardEl.classList.add("settling");
      cardEl.style.transform = "";
      setTimeout(() => cardEl.classList.remove("settling"), 240);
      return;
    }
    const v = exitVector(action, Math.max(900, window.innerWidth));
    cardEl.style.transition = "transform .2s cubic-bezier(.2,.7,.3,1), opacity .2s";
    cardEl.style.transform = `translate(${v.x}px, ${v.y}px) rotate(${v.x * 0.02}deg)`;
    cardEl.style.opacity = "0";
    setTimeout(() => decide(action), 130);
  };

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", (e) => {
    const d = state.drag;
    state.drag = null;
    cardEl.classList.remove("dragging");
    cardEl.style.transform = "";
    if (d) for (const s of cardEl.querySelectorAll(".stamp")) s.style.opacity = "0";
  });
  stage.addEventListener("dragstart", (e) => e.preventDefault());
}

// ------------------------------------------------------------------ keyboard

document.addEventListener("keydown", (e) => {
  if (!el.modal.hidden) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    return undo();
  }
  if (e.key === "z" || e.key === "Z" || e.key === "Backspace") {
    if (state.view === "review") {
      e.preventDefault();
      return undo();
    }
    return;
  }
  if (state.view !== "review") return;

  switch (e.key) {
    case "ArrowLeft": e.preventDefault(); decide(ACTION.DELETE); break;
    case "ArrowRight": e.preventDefault(); decide(ACTION.KEEP); break;
    case "ArrowUp": e.preventDefault(); decide(ACTION.SKIP); break;
    case " ":
      if (state.queue.atEnd()) { e.preventDefault(); backToMonths(); }
      break;
    default: break;
  }
});

// Warn before closing with staged deletes still waiting.
window.addEventListener("beforeunload", (e) => {
  if ((state.summary?.staged || 0) > 0 && !state.cleanupDone) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// --------------------------------------------------------------------- wiring

el.back.addEventListener("click", backToMonths);
el.folder.addEventListener("click", addFolder);
el.scan.addEventListener("click", rescan);
el.commit.addEventListener("click", commit);
el.undo.addEventListener("click", undo);
el.stagedBtn.addEventListener("click", () => {
  state.view = "staged";
  render();
});

(async function boot() {
  try {
    state.info = await api("app_info");
  } catch (e) {
    el.view.replaceChildren(h("div", { class: "empty" },
      h("h2", { text: "Uygulama arka ucu açılamadı" }),
      h("p", { text: String(e) })));
    return;
  }
  await loadRoots();
  const active = state.roots.find((r) => r.total > 0) || state.roots[0] || null;
  if (!active) {
    state.view = "setup";
    render();
    return;
  }
  state.rootId = active.id;
  state.view = "months";
  await loadMonths();
  render();
})();
