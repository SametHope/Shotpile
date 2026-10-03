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
    // The filter hides non-matching items with the `hidden` attribute, so count
    // what is actually on screen rather than every `.film-item`.
    filmVisibleCount: () => $$(".film-item").filter((n) => !n.hidden).length,
    filmItemRect: (i = 0) => {
      const r = $$(".film-item")[i]?.getBoundingClientRect();
      return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    },
    // The review's vertical chain: the lowest deck card (the peeking stack, not
    // just the top card), the stage, the action row and the filmstrip. The
    // peeking cards are translated below the stage, so measuring only the top
    // card hid the real overlap with the buttons.
    reviewLayout: () => {
      const stage = $("#stage");
      const actions = $("#review-actions");
      const strip = $("#filmstrip");
      const cards = $$("#stage .deck .card:not(.leaving)");
      if (!stage || !actions || !strip || !cards.length) return null;
      const s = stage.getBoundingClientRect();
      const a = actions.getBoundingClientRect();
      const f = strip.getBoundingClientRect();
      const bottoms = cards.map((c) => c.getBoundingClientRect().bottom);
      return {
        stageH: Math.round(s.height),
        cardH: Math.round(cards[0].getBoundingClientRect().height),
        cardBottom: Math.round(Math.max(...bottoms)),
        actionsTop: Math.round(a.top),
        stripH: Math.round(f.height),
      };
    },
    // Every rendered filmstrip item, and whether the current one and all items
    // sit inside the strip's horizontal bounds (nothing clipped off-screen).
    filmBounds: () => {
      const strip = $("#filmstrip");
      if (!strip) return null;
      const sr = strip.getBoundingClientRect();
      const items = $$(".film-item");
      const outside = items.filter((n) => {
        const r = n.getBoundingClientRect();
        return r.left < sr.left - 0.5 || r.right > sr.right + 0.5;
      }).length;
      const cur = items.find((n) => n.classList.contains("current"));
      const cr = cur?.getBoundingClientRect();
      return {
        count: items.length,
        outside,
        currentVisible: !!cr && cr.left >= sr.left - 0.5 && cr.right <= sr.right + 0.5,
        stripW: Math.round(sr.width),
      };
    },
    // State of the sorting-button collapse: the row leaves the layout (so it
    // takes no space and cannot take focus) while the strip grows to fill it.
    actionRowState: () => {
      const review = $(".review");
      const actions = $("#review-actions");
      const strip = $("#filmstrip");
      const btn = $("#stage-toggle");
      if (!review || !actions || !strip || !btn) return null;
      const s = getComputedStyle(actions);
      const item = $(".film-item");
      return {
        hidden: review.classList.contains("no-actions"),
        pressed: btn.getAttribute("aria-pressed"),
        // The toggle belongs to the review head, not the photo it collapses
        // below; floating over the stage is what it used to do.
        inHead: !!btn.closest(".review-head"),
        onStage: !!btn.closest(".stage"),
        visibility: s.visibility,
        rowH: Math.round(actions.getBoundingClientRect().height),
        stripH: Math.round(strip.getBoundingClientRect().height),
        itemH: item ? Math.round(item.getBoundingClientRect().height) : 0,
        cardH: Math.round($("#stage .deck .card:not(.leaving)")?.getBoundingClientRect().height || 0),
        pref: window.shotpilePrefs?.get().hideActions ?? null,
      };
    },
    clickStageToggle: () => {
      const btn = $("#stage-toggle");
      if (!btn) return false;
      btn.click();
      return true;
    },
    // The rendered segment colours of the big progress bar, by status.
    segbarColors: () => {
      const out = {};
      for (const n of $$(".segbar .seg")) {
        const key = [...n.classList].find((c) => c.startsWith("seg-") && c !== "seg");
        out[key] = getComputedStyle(n).backgroundColor;
      }
      return out;
    },
    segbarTrack: () => {
      const n = $(".segbar");
      return n ? getComputedStyle(n).backgroundImage : null;
    },
    // The stripe period of every bar, big and small, by the size it renders at,
    // and how far apart its two stripe colours read. A period alone proves
    // nothing: at 6px the old line vanished into the track, so the contrast
    // step is the part that has to hold.
    segbarStripes: () => {
      // A computed gradient reads "repeating-linear-gradient(45deg, A 0px, A 2px,
      // B 2px, B 4px)", so the period is the last two lengths.
      const period = (img) => {
        const all = (img || "").match(/(\d+(?:\.\d+)?)px/g) || [];
        return all.length >= 2 ? `${all[all.length - 2].replace("px", "")}/${all[all.length - 1].replace("px", "")}` : null;
      };
      // The two stripe colours, resolved through a throwaway element instead of
      // parsed out of the gradient string: color-mix() is substituted at
      // computed-value time, and this must not assume a translucent stop is
      // composited over the track. It is not -- a gradient composites over the
      // page behind the bar -- which is how the old probe reported a healthy
      // step for a line that painted as flat grey.
      const resolve = (expr) => {
        const n = document.createElement("i");
        n.style.display = "none";
        n.style.backgroundColor = expr;
        document.body.appendChild(n);
        const c = getComputedStyle(n).backgroundColor;
        n.remove();
        const nums = (c.match(/[\d.]+/g) || []).map(Number);
        // color-mix() comes back as color(srgb 0..1), plain colours as rgb(0..255).
        const isUnit = /^color\(/.test(c);
        const chan = isUnit ? nums.slice(0, 3).map((v) => Math.round(v * 255)) : nums.slice(0, 3);
        return { rgb: chan, a: nums.length > 3 ? nums[3] : 1 };
      };
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const out = {};
      for (const n of $$(".segbar")) {
        const s = getComputedStyle(n);
        const h = Math.round(n.getBoundingClientRect().height);
        const track = resolve("var(--seg-track)");
        const line = resolve("var(--track-line)");
        out[h] = {
          h,
          striped: /repeating-linear-gradient/.test(s.backgroundImage),
          period: period(s.backgroundImage),
          step: Math.round(Math.abs(lum(track.rgb) - lum(line.rgb))),
          alpha: line.a,
          track: `rgb(${track.rgb.join(", ")})`,
          line: `rgb(${line.rgb.join(", ")})`,
        };
      }
      return out;
    },
    // The filmstrip shows whole frames, like the library cards.
    filmThumbFit: () => {
      const img = $(".film-thumb img");
      return img ? getComputedStyle(img).objectFit : null;
    },
    setFilmstripHeight: (h) => {
      const r = $(".review");
      if (r) r.style.setProperty("--filmstrip-height", `${h}px`);
      // The real app re-renders the strip on a resize; trigger the same path.
      window.dispatchEvent(new Event("resize"));
      return !!r;
    },
    // The computed colour a status segment paints, via a throwaway element so
    // it works before any real segment of that status exists.
    segTokenColor: (cls) => {
      const n = document.createElement("i");
      n.className = `seg ${cls}`;
      n.style.display = "none";
      document.body.appendChild(n);
      const c = getComputedStyle(n).backgroundColor;
      n.remove();
      return c;
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

    // ---- options / shortcuts ----
    clickOptions: () => $("#btn-options")?.click(),
    shortcutKey: (actionId) => $$(`.shortcut-row[data-action="${actionId}"] .shortcut-key`)[0]?.textContent || null,
    clickRebindButton: (actionId) => {
      const btn = $$(`.shortcut-row[data-action="${actionId}"] .shortcut-key`)[0];
      if (btn) btn.click();
      return !!btn;
    },
    // The reset is an .opt-row .btn.sm.ghost at the end of the shortcut
    // groups: same line as its label, in the style the Zoom row uses. A
    // section of its own put two divider lines around a lone button.
    resetShortcutRow: () => {
      const sections = [...document.querySelectorAll(".options-sheet .opt-group")];
      const row = [...document.querySelectorAll(".options-sheet .opt-row")].find((r) =>
        r.querySelector(".opt-label")?.textContent.includes("shortcut")
      );
      if (!row) return null;
      const section = sections.find((s) => s.contains(row));
      const label = row.querySelector(".opt-label");
      const btn = [...row.querySelectorAll(".btn")].find((b) => b.classList.contains("ghost"));
      return {
        sameLine: !!label && label.textContent.includes("Restore every shortcut"),
        ghost: btn?.textContent === "Reset",
        // The last shortcut group carries it, and the group still heads
        // with a title rather than being the reset itself.
        lastShortcutsGroup: !!(section && section.querySelector("h3") && !/reset/i.test(section.querySelector("h3").textContent)),
        // A section that is nothing but a title and one button.
        noLoneButton: !sections.some((s) => !s.querySelector(".opt-row") && [...s.querySelectorAll(".btn")].length === 1 && s.textContent.replace(s.querySelector("h3")?.textContent || "", "").trim() === s.querySelector(".btn").textContent.trim()),
      };
    },
    clickResetShortcuts: () => {
      const row = [...document.querySelectorAll(".options-sheet .opt-row")].find((r) =>
        r.querySelector(".opt-label")?.textContent.includes("shortcut")
      );
      const btn = row && [...row.querySelectorAll(".btn")].find((b) => b.textContent === "Reset");
      if (btn) btn.click();
      return !!btn;
    },
    shortcutKeyBusyWaiting: (actionId) => $$(`.shortcut-row[data-action="${actionId}"] .shortcut-key`)[0]?.classList.contains("waiting") || false,

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
    // A whole synthetic month of pending shots (ids 900+), long enough that the
    // filmstrip cannot show them all. Removed again after.
    addMonthShots: (month, n) => {
      const base = [...window.__shots.values()].find((x) => x.root_id === 1);
      const [y, m] = month.split("-").map(Number);
      for (let i = 0; i < n; i++) {
        const id = 900 + i;
        const name = `Bulk ${String(i).padStart(2, "0")}.png`;
        window.__shots.set(id, {
          ...base, id, name, path: `C:/1/${name}`, ext: "png", viewable: true,
          taken_ms: Date.UTC(y, m - 1, 10, 9, 0, i % 60), status: "pending", decided_ms: null, missing: false,
        });
      }
    },
    removeMonthShots: () => { for (const id of [...window.__shots.keys()]) if (id >= 900) window.__shots.delete(id); },
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
  windowState: () => ({ ...window.__windowState() }),

  // Check that all buttons without visible text have both title and aria-label
  checkTooltips: () => {
    const buttons = $$("button");
    const issues = [];
    for (const btn of buttons) {
      // Skip buttons with visible text (including text nodes and icon labels)
      const text = btn.textContent?.trim() || "";
      if (text) continue;

      // This is an icon-only button - check for title and aria-label
      const hasTitle = btn.hasAttribute("title") && btn.getAttribute("title")?.trim();
      const hasAriaLabel = btn.hasAttribute("aria-label") && btn.getAttribute("aria-label")?.trim();

      if (!hasTitle || !hasAriaLabel) {
        const id = btn.id || `[class="${btn.className}"]`;
        issues.push({
          element: id,
          hasTitle,
          hasAriaLabel,
        });
      }
    }
    return {
      total: buttons.length,
      iconOnlyCount: buttons.filter(b => !b.textContent?.trim()).length,
      issues,
    };
  },

  };
})();
