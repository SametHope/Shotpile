// Page-side helpers the GUI test (tests/gui-smoke.cjs) calls through CDP. They
// read the rendered DOM and computed styles, and drive pointer gestures that
// CDP key events cannot express. Loaded before the app by tests/serve.cjs.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const text = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const shot = (name) => [...window.__shots.values()].find((x) => x.name === name);
  let nodeSeq = 0;
  const nodeId = (n) => (n ? n.__probeId || (n.__probeId = `n${++nodeSeq}`) : null);

  const top = () => $("#stage .deck .card.deck-top:not(.leaving)");

  window.__probe = {
    viewText: () => text($("#view")),
    view: () => document.body.dataset.view,
    status: (name) => shot(name)?.status ?? null,
    setStatus: (name, status) => { const s = shot(name); if (s) s.status = status; },

    // ---- library ----
    monthRows: () => $$(".month").map(text),
    monthThumbCount: () => $$(".month .fan img").length,
    overviewText: () => text($(".overview")),
    clickFirstMonth: () => $(".month")?.click(),
    clickMonth: (key) => $(`.month[data-month="${key}"]`)?.click(),
    clickSortAll: () => $("#btn-sort-all")?.click(),
    segWidths: (selector) => $$(`${selector} .seg`).map((s) => `${s.className.replace("seg seg-", "")}:${s.style.width}`),

    // ---- header / counts ----
    stagedCount: () => text($("#staged-badge")),
    stagedBtnVisible: () => !$("#btn-staged").hidden,
    footbarOn: () => $("#footbar").classList.contains("on"),
    footbarText: () => text($(".staged-count")),
    folderName: () => text($("#folder-name")),
    backToMonths: () => $("#btn-back").click(),
    clickStagedBtn: () => $("#btn-staged").click(),
    clickCommit: () => $("#btn-commit").click(),
    clickPileCommit: () => $("#btn-pile-commit")?.click(),
    clickFolderChip: () => $("#btn-folder").click(),
    menuItems: () => $$(".menu .menu-item").map((b) => text(b.querySelector(".menu-label"))),
    clickMenuItem: (re) => {
      const b = $$(".menu .menu-item").find((x) => new RegExp(re, "i").test(x.textContent));
      if (b) b.click();
      return !!b;
    },
    clickFindDuplicates: () => {
      const btn = $$(".overview-actions .btn").find((b) => b.textContent.includes("Find duplicates"));
      if (btn) btn.click();
      return !!btn;
    },
    dupeGroups: () => $$(".dupe-group").length,
    dupeItems: () => $$(".dupe-item").length,
    dupeGroupHeaders: () => $$(".dupe-group-header").map(text),
    dupeItemNames: () => $$(".dupe-name").map(text),
    clickDupeStage: (i) => {
      const btns = $$(".dupe-item .btn");
      if (btns[i]) btns[i].click();
      return !!btns[i];
    },

    // ---- review ----
    hasCard: () => !!top(),
    hasImg: () => !!top()?.querySelector(".imgwrap img"),
    cardName: () => text(top()?.querySelector(".fname")),
    cardPlaceholder: () => text(top()?.querySelector(".noimg-title")),
    progress: () => text($("#review-pos")),
    tally: () => Object.fromEntries($$(".tally-chip").map((c) => [c.dataset.action, Number(c.querySelector("b").textContent)])),
    deckCount: () => $$("#stage .deck .card:not(.leaving)").length,
    deckTopName: () => text(top()?.querySelector(".fname")),
    cardRect: () => {
      const r = top()?.getBoundingClientRect();
      return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    },
    filmCount: () => $$(".film-item").length,
    filmCurrent: () => $$(".film-item").findIndex((n) => n.classList.contains("current")),
    clickFilm: (i) => {
      const items = $$(".film-item");
      if (items[i]) { items[i].click(); return true; }
      return false;
    },
    filmSelected: (i) => {
      const n = $$(".film-item")[i];
      if (!n) return null;
      const s = getComputedStyle(n);
      return { border: s.borderTopColor, shadow: s.boxShadow !== "none", aria: n.getAttribute("aria-current"), status: n.dataset.status };
    },
    dateTooltip: () => top()?.querySelector(".fmeta span")?.getAttribute("title") || null,
    actionFlashed: (action) => $(`.act[data-action="${action}"]`)?.classList.contains("flash") || false,
    finaleText: () => text($(".finale")),
    finaleFocused: () => text(document.activeElement?.closest(".fin-actions") ? document.activeElement : null),
    clickFinale: (re) => {
      const b = $$(".fin-actions .btn").find((x) => new RegExp(re, "i").test(x.textContent));
      if (b) b.click();
      return !!b;
    },

    // ---- drag ----
    dragStart: (at = "middle") => {
      const c = top();
      const r = c.getBoundingClientRect();
      const y = at === "low" ? r.top + r.height * 0.8 : r.top + r.height / 2;
      window.__probe._drag = { x: r.left + r.width / 2, y };
      c.querySelector(".imgwrap").dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientX: window.__probe._drag.x, clientY: y, button: 0, pointerId: 7, isPrimary: true,
      }));
      return true;
    },
    dragTo: (dx, dy) => {
      const d = window.__probe._drag;
      $("#stage").dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: d.x + dx, clientY: d.y + dy, button: 0, pointerId: 7, isPrimary: true,
      }));
      return true;
    },
    dragEnd: (dx = 0, dy = 0) => {
      const d = window.__probe._drag;
      $("#stage").dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, clientX: d.x + dx, clientY: d.y + dy, button: 0, pointerId: 7, isPrimary: true,
      }));
      window.__probe._drag = null;
      return true;
    },
    tintOpacity: () => {
      const t = top()?.querySelector(".tint");
      return t ? Number(t.style.opacity || 0) : null;
    },
    cardScale: () => {
      const v = top()?.style.scale;
      return v ? Number(v) : 1;
    },
    cardTranslate: () => top()?.style.translate || "",
    cardRotate: () => top()?.style.rotate || "",
    stampOpacity: (dir) => {
      const s = top()?.querySelector(`.stamp.${dir}`);
      return s ? Number(s.style.opacity || 0) : null;
    },
    armed: () => top()?.dataset.armed || "",
    footBackground: () => top()?.querySelector(".foot")?.style.background || "",
    deck1Dy: () => {
      const n = $("#stage .deck .deck-1:not(.leaving)");
      if (!n) return null;
      const v = n.style.getPropertyValue("--deck-dy");
      return v ? parseFloat(v) : 22;
    },

    // ---- deck identity (smooth advance) ----
    topNodeId: () => nodeId(top()),
    deck1NodeId: () => nodeId($("#stage .deck .deck-1:not(.leaving)")),
    topOpacity: () => (top() ? getComputedStyle(top()).opacity : null),
    topInlineTransform: () => {
      const c = top();
      return c ? [c.style.transform, c.style.translate, c.style.rotate, c.style.scale].filter(Boolean).join(" ") : "";
    },
    topAnimateName: () => (top() ? getComputedStyle(top()).animationName : "none"),
    topComputedTransform: () => (top() ? getComputedStyle(top()).transform : null),
    leavingCount: () => $$("#stage .deck .card.leaving").length,
    deckInert: () => !!$(".deck.inert"),
    // Reads the *computed* value, so it fails if the `.deck.inert` selector is
    // malformed. Asserting the class alone would pass even when the rule is
    // dropped and the guard silently does nothing.
    deckPointerEvents: () => {
      const deck = $(".deck");
      if (!deck) return null;
      const before = getComputedStyle(deck).pointerEvents;
      deck.classList.add("inert");
      const during = getComputedStyle(deck).pointerEvents;
      deck.classList.remove("inert");
      const after = getComputedStyle(deck).pointerEvents;
      return `${before}|${during}|${after}`;
    },
    markStage: () => {
      const d = $("#stage");
      if (!d) return null;
      d.dataset.probeMark = `m${++nodeSeq}`;
      return d.dataset.probeMark;
    },
    stageIsSame: (mark) => $("#stage")?.dataset.probeMark === mark,

    // ---- card zoom ----
    wheelCard: (up = true) => {
      const w = top().querySelector(".imgwrap");
      const r = w.getBoundingClientRect();
      w.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: up ? -100 : 100,
      }));
      return true;
    },
    resetCardZoom: () => window.__shotpileTest.resetCardZoom(),
    cardZoomScale: () => {
      const i = top()?.querySelector(".imgwrap img");
      const m = /scale\(([\d.]+)\)/.exec(i?.style.transform || "");
      return m ? Number(m[1]) : 1;
    },
    cardIsPannable: () => top()?.classList.contains("pannable") || false,
    zoomReadout: () => text($("#zoom-readout")),
    zoomReadoutOn: () => $("#zoom-readout")?.classList.contains("on") || false,

    // ---- card geometry: is the image fully visible, or does the info bar cover it? ----
    cardGeometry: () => {
      const card = top();
      const img = card?.querySelector(".imgwrap img");
      const wrap = card?.querySelector(".imgwrap");
      const foot = card?.querySelector(".foot");
      if (!card || !img || !wrap || !foot) return null;
      const c = card.getBoundingClientRect();
      const i = img.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const f = foot.getBoundingClientRect();
      const fname = card.querySelector(".fname");
      const cs = getComputedStyle(foot);
      return {
        cardH: Math.round(c.height), imgBoxH: Math.round(i.height), footShare: +(f.height / c.height).toFixed(3),
        footPosition: cs.position, footInFlow: cs.position === "static", footBg: cs.backgroundImage,
        imgOverflowsWrap: +(Math.max(0, i.bottom - w.bottom) + Math.max(0, w.top - i.top)).toFixed(1),
        fnameLines: fname ? Math.round(fname.getBoundingClientRect().height / 18) : 0,
      };
    },
    imgNatural: () => {
      const img = top()?.querySelector(".imgwrap img");
      return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    },

    // ---- viewer ----
    viewerOpen: () => !!$("#viewer"),
    viewerZoom: () => text($(".viewer-zoom")),
    viewerName: () => text($(".viewer-name")),
    viewerDims: () => text($(".viewer-dims")),
    openViewer: () => window.__shotpileTest.openViewer(),
    closeViewer: () => window.__shotpileTest.closeViewer(),
    clickCard: () => {
      const c = top();
      if (!c) return false;
      // A real click is preceded by a pointerdown, which clears the "this was
      // a drag" flag; without it a previous synthetic drag would suppress it.
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const target = c.querySelector(".imgwrap");
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 9, isPrimary: true }));
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 9, isPrimary: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, detail: 1 }));
      return true;
    },

    // ---- modal / toast ----
    modalHidden: () => $("#modal").hidden,
    modalTitle: () => text($("#modal-title")),
    focusedLabel: () => {
      const a = document.activeElement;
      return a && a !== document.body ? text(a) : null;
    },
    toastText: () => text($("#toast .msg")),
    toastTone: () => $("#toast").dataset.tone || "",
    clickConfirmInModal: () => {
      const btn = $$("#modal-foot button").find((b) => /move|forget/i.test(b.textContent));
      if (btn) btn.click();
      return !!btn;
    },
    clickModalButton: (re) => {
      const btn = $$("#modal-foot button").find((b) => new RegExp(re, "i").test(b.textContent));
      if (btn) btn.click();
      return !!btn;
    },
    logModalText: () => text($(".logview")),

    // ---- the deletion pile ----
    pileNames: () => $$(".tile .tile-name").map(text),
    clickPutBack: (i) => {
      const b = $$(".tile .tile-putback")[i];
      if (b) b.click();
      return !!b;
    },

    // ---- fake backend controls ----
    logFilter: (prefix) => window.__LOG.filter((l) => l.startsWith(prefix)),
    uiLog: () => window.__UI_LOG.map((e) => `${e.level}:${e.scope}:${e.msg}`),
    devtoolsCalled: () => window.__LOG.includes("devtools"),
    reset: () => { window.__LOG.length = 0; },
    resetShots: () => window.__fake.resetShots(),
    setFault: (name, value) => { window.__faults[name] = value; },
    failCommitFor: (name) => { const s = shot(name); if (s) s.__failCommit = true; },
    setMissing: (name, v) => { const s = shot(name); if (s) s.missing = v; },
    addFolder: () => window.__shotpileTest.addFolder(),
    resetToSetup: () => window.__shotpileTest.resetToSetup(),
    appState: () => window.__shotpileTest.snapshot(),
    bodyBg: () => getComputedStyle(document.body).backgroundColor,
    // Enough older months to make the library scroll; removed again after.
    addOldMonths: (n) => {
      const base = [...window.__shots.values()].find((x) => x.root_id === 1);
      for (let i = 0; i < n; i++) {
        const id = 500 + i;
        window.__shots.set(id, { ...base, id, name: `Old ${i}.png`, path: `C:/1/Old ${i}.png`, taken_ms: Date.UTC(2023, 0, 15) + i * 31 * 86400000, status: "pending", decided_ms: null });
      }
    },
    removeOldMonths: () => { for (const id of [...window.__shots.keys()]) if (id >= 500) window.__shots.delete(id); },
    stageOldMonths: () => { for (const s of window.__shots.values()) if (s.id >= 500) s.status = "staged"; },
    toastOn: () => $("#toast").classList.contains("on"),
    visibility: (sel) => { const n = $(sel); return n ? getComputedStyle(n).visibility : null; },
    appInert: () => $("#app").hasAttribute("inert"),
    focusSel: (sel) => { const n = $(sel); if (n) n.focus(); return document.activeElement === n; },
    focusedIs: (sel) => document.activeElement === $(sel),
    hasSel: (sel) => !!$(sel),
    attr: (sel, name) => $(sel)?.getAttribute(name) ?? null,
    dropCache: () => window.__shotpileTest.dropCache(),
    viewScroll: () => document.getElementById("view").scrollTop,
    setViewScroll: (y) => { document.getElementById("view").scrollTop = y; },
  };
})();
