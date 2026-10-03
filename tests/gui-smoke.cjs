// GUI smoke test: runs the real src/index.html + src/app.js in headless Chrome
// against the in-memory fake backend (tests/fake-backend.js, injected by
// tests/serve.cjs), and drives it with real CDP key events, so native
// Enter/Escape semantics on a focused button are exercised, not just a
// synthetic handler. Page-side helpers live in tests/probes.js.
//
// Needs Chrome or Chromium; set CHROME=/path/to/chrome if it is not found.
const { start } = require("./serve.cjs");
const { launchChrome } = require("./browser.cjs");

const PORT = 8731;
const CDP_PORT = 9222;

// Key identities, so the browser sees the real key: Windows virtual key code,
// DOM `code`, and the text a printable key produces.
const KEYS = {
  Enter: { vk: 13, code: "Enter", text: "\r" },
  Escape: { vk: 27, code: "Escape" },
  Backspace: { vk: 8, code: "Backspace" },
  " ": { vk: 32, code: "Space", text: " " },
  ArrowLeft: { vk: 37, code: "ArrowLeft" },
  ArrowUp: { vk: 38, code: "ArrowUp" },
  ArrowRight: { vk: 39, code: "ArrowRight" },
  ArrowDown: { vk: 40, code: "ArrowDown" },
  z: { vk: 90, code: "KeyZ", text: "z" },
  y: { vk: 89, code: "KeyY", text: "y" },
  "=": { vk: 187, code: "Equal", text: "=" },
  "-": { vk: 189, code: "Minus", text: "-" },
  "0": { vk: 48, code: "Digit0", text: "0" },
  ",": { vk: 188, code: "Comma", text: "," },
  i: { vk: 73, code: "KeyI" },
  p: { vk: 80, code: "KeyP", text: "p" },
  l: { vk: 76, code: "KeyL" },
  "?": { vk: 191, code: "Slash", text: "?" },
  F11: { vk: 112, code: "F11" },
  F12: { vk: 123, code: "F12" },
};
// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const CTRL = 2;
const SHIFT = 8;
const CTRL_SHIFT = CTRL | SHIFT;

(async () => {
  const server = await start(PORT);
  const chrome = await launchChrome({ port: CDP_PORT, profile: "shotpile-chrome-smoke-profile" });
  const client = chrome.client;
  const cleanup = () => { chrome.close(); server.close(); };
  process.on("exit", cleanup);

  const consoleErrors = [];
  client.on("Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error") return;
    const text = p.args.map((a) => a.value ?? a.description).join(" ");
    // The edge-case tests deliberately trigger failures, so their console noise
    // is expected. Anything else is a real error.
    if (/simulated/.test(text)) return;
    consoleErrors.push(text);
  });
  client.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push("exception: " + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });

  await client.send("Runtime.enable");
  await client.send("Page.enable");
  // The colour assertions below are written against the light theme. Pin it so
  // a host OS (or CI image) set to dark cannot change the result; the dark-theme
  // section near the end emulates dark explicitly.
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await client.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/src/index.html` });

  const js = async (body) => {
    const r = await client.send("Runtime.evaluate", {
      // Wrapped as a function body so multi-statement probes work.
      expression: `(async function () { const p = window.__probe;\n${body}\n})()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // For one-liner probes: auto-returns the expression.
  const probe = (expr) => js(`return ${expr};`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Polls until the probe is truthy; returns its last value either way. A probe
  // that throws (the page is still loading) counts as not yet.
  const waitFor = async (expr, ms = 2000) => {
    const until = Date.now() + ms;
    let v;
    do {
      try {
        v = await probe(expr);
      } catch {
        v = undefined;
      }
      if (v) return v;
      await sleep(40);
    } while (Date.now() < until);
    return v;
  };

  // Real key press through the browser input pipeline.
  const press = async (key, mods = 0, { autoRepeat = false } = {}) => {
    const k = KEYS[key];
    const common = { modifiers: mods, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, key, code: k.code, autoRepeat };
    const typed = k.text !== undefined && !(mods & CTRL);
    await client.send("Input.dispatchKeyEvent", { type: typed ? "keyDown" : "rawKeyDown", ...common, ...(typed ? { text: k.text } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  };

  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
  };
  const status = (name) => probe(`p.status(${JSON.stringify(name)})`);

  const FIRST = "Screenshot 2026-09-02 09-03-11.png";
  const SECOND = "Screenshot 2026-09-14 21-14-05.png";
  const THIRD = "Screenshot 2026-09-14 21-15-41.png";

  // Everything below runs inside one try: when a step throws (usually because
  // an earlier failure left the app somewhere unexpected), the run still
  // reports every result gathered so far instead of dying with a stack trace.
  try {
    await waitFor("p.monthRows().length > 0", 4000);

    // ---- boot: the library ----
    const months = await probe("p.monthRows()");
    ok("boots into the library", months.length === 2, JSON.stringify(months));
    ok("the page tells the backend to show the window", (await waitFor("p.logFilter('ready').length === 1")) === true, JSON.stringify(await probe("p.logFilter('ready')")));
    ok("months are ordered newest first", /September/.test(months[0] || ""), JSON.stringify(months));
    ok("month rows count screenshots, singular included", /3 screenshots/.test(months[0] || "") && /1 screenshot(?!s)/.test(months[1] || ""), JSON.stringify(months));
    ok("month rows show a fan of thumbnails", (await probe("p.monthThumbCount()")) > 0, String(await probe("p.monthThumbCount()")));
    const overview = await probe("p.overviewText()");
    ok("the overview leads with the total and what is left", /4 screenshots/.test(overview) && /4 left to sort/.test(overview), overview);
    ok("the header names the current folder", (await probe("p.folderName()")) === "Screenshots", await probe("p.folderName()"));
    // The progress bar: the unsorted remainder is the striped track; deleted is
    // a solid red, not a stripe.
    ok("segments touch, so no stripe shows between them", (await probe("getComputedStyle(document.querySelector('.segbar')).columnGap")) === "normal" || (await probe("getComputedStyle(document.querySelector('.segbar')).columnGap")) === "0px");
    ok("the unsorted progress track is striped", /repeating-linear-gradient/.test(await probe("p.segbarTrack()") || ""), await probe("p.segbarTrack()"));
    const stripes = await probe("p.segbarStripes()");
    const big = stripes && stripes[10];
    const small = stripes && stripes[6];
    ok("the small month bars are striped too", small && small.striped === true, JSON.stringify(stripes));
    ok("the month bars use a finer stripe than the overview bar", big && small && small.period && big.period && small.period !== big.period, JSON.stringify(stripes));
    // The stripes have to read as stripes: a 7% line over the track vanished at
    // 6px, which is what the user saw as "no stripes at all".
    ok("the month bar stripes are visible, not a faint tint", small && small.step >= 20, JSON.stringify(stripes));
    ok("the overview bar stripes are visible too", big && big.step >= 20, JSON.stringify(stripes));
    // And the stripe must be an opaque colour. A translucent gradient stop is
    // composited over the page behind the bar, not over the track, so it washes
    // toward the background instead of striping: that is what hid the old line,
    // and a step computed with the wrong compositing model would not catch it.
    ok("the stripe is opaque, not a translucent wash", small && big && small.alpha === 1 && big.alpha === 1, JSON.stringify(stripes));
    const delColor = await probe("p.segTokenColor('seg-deleted')");
    const dnum = (delColor.match(/\d+/g) || []).map(Number);
    ok("the deleted segment is red", dnum[0] > 120 && dnum[1] < 110 && dnum[2] < 110, delColor);

    // ---- open the September queue ----
    await probe("p.clickMonth('2026-09')");
    await waitFor("p.hasCard()");
    ok("review view shows a card", await probe("p.hasCard()"));
    ok("card renders an image element", await probe("p.hasImg()"));
    const first = await probe("p.cardName()");
    ok("first card is the oldest pending file", first === FIRST, String(first));
    ok("progress shows position in queue", (await probe("p.progress()")) === "1 of 3", await probe("p.progress()"));
    ok("deck shows the current card plus two upcoming", (await probe("p.deckCount()")) === 3, String(await probe("p.deckCount()")));
    ok("the top card is the current one", (await probe("p.deckTopName()")) === first, await probe("p.deckTopName()"));
    const cr = await probe("p.cardRect()");
    ok("the card fills the deck", cr && cr.w > 400 && cr.h > 150, JSON.stringify(cr));
    ok("the pass tally starts at zero", JSON.stringify(await probe("p.tally()")) === JSON.stringify({ keep: 0, delete: 0, skip: 0 }), JSON.stringify(await probe("p.tally()")));
    ok("the review hides the footer bar", (await probe("p.footbarOn()")) === false);

    // ---- queue filmstrip ----
    ok("filmstrip shows the queue", (await probe("p.filmCount()")) === 3, String(await probe("p.filmCount()")));
    ok("filmstrip marks the current item", (await probe("p.filmCurrent()")) === 0, String(await probe("p.filmCurrent()")));
    // Buttons keep their button role: a listitem role would hide them from a
    // screen reader as controls.
    const filmRoles = `${await probe("p.attr('#filmstrip', 'role')")} / ${await probe("p.attr('.film-item', 'role')")}`;
    ok("the filmstrip is a group of plain buttons", filmRoles === "group / null", filmRoles);
    // Collapsed is not enough: an invisible "Move to Recycle Bin" must not be
    // reachable with Tab and Enter.
    ok("the collapsed footer bar is out of the tab order", (await waitFor("p.visibility('#footbar') === 'hidden'", 800)) === true, String(await probe("p.visibility('#footbar')")));
    await js("p.clickFilm(1);");
    await waitFor(`p.cardName() !== ${JSON.stringify(first)}`);
    ok("clicking a film item jumps to it", (await probe("p.cardName()")) === SECOND, String(await probe("p.cardName()")));
    await js("p.clickFilm(0);");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);
    ok("jumping back returns to the first card", (await probe("p.cardName()")) === first, String(await probe("p.cardName()")));
    // While a jumped-to card is still loading, the old one stays on screen but
    // the cursor already points at the new one: a key then decided the old
    // card and advanced from the new position, skipping a card unseen.
    await js("p.reset(); p.dropCache(); p.setFault('itemsDelayMs', 400); p.clickFilm(1);");
    await press("ArrowLeft");
    await js("p.setFault('itemsDelayMs', 0);");
    await waitFor(`p.cardName() === ${JSON.stringify(SECOND)}`);
    ok("a key while a jump is loading decides nothing", (await probe("p.logFilter('decide:').length")) === 0 && (await status(first)) === "pending", JSON.stringify(await probe("p.logFilter('decide:')")));
    ok("the jump still lands", (await probe("p.cardName()")) === SECOND && (await probe("p.progress()")) === "2 of 3", `${await probe("p.cardName()")} ${await probe("p.progress()")}`);
    await js("p.clickFilm(0);");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);

    // ---- the filename filter is gone; the sorting-button toggle replaces it ----
    ok("the filename filter is no longer offered", (await probe("p.hasSel('#filter-input')")) === false);

    // ---- collapsing the sorting buttons gives the filmstrip the room ----
    const shown = await probe("p.actionRowState()");
    ok("the sorting row starts visible", shown && shown.hidden === false && shown.visibility === "visible" && shown.pressed === "false", JSON.stringify(shown));
    // The toggle lives in the review head with the rest of the chrome, not
    // floating on the photo: one set of buttons in one place.
    ok("the toggle sits in the review head, not on the stage", shown && shown.inHead === true && shown.onStage === false, JSON.stringify(shown));
    ok("filmstrip thumbnails show the whole frame", (await probe("p.filmThumbFit()")) === "contain", String(await probe("p.filmThumbFit()")));
    const cardShown = shown ? shown.cardH : 0;
    await js("p.clickStageToggle();");
    // The row stays visible through the collapse transition, then flips to
    // hidden, so the test waits for both halves.
    await waitFor("p.actionRowState() && p.actionRowState().rowH === 0 && p.actionRowState().visibility === 'hidden'");
    const hidden = await probe("p.actionRowState()");
    ok("collapsing the row hides it from the layout and from focus", hidden && hidden.hidden === true && hidden.visibility === "hidden" && hidden.rowH === 0 && hidden.pressed === "true", JSON.stringify(hidden));
    ok("the filmstrip takes the row's height", hidden && hidden.stripH > shown.stripH + 40 && hidden.itemH > shown.itemH + 40, `${shown && shown.stripH}->${hidden && hidden.stripH}`);
    ok("the deck still fills the stage (the card did not collapse)", hidden && hidden.cardH >= Math.round(cardShown * 0.8), `${cardShown}->${hidden && hidden.cardH}`);
    ok("the choice is saved", hidden && hidden.pref === true, String(hidden && hidden.pref));
    await js("p.clickStageToggle();");
    await waitFor("p.actionRowState() && p.actionRowState().hidden === false");
    const reshown = await probe("p.actionRowState()");
    ok("the row comes back and gives the space up again", reshown && reshown.hidden === false && reshown.visibility === "visible" && reshown.stripH === shown.stripH, JSON.stringify(reshown));

    // ---- filmstrip resizing: thumbnails scale, the deck yields the space ----
    const shortStrip = await probe("p.reviewLayout()");
    const shortFilm = await probe("p.filmBounds()");
    ok("the current filmstrip item is on screen", shortFilm && shortFilm.currentVisible && shortFilm.outside === 0, JSON.stringify(shortFilm));
    ok("the peeking card stack clears the action row", shortStrip && shortStrip.cardBottom <= shortStrip.actionsTop, JSON.stringify(shortStrip));

    await js("p.setFilmstripHeight(200);");
    await waitFor("p.filmBounds() && p.filmBounds().outside === 0");
    const tallStrip = await probe("p.reviewLayout()");
    const tallThumb = await probe("p.filmItemRect(0)");
    ok("the filmstrip thumbnails scale with the strip", tallThumb && tallThumb.h > 60 && tallThumb.w > tallThumb.h * 1.3, JSON.stringify(tallThumb));
    ok("enlarging the strip shrinks the deck without crossing the actions", tallStrip && tallStrip.stageH < shortStrip.stageH && tallStrip.cardBottom <= tallStrip.actionsTop, `${JSON.stringify(shortStrip)} -> ${JSON.stringify(tallStrip)}`);
    await js("p.setFilmstripHeight(52);");
    await waitFor("p.filmBounds() && p.filmBounds().outside === 0");
    const restoredThumb = await probe("p.filmItemRect(0)");
    ok("the default strip keeps the original thumbnail size", restoredThumb && Math.abs(restoredThumb.h - 42) <= 1 && Math.abs(restoredThumb.w - 60) <= 2, JSON.stringify(restoredThumb));

    // A short window is what Windows display scaling at 125%/150% produces:
    // the `max-height: 600px` query drops the filmstrip, shrinks --deck-dy and
    // overrides the stage margin, so the stack cleared the buttons by accident
    // before. Assert it at that size too.
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 560, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const shortWindow = await probe("p.reviewLayout()");
    ok("a short window keeps the card stack clear of the buttons", shortWindow && shortWindow.cardBottom <= shortWindow.actionsTop, JSON.stringify(shortWindow));
    await client.send("Emulation.clearDeviceMetricsOverride");
    await sleep(250);

    // ---- the date-source diagnostic lives in the tooltip ----
    ok("the date explains its source on hover", /from filename/i.test(await probe("p.dateTooltip()") || ""), String(await probe("p.dateTooltip()")));

    // ---- drag feedback: card tint, shrinking scale, loud stamps ----
    // Offsets are absolute from where the drag started, and each direction must
    // clear GESTURE_THRESHOLD (90) before a decision is implied.
    await js("p.dragStart();");
    await js("p.dragTo(120, 0);");
    ok("the card tints on a right drag", (await probe("p.tintOpacity()")) > 0, String(await probe("p.tintOpacity()")));
    ok("the card shrinks as it is dragged", (await probe("p.cardScale()")) < 1, String(await probe("p.cardScale()")));
    ok("the keep stamp shows on a right drag", (await probe("p.stampOpacity('right')")) > 0.5, String(await probe("p.stampOpacity('right')")));
    ok("the delete stamp stays hidden", (await probe("p.stampOpacity('left')")) === 0, String(await probe("p.stampOpacity('left')")));
    ok("the card arms the keep stamp", (await probe("p.armed()")) === "keep", await probe("p.armed()"));
    // The info bar carries the action colour too, otherwise the only tinted area
    // is the letterbox margin around the photo.
    const footRight = await probe("p.footBackground()");
    ok("the info bar takes the keep colour", /21,\s*128,\s*61/.test(footRight), footRight);
    ok("the drag moves the card itself", /120px/.test(await probe("p.cardTranslate()")), await probe("p.cardTranslate()"));
    // A key during a drag would decide the card under the pointer, and the
    // release would then decide the next card with the drag's direction.
    await press("ArrowLeft");
    await sleep(120);
    ok("arrow keys are ignored while a drag is in progress", (await status(first)) === "pending" && /120px/.test(await probe("p.cardTranslate()")), `${await status(first)} ${await probe("p.cardTranslate()")}`);
    await js("p.dragTo(-120, 0);");
    ok("the tint follows a left drag", (await probe("p.tintOpacity()")) > 0, String(await probe("p.tintOpacity()")));
    ok("the delete stamp shows on a left drag", (await probe("p.stampOpacity('left')")) > 0.5, String(await probe("p.stampOpacity('left')")));
    ok("the info bar takes the delete colour", /220,\s*38,\s*38/.test(await probe("p.footBackground()")), String(await probe("p.footBackground()")));
    await js("p.dragTo(0, -120);");
    ok("the tint follows an up drag", (await probe("p.tintOpacity()")) > 0, String(await probe("p.tintOpacity()")));
    ok("the skip stamp shows on an up drag", (await probe("p.stampOpacity('up')")) > 0.5, String(await probe("p.stampOpacity('up')")));
    ok("the info bar takes the skip colour", /180,\s*83,\s*9/.test(await probe("p.footBackground()")), String(await probe("p.footBackground()")));
    ok("a straight lift does not tilt the card", /^0deg$/.test(await probe("p.cardRotate()")), await probe("p.cardRotate()"));

    // The shrink keeps going as the drag gets longer, instead of stopping at the
    // threshold the way the old progress-driven scale did.
    await js("p.dragTo(120, 0);");
    const shrinkNear = await probe("p.cardScale()");
    await js("p.dragTo(300, 0);");
    const shrinkFar = await probe("p.cardScale()");
    ok("dragging further shrinks the card more", shrinkFar < shrinkNear, `${shrinkNear} at 120px -> ${shrinkFar} at 300px`);
    ok("the shrink has a floor, it does not vanish", shrinkFar >= 0.7, `scale ${shrinkFar} at 300px`);
    ok("a sideways drag tilts the card", parseFloat(await probe("p.cardRotate()")) > 0, await probe("p.cardRotate()"));
    ok("the deck starts gliding forward with the drag", (await probe("p.deck1Dy()")) < 22, `deck-1 dy ${await probe("p.deck1Dy()")}`);

    await js("p.dragTo(10, 10);");
    ok("no tint before the threshold is crossed", (await probe("p.tintOpacity()")) === 0, String(await probe("p.tintOpacity()")));
    ok("the info bar drops its tint below the threshold", (await probe("p.footBackground()")) === "", String(await probe("p.footBackground()")));
    // Release below the threshold: the card glides back and every visual clears.
    await js("p.dragEnd(10, 10);");
    await sleep(450);
    ok("a cancelled drag clears the tint", (await probe("p.tintOpacity()")) === 0, String(await probe("p.tintOpacity()")));
    ok("a cancelled drag restores the card", (await probe("p.cardScale()")) === 1 && (await probe("p.cardTranslate()")) === "", `${await probe("p.cardScale()")} ${await probe("p.cardTranslate()")}`);
    ok("a cancelled drag restores the info bar", (await probe("p.footBackground()")) === "", String(await probe("p.footBackground()")));
    ok("a cancelled drag puts the deck back", (await probe("p.deck1Dy()")) === 22, `deck-1 dy ${await probe("p.deck1Dy()")}`);
    ok("a cancelled drag decides nothing", (await status(first)) === "pending", await status(first));

    // ---- in-card zoom ----
    ok("the card starts unzoomed", (await probe("p.cardZoomScale()")) === 1, String(await probe("p.cardZoomScale()")));
    await js("p.wheelCard();");
    ok("the wheel zooms the card in place", (await probe("p.cardZoomScale()")) > 1, String(await probe("p.cardZoomScale()")));
    ok("zooming shows a readout", /%/.test(await probe("p.zoomReadout()") || "") && (await probe("p.zoomReadoutOn()")), String(await probe("p.zoomReadout()")));
    await js("p.wheelCard(); p.wheelCard();");
    ok("a meaningful zoom makes the card pannable", (await probe("p.cardIsPannable()")) === true, String(await probe("p.cardZoomScale()")));
    await press("ArrowLeft");
    await sleep(150);
    ok("arrows pan a zoomed card instead of deciding", (await status(first)) === "pending", await status(first));

    // Zoom is anchored at the cursor: the pixel under the cursor must stay under
    // it. The element box fills the frame and the photo is letterboxed inside it,
    // so the box is NOT the photo: measure the contained photo, undoing the
    // current zoom to recover the untransformed box.
    const anchor = await probe(`(() => {
      window.__shotpileTest.resetCardZoom();
      const img = document.querySelector('#card .imgwrap img');
      const wrap = document.querySelector('#card .imgwrap');
      const contentRect = () => {
        const b = img.getBoundingClientRect();
        const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
        const scale = m.a || 1;
        const bw = b.width / scale, bh = b.height / scale;
        const k = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
        const cw = img.naturalWidth * k * scale, ch = img.naturalHeight * k * scale;
        const ccx = b.left + b.width / 2, ccy = b.top + b.height / 2;
        return { left: ccx - cw / 2, top: ccy - ch / 2, width: cw, height: ch, cx: ccx, cy: ccy };
      };
      const before = contentRect();
      // On the photo, not at a fraction of the frame: a letterboxed photo leaves
      // most of the frame empty, with no pixel under the cursor to anchor.
      const cx = before.left + before.width * 0.72, cy = before.cy;
      const frac = (cx - before.left) / before.width;
      wrap.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, deltaY: -100 }));
      const after = contentRect();
      const landed = after.left + frac * after.width;
      const landedY = after.top + ((cy - before.top) / before.height) * after.height;
      return {
        drift: Number((landed - cx).toFixed(3)), driftY: Number((landedY - cy).toFixed(3)),
        frac: Number(frac.toFixed(4)), beforeW: Number(before.width.toFixed(2)), afterW: Number(after.width.toFixed(2)),
      };
    })()`);
    ok("zoom anchors on the cursor, not the corner", Math.abs(anchor.drift) < 4 && Math.abs(anchor.driftY) < 4, JSON.stringify(anchor));
    ok("the anchored point is genuinely on the photo", anchor.frac > 0 && anchor.frac < 1, `frac ${anchor.frac}`);
    ok("zooming in grows the photo", anchor.afterW > anchor.beforeW, `${anchor.beforeW} -> ${anchor.afterW}`);
    await js("p.resetCardZoom();");
    ok("resetting restores 100% and swiping", (await probe("p.cardZoomScale()")) === 1 && (await probe("p.cardIsPannable()")) === false, String(await probe("p.cardZoomScale()")));
    const nat = await probe("p.imgNatural()");
    ok("the card image loads at full size", nat && nat.w === 2000 && nat.h === 1500, JSON.stringify(nat));

    // The info bar must never cost the photo any height, and the photo must fit
    // its frame. It is a translucent overlay, and its resting background is a
    // gradient (the drag replaces it with the action colour in the same shape).
    const geo = await probe("p.cardGeometry()");
    ok("the image is fully visible inside its frame", geo && geo.imgOverflowsWrap === 0, JSON.stringify(geo));
    ok("the info bar does not take layout height", geo && geo.footInFlow === false, geo ? `foot position ${geo.footPosition}` : "no card");
    ok("the info bar rests on a gradient scrim", geo && /linear-gradient/.test(geo.footBg), geo ? geo.footBg : "no card");
    ok("the photo gets the whole card height", geo && geo.imgBoxH >= geo.cardH - 3, geo ? `photo box ${geo.imgBoxH}px vs card ${geo.cardH}px` : "no card");
    ok("the overlay is shallow", geo && geo.footShare <= 0.3, geo ? `foot is ${Math.round(geo.footShare * 100)}% of the card` : "no card");
    ok("the name does not wrap", geo && geo.fnameLines === 1, geo ? `name wraps to ${geo.fnameLines} lines` : "no card");

    // ---- card right-click menu ----
    await js(`const n = document.querySelector(".card[data-id]"); const r = n.getBoundingClientRect();
      n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));`);
    const cardMenu = await probe("[...document.querySelectorAll('.menu .menu-label')].map((n) => n.textContent)");
    ok("right-clicking a card offers copy image and copy file name", cardMenu?.includes("Copy image") && cardMenu?.includes("Copy file name"), JSON.stringify(cardMenu));
    await press("Escape");

    // ---- photo viewer ----
    await js("p.openViewer();");
    await waitFor("p.viewerOpen()");
    ok("the viewer opens on the current file", (await probe("p.viewerName()")) === first, await probe("p.viewerName()"));
    ok("viewer starts at 100%", (await probe("p.viewerZoom()")) === "100%", await probe("p.viewerZoom()"));
    ok("viewer shows the pixel size", (await waitFor("p.viewerDims()")) === "2000 × 1500", await probe("p.viewerDims()"));
    await js("document.querySelector('.viewer-frame').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, cancelable: true, bubbles: true }));");
    ok("scrolling zooms the viewer", (await probe("p.viewerZoom()")) !== "100%", await probe("p.viewerZoom()"));
    // Dialogs sit above the viewer, and Escape closes the topmost first.
    await press("l", CTRL_SHIFT);
    await waitFor("!p.modalHidden()");
    ok("the log opens above the viewer", await probe(`(() => { const m = document.querySelector('#modal .modal').getBoundingClientRect(); return !!document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2)?.closest('#modal'); })()`));
    // Enter on the log's focused Close button belongs to the log: the viewer
    // used to take it, close itself, and leave the log open over the review.
    await press("Enter");
    ok("Enter closes a dialog over the viewer, not the viewer", (await waitFor("p.modalHidden()")) === true && (await probe("p.viewerOpen()")) === true, `modal hidden ${await probe("p.modalHidden()")}, viewer ${await probe("p.viewerOpen()")}`);
    await press("l", CTRL_SHIFT);
    await waitFor("!p.modalHidden()");
    await press("Escape");
    ok("Escape closes the dialog before the viewer", (await waitFor("p.modalHidden()")) === true && (await probe("p.viewerOpen()")) === true);
    await press("Escape");
    ok("Escape closes the viewer", !(await probe("p.viewerOpen()")));
    await js("p.clickCard();");
    ok("clicking the card opens the viewer", await waitFor("p.viewerOpen()"));
    await press(" ");
    ok("Space closes the viewer", !(await probe("p.viewerOpen()")));
    await press(" ");
    ok("Space opens the viewer from the review", await waitFor("p.viewerOpen()"));
    await press("Escape");
    ok("the viewer leaves the decision alone", (await status(first)) === "pending", await status(first));
    // With focus left on a review button, Enter reached that button through
    // the viewer and decided the card behind the photo.
    await js("p.reset(); p.focusSel('.act-keep');");
    await press(" ");
    await waitFor("p.viewerOpen()");
    ok("the viewer takes focus and makes the app behind it inert", (await probe("p.appInert()")) === true && (await probe("p.focusedLabel()")) === "Close", `inert ${await probe("p.appInert()")}, focus ${await probe("p.focusedLabel()")}`);
    await press("Enter");
    await sleep(150);
    ok("Enter closes the viewer and decides nothing", (await probe("p.viewerOpen()")) === false && (await probe("p.logFilter('decide:').length")) === 0 && (await status(first)) === "pending", JSON.stringify(await probe("p.logFilter('decide:')")));
    ok("closing the viewer gives focus back", (await probe("p.focusedIs('.act-keep')")) === true && (await probe("p.appInert()")) === false, String(await probe("p.focusedLabel()")));
    await js("document.activeElement.blur();");

    // ---- two swipes in a row ----
    // The regression this guards: gestures were bound per render with the top
    // card captured in a closure, so after the first promotion every drag moved
    // a detached node. The visible card sat still, showed no tint or stamp, and
    // the decision still landed on release.
    const swipeStart = await probe("p.topNodeId()");
    const swipeNext = await probe("p.deck1NodeId()");
    await js("p.dragStart(); p.dragTo(300, 0); p.dragEnd(300, 0);");
    await waitFor(`p.topNodeId() !== ${JSON.stringify(swipeStart)}`);
    await sleep(120);
    ok("a swipe swaps the top card node", (await probe("p.topNodeId()")) !== swipeStart);
    ok("the waiting card is promoted, not rebuilt", (await probe("p.topNodeId()")) === swipeNext, `${swipeNext} vs ${await probe("p.topNodeId()")}`);
    ok("the swiped card is now kept", (await status(first)) === "kept", await status(first));
    ok("a swipe leaves the new top fully opaque", Number(await probe("p.topOpacity()")) === 1, String(await probe("p.topOpacity()")));
    ok("a swipe leaves no drag offset on the new top", (await probe("p.topInlineTransform()")) === "", String(await probe("p.topInlineTransform()")));
    ok("the deck accepts input again after a swipe", await waitFor("!p.deckInert()"));
    // Guards the `.deck.inert` CSS rule itself, not just the class toggle.
    const pe = String(await probe("p.deckPointerEvents()"));
    ok("the inert class really disables pointer events", pe === "auto|none|auto", pe);

    await js("p.dragStart(); p.dragTo(-150, 0);");
    ok("the second swipe moves the visible card", /-150px/.test(await probe("p.cardTranslate()")), `translate "${await probe("p.cardTranslate()")}"`);
    ok("the second swipe shows its stamp", (await probe("p.stampOpacity('left')")) > 0.5, String(await probe("p.stampOpacity('left')")));
    ok("the second swipe tints the visible card", (await probe("p.tintOpacity()")) > 0, String(await probe("p.tintOpacity()")));
    await js("p.dragEnd(-150, 0);");
    await waitFor(`p.status(${JSON.stringify(SECOND)}) === "staged"`);
    ok("the second swipe stages the right file", (await status(SECOND)) === "staged", await status(SECOND));
    ok("the tally counts both swipes", JSON.stringify(await probe("p.tally()")) === JSON.stringify({ keep: 1, delete: 1, skip: 0 }), JSON.stringify(await probe("p.tally()")));
    ok("a staged file lights the header badge", (await waitFor("p.stagedCount() === '1'")) === true || (await probe("p.stagedCount()")) === "1", await probe("p.stagedCount()"));

    // Undo brings each card back the way it left.
    await press("z");
    await waitFor(`p.cardName() === ${JSON.stringify(SECOND)}`);
    ok("undo of a delete brings the card back from the left", (await waitFor("p.topAnimateName() === 'fromLeft'", 600)) === true, await probe("p.topAnimateName()"));
    ok("undo restores the staged file", (await status(SECOND)) === "pending", await status(SECOND));
    await sleep(500);
    await press("z");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);
    ok("undo after a swipe lands on the right card", (await probe("p.cardName()")) === first, String(await probe("p.cardName()")));
    ok("undo of a keep brings the card back from the right", (await waitFor("p.topAnimateName() === 'fromRight'", 600)) === true, await probe("p.topAnimateName()"));
    ok("undo takes the decisions off the tally", JSON.stringify(await probe("p.tally()")) === JSON.stringify({ keep: 0, delete: 0, skip: 0 }), JSON.stringify(await probe("p.tally()")));
    await sleep(500);

    // ---- advancing by keyboard must not rebuild the deck ----
    const mark = await probe("p.markStage()");
    const nodeBefore = await probe("p.topNodeId()");
    const waiting = await probe("p.deck1NodeId()");
    await press("ArrowRight");
    ok("a key decision lights its button", await waitFor("p.actionFlashed('keep')", 250));
    await waitFor(`p.topNodeId() !== ${JSON.stringify(nodeBefore)}`);
    ok("the stage survives the advance", await probe(`p.stageIsSame(${JSON.stringify(mark)})`));
    ok("the waiting card becomes the top card", (await probe("p.topNodeId()")) === waiting, `${waiting} vs ${await probe("p.topNodeId()")}`);
    ok("the outgoing card flies out, then is removed", (await waitFor("p.leavingCount() === 0", 1200)) === true, String(await probe("p.leavingCount()")));
    ok("the new top card is fully opaque", Number(await probe("p.topOpacity()")) === 1, String(await probe("p.topOpacity()")));
    ok("the new top card has no leftover offset", (await probe("p.topInlineTransform()")) === "", String(await probe("p.topInlineTransform()")));
    ok("the promoted card is not running an entry animation", (await probe("p.topAnimateName()")) === "none", String(await probe("p.topAnimateName()")));
    ok("the promoted card glides to the top slot", /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(await waitFor("p.topComputedTransform() === 'matrix(1, 0, 0, 1, 0, 0)' && p.topComputedTransform()", 800)), await probe("p.topComputedTransform()"));
    // Depth is however many shots remain, capped at top + 2 upcoming. This queue
    // has 3 items and we are now on #2, so there is only 1 upcoming: 2 cards.
    ok("the deck holds the current card plus what is left", (await probe("p.deckCount()")) === 2, String(await probe("p.deckCount()")));

    // ---- keep, then undo ----
    ok("ArrowRight keeps the card", (await status(first)) === "kept", await status(first));
    ok("view advances after a keep", (await probe("p.cardName()")) === SECOND, String(await probe("p.cardName()")));
    await press("z");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);
    ok("Z undoes the keep", (await status(first)) === "pending", await status(first));
    ok("cursor returns to the undone position", (await probe("p.progress()")) === "1 of 3", await probe("p.progress()"));

    // ---- redo throws it again, and undo takes it back once more ----
    await press("y");
    await waitFor(`p.cardName() === ${JSON.stringify(SECOND)}`);
    ok("Y redoes the keep", (await status(first)) === "kept", await status(first));
    ok("redo advances the deck like a decision", (await probe("p.cardName()")) === SECOND, String(await probe("p.cardName()")));
    await sleep(450);
    await press("z");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);
    ok("undo after a redo walks it back again", (await status(first)) === "pending", await status(first));
    await sleep(450);

    // ---- skip, then undo (the deferred-item case) ----
    await press("ArrowUp");
    await waitFor(`p.cardName() === ${JSON.stringify(SECOND)}`);
    ok("ArrowUp marks the card skipped", (await status(first)) === "skipped", await status(first));
    ok("view advances after a skip", (await probe("p.cardName()")) === SECOND, String(await probe("p.cardName()")));
    await press("z");
    await waitFor(`p.cardName() === ${JSON.stringify(first)}`);
    ok("undo of a skip restores the status", (await status(first)) === "pending", await status(first));
    ok("undo of a skip shows the deferred card", (await probe("p.cardName()")) === first, await probe("p.cardName()"));
    // It used to seek to the back of the queue, so deciding it ended the pass and
    // dropped every item in between.
    ok("undo of a skip restores the queue order", (await probe("p.progress()")) === "1 of 3", await probe("p.progress()"));
    ok("undo of a skip brings the card back from above", (await waitFor("p.topAnimateName() === 'fromTop'", 600)) === true, await probe("p.topAnimateName()"));
    await sleep(500);

    // ---- Escape leaves the review, like the Back button does ----
    await js("p.reset();");
    const wasReviewing = await probe("p.view()");
    await press("Escape");
    await waitFor("p.view() === 'months'");
    ok("Escape leaves the review for the library", (await probe("p.view()")) === "months" && wasReviewing === "review", `${wasReviewing} -> ${await probe("p.view()")}`);
    ok("leaving the review decides nothing", (await probe("p.logFilter('decide:').length")) === 0, JSON.stringify(await probe("p.logFilter('decide:')")));
    await probe("p.clickMonth('2026-09')");
    await waitFor("p.hasCard()");
    ok("the queue reopens where it was left", (await probe("p.progress()")) === "1 of 3", await probe("p.progress()"));

    // ---- holding a key down decides once ----
    await js("p.reset();");
    await press("ArrowRight", 0, { autoRepeat: true });
    await sleep(250);
    ok("an auto-repeated arrow decides nothing", (await probe("p.logFilter('decide:').length")) === 0, JSON.stringify(await probe("p.logFilter('decide:')")));

    // Fresh queue for the staging checks.
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 0");
    await probe("p.clickMonth('2026-09')");
    await waitFor("p.hasCard()");
    const stageA = await probe("p.cardName()");
    ok("reopened queue starts from the first pending file", stageA === first, String(stageA));

    // ---- stage deletions ----
    await press("ArrowLeft");
    await waitFor(`p.status(${JSON.stringify(stageA)}) === "staged"`);
    ok("ArrowLeft stages the deletion", (await status(stageA)) === "staged", await status(stageA));
    ok("the header badge appears once something is staged", await waitFor("p.stagedBtnVisible() && p.stagedCount() === '1'"), await probe("p.stagedCount()"));
    ok("the footer bar stays out of the review", (await probe("p.footbarOn()")) === false);
    const stageB = await waitFor(`p.cardName() !== ${JSON.stringify(stageA)} && p.cardName()`);
    ok("view advances after a stage", stageB === SECOND, String(stageB));
    await sleep(150);
    await press("ArrowLeft");
    await waitFor(`p.status(${JSON.stringify(stageB)}) === "staged"`);
    ok("a second card can be staged", (await status(stageB)) === "staged", String(stageB));
    ok("staged counter reads 2", (await waitFor("p.stagedCount() === '2'")) === true, await probe("p.stagedCount()"));

    // ---- a decided item that is also the cursor must still read as selected ----
    const frontier = await probe("p.cardName()");
    ok("two stages move the frontier to the third file", frontier === THIRD, String(frontier));
    await js("p.clickFilm(0);");
    await waitFor("p.filmCurrent() === 0");
    const sel = await probe("p.filmSelected(0)");
    ok("the selected decided item keeps its ring", sel.shadow === true && sel.aria === "true", JSON.stringify(sel));
    ok("the selected decided item keeps its status marker", sel.status === "staged", JSON.stringify(sel));
    ok("the selected frame is the accent colour, not the status colour", sel.border === "rgb(29, 78, 216)", JSON.stringify(sel));
    await js("p.clickFilm(2);");
    await waitFor(`p.cardName() === ${JSON.stringify(frontier)}`);
    ok("returning lands on the frontier card again", (await probe("p.cardName()")) === frontier, String(await probe("p.cardName()")));

    // ---- a failed write must not advance the queue ----
    const progressBefore = await probe("p.progress()");
    const cardBefore = await probe("p.cardName()");
    await js("p.setFault('decide', true);");
    await press("ArrowRight");
    await waitFor("/Couldn't save/.test(p.toastText() || '')");
    ok("failed write leaves the card on screen", (await waitFor(`p.cardName() === ${JSON.stringify(cardBefore)}`)) === true, `${cardBefore} -> ${await probe("p.cardName()")}`);
    ok("failed write does not advance the counter", (await probe("p.progress()")) === progressBefore, `${progressBefore} -> ${await probe("p.progress()")}`);
    ok("failed write leaves the status untouched", (await status(cardBefore)) === "pending", await status(cardBefore));
    ok("failed write tells the user", /Couldn't save that decision/i.test(await probe("p.toastText()")) && (await probe("p.toastTone()")) === "error", await probe("p.toastText()"));
    ok("failed write reaches the file log", (await probe("p.uiLog()")).some((l) => /^error:api:decide failed/.test(l)), JSON.stringify(await probe("p.uiLog()")));
    await js("p.setFault('decide', false);");

    // ---- Ctrl+Z also undoes ----
    await press("z", CTRL);
    await waitFor(`p.status(${JSON.stringify(stageB)}) === "pending"`);
    ok("Ctrl+Z undoes the most recent stage", (await status(stageB)) === "pending", await status(stageB));
    ok("staged counter drops back to 1", (await waitFor("p.stagedCount() === '1'")) === true, await probe("p.stagedCount()"));
    await sleep(450);
    await press("ArrowLeft");
    await waitFor(`p.status(${JSON.stringify(stageB)}) === "staged"`);
    ok("re-staging restores the count to 2", (await waitFor("p.stagedCount() === '2'")) === true, await probe("p.stagedCount()"));

    // ---- the end of the pass ----
    await sleep(150);
    await js("p.reset();");
    await press("ArrowRight");
    // Pressed while the last card is still leaving: it used to decide that card
    // a second time, here turning the keep into a delete.
    await press("ArrowLeft");
    const fin = await waitFor("p.finaleText()");
    ok("a key during the last card's exit decides nothing more", (await probe("p.logFilter('decide:')")).length === 1 && (await status(THIRD)) === "kept", `${JSON.stringify(await probe("p.logFilter('decide:')"))} ${await status(THIRD)}`);
    ok("finishing the queue shows the pass summary", /September 2026 is sorted/.test(fin || ""), String(fin));
    ok("the summary counts the pass", /1\s*kept/.test(fin || "") && /2\s*to delete/.test(fin || ""), String(fin));
    ok("the summary offers the next month", (await probe("p.finaleFocused()")) === "Next: August 2026", String(await probe("p.finaleFocused()")));
    ok("the summary offers the deletion pile", /Review 2 files to delete/.test(fin || ""), String(fin));
    await js("p.clickFinale('library');");
    await waitFor("p.view() === 'months'");
    ok("the summary leads back to the library, without the sorted month", (await probe("p.monthRows()")).length === 1, JSON.stringify(await probe("p.monthRows()")));
    ok("a note says a sorted month is hidden", /1 sorted month hidden/.test(await probe("document.querySelector('.filter-note')?.textContent || ''")), "");
    await js("document.getElementById('btn-filter').click();");
    await waitFor("document.querySelector('#modal .modal-head h2')?.textContent === 'Filter'");
    await js("document.querySelector('[data-show-done=\"true\"]').click();");
    await waitFor("document.querySelectorAll('.month').length === 2");
    ok("the filter can show sorted months", (await probe("p.monthRows()")).length === 2, JSON.stringify(await probe("p.monthRows()")));
    ok("the filter choice is saved", /"showDone":true/.test(await probe("localStorage.getItem('shotpile.prefs')")), "");
    await js("document.querySelector('[data-show-done=\"false\"]').click();");
    await waitFor("document.querySelectorAll('.month').length === 1");
    await js("document.querySelector('#modal .foot button').click();");
    ok("hiding them again works and the dialog closes", (await probe("p.monthRows()")).length === 1 && (await probe("document.getElementById('modal').hidden")) === true, "");
    ok("the toast follows the theme", (await probe("getComputedStyle(document.getElementById('toast')).backgroundColor")) !== "rgb(233, 238, 245)", "");
    ok("the footer bar shows in the library", await waitFor("p.footbarOn()"));
    ok("the footer bar pluralises", /2 screenshots marked for deletion/.test(await probe("p.footbarText()")), await probe("p.footbarText()"));

    // ---- the deletion pile ----
    await probe("p.clickStagedBtn()");
    await waitFor("p.pileNames().length === 2");
    ok("the pile shows every staged file", (await probe("p.pileNames().length")) === 2, JSON.stringify(await probe("p.pileNames()")));
    await js("p.clickPutBack(0);");
    await waitFor("p.pileNames().length === 1");
    ok("put back returns a file to the unsorted pile", (await status(stageA)) === "pending", await status(stageA));
    ok("put back updates the badge", (await waitFor("p.stagedCount() === '1'")) === true, await probe("p.stagedCount()"));
    await press("z", CTRL);
    await waitFor("p.pileNames().length === 2");
    ok("undo in the pile puts the file back on it", (await status(stageA)) === "staged", await status(stageA));
    // The file is back either way; a failed count refresh used to swallow the
    // confirmation and its Undo.
    await js("p.setFault('summary', true); p.clickPutBack(0);");
    await waitFor("p.pileNames().length === 1");
    ok("put back confirms even when the counter refresh fails", /is back in the unsorted pile/.test(await waitFor("/back in the unsorted/.test(p.toastText() || '') && p.toastText()")), await probe("p.toastText()"));
    await press("z", CTRL);
    await waitFor("p.pileNames().length === 2");
    await waitFor("p.stagedCount() === '2'");

    // ---- commit dialog: Enter must not confirm ----
    await js("p.reset();");
    const toastBefore = await probe("p.toastOn()");
    await js("p.clickPileCommit();");
    await waitFor("!p.modalHidden()");
    ok("commit dialog opens", (await probe("p.modalHidden()")) === false);
    // The toast sat above the backdrop: its Undo re-staged a file between the
    // confirmation's preview and the commit.
    ok("a dialog puts away the toast and its Undo", toastBefore === true && (await probe("p.toastOn()")) === false && (await waitFor("p.visibility('#toast') === 'hidden'", 800)) === true, `before ${toastBefore}, after ${await probe("p.toastOn()")} ${await probe("p.visibility('#toast')")}`);
    ok("focus starts on the safe option", (await probe("p.focusedLabel()")) === "Cancel", await probe("p.focusedLabel()"));
    // The pile page is the preview; the dialog does not repeat it.
    ok("the delete confirmation does not repeat the grid", (await probe("document.querySelectorAll('#modal .tile, #modal img').length")) === 0);
    ok("the delete confirmation says how many and how much", /2 screenshots \(/.test(await probe("document.getElementById('modal-body').textContent")), await probe("document.getElementById('modal-body').textContent"));
    ok("the confirm button counts the files", /Move 2 files/.test(await probe("document.querySelector('#modal-foot .danger').textContent")), await probe("document.querySelector('#modal-foot .danger').textContent"));
    await press("Enter");
    await waitFor("p.modalHidden()");
    ok("Enter closes the dialog", (await probe("p.modalHidden()")) === true);
    ok("Enter did not delete anything", (await probe("p.logFilter('commit:').length")) === 0, JSON.stringify(await probe("p.logFilter('commit:')")));
    ok("staged files survive the dismissed dialog", (await probe("p.stagedCount()")) === "2", await probe("p.stagedCount()"));

    // ---- Escape also aborts ----
    await js("p.clickPileCommit();");
    await waitFor("!p.modalHidden()");
    await press("Escape");
    await waitFor("p.modalHidden()");
    ok("Escape closes the dialog", (await probe("p.modalHidden()")) === true);
    ok("Escape did not delete anything", (await probe("p.logFilter('commit:').length")) === 0);

    // ---- clicking outside the modal also aborts, without leaking a handler ----
    await js("p.clickPileCommit();");
    await waitFor("!p.modalHidden()");
    await js("document.getElementById('modal').click()");
    await waitFor("p.modalHidden()");
    ok("backdrop click closes the dialog", (await probe("p.modalHidden()")) === true);
    ok("backdrop click did not delete anything", (await probe("p.logFilter('commit:').length")) === 0);
    await press("?", SHIFT);
    await waitFor("!p.modalHidden()");
    ok("? opens the keyboard shortcuts", (await probe("p.modalTitle()")) === "Keyboard shortcuts", await probe("p.modalTitle()"));
    await press("Escape");
    ok("Escape closes any dialog", (await waitFor("p.modalHidden()")) === true);

    // ---- F11 toggles the real window ----
    // WebView2 has no F11 of its own, so this is our window command; the fake
    // flips its own flag the same way the window would.
    await press("F11");
    ok("F11 puts the window into fullscreen", (await waitFor("p.windowState().fullscreen === true")) === true, JSON.stringify(await probe("p.windowState()")));
    await press("F11");
    ok("F11 leaves fullscreen again", (await waitFor("p.windowState().fullscreen === false")) === true, JSON.stringify(await probe("p.windowState()")));

    // ---- actually commit ----
    await js("p.clickPileCommit();");
    await waitFor("!p.modalHidden()");
    ok("confirm button is present", await probe("p.clickConfirmInModal()"));
    await waitFor("p.logFilter('commit:').length > 0");
    ok("commit moved exactly 2 files", (await probe("p.logFilter('commit:')"))[0] === "commit:2", JSON.stringify(await probe("p.logFilter('commit:')")));
    ok("the badge goes once nothing is staged", (await waitFor("!p.stagedBtnVisible()")) === true);
    ok("the commit reports what it freed", /Moved 2 screenshots to the Recycle Bin, .* freed/.test(await waitFor("/Moved/.test(p.toastText() || '') && p.toastText()")), await probe("p.toastText()"));
    ok("the pile shows its empty state", /Nothing marked for deletion/.test(await waitFor("/Nothing marked/.test(p.viewText() || '') && p.viewText()")), await probe("p.viewText()"));
    ok("footbar hides when nothing is staged", (await probe("p.footbarOn()")) === false);

    // ---- undo after a commit must not resurrect a file in the Recycle Bin ----
    await press("z", CTRL);
    await sleep(300);
    ok("undo after a commit leaves committed files deleted", (await status(stageA)) === "deleted" && (await status(stageB)) === "deleted", `${await status(stageA)} / ${await status(stageB)}`);

    // ---- a rescan preserves decisions ----
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months'");
    await js("document.getElementById('btn-scan').click();");
    await waitFor("p.logFilter('scan:').length > 0");
    await sleep(200);
    ok("rescan keeps the deleted status", (await status(first)) === "deleted", await status(first));

    // ---- DevTools and the file log ----
    await press("F12");
    ok("F12 asks the backend to open DevTools", await waitFor("p.devtoolsCalled()"));
    await press("l", CTRL_SHIFT);
    await waitFor("!p.modalHidden()");
    ok("Ctrl+Shift+L opens the log viewer", (await probe("p.modalHidden()")) === false);
    ok("log viewer shows the log text", /fake log line/.test((await probe("p.logModalText()")) || ""), await probe("p.logModalText()"));
    await press("Escape");
    ok("Escape closes the log viewer", (await waitFor("p.modalHidden()")) === true);

    // ---- a counter-refresh failure must not roll back a saved decision ----
    await js("p.resetShots();");
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 0");
    await probe("p.clickMonth('2026-09')");
    await waitFor("p.hasCard()");
    const rbCard = await probe("p.cardName()");
    await js("p.setFault('summary', true);");
    await press("ArrowLeft");
    await waitFor(`p.status(${JSON.stringify(rbCard)}) === "staged"`);
    ok("stage persists even when the counter refresh fails", (await status(rbCard)) === "staged", await status(rbCard));
    ok("card advances even when the counter refresh fails", (await waitFor(`p.cardName() !== ${JSON.stringify(rbCard)}`)) === true, `${rbCard} -> ${await probe("p.cardName()")}`);

    // ---- an undo from another queue stays out of this one ----
    await sleep(300);
    const beforeOut = await probe("p.cardName()");
    await js("p.setFault('undoOutOfScope', true);");
    await press("z");
    await waitFor("/not in this queue/.test(p.toastText() || '')");
    ok("an out-of-scope undo says so", /not in this queue/.test(await probe("p.toastText()")), await probe("p.toastText()"));
    ok("an out-of-scope undo keeps the review going", (await probe("p.cardName()")) === beforeOut, `${beforeOut} -> ${await probe("p.cardName()")}`);

    // ---- nothing opens while a commit is moving files ----
    // Decisions and undo wait for the commit, so a review opened meanwhile
    // ignored every key.
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 0");
    await js("p.reset(); p.clickCommit();");
    ok("the footer's delete button opens the pile first", (await waitFor("p.view() === 'staged' && p.pileNames().length > 0")) === true, await probe("p.view()"));
    await js("p.setFault('commitDelayMs', 1500); p.clickPileCommit();");
    await waitFor("!p.modalHidden()");
    await probe("p.clickConfirmInModal()");
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months'");
    await probe("p.clickMonth('2026-09')");
    ok("a month will not open while files are being moved", /Moving files to the Recycle Bin/.test(await waitFor("/Moving files/.test(p.toastText() || '') && p.toastText()", 600)) && (await probe("p.view()")) === "months", `${await probe("p.toastText()")} / ${await probe("p.view()")}`);
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    await js("p.clickMenuItem('shots-b');");
    ok("nor will another folder", (await probe("p.folderName()")) === "Screenshots" && /Moving files/.test(await probe("p.toastText()")), `${await probe("p.folderName()")} / ${await probe("p.toastText()")}`);
    await js("p.setFault('commitDelayMs', 0);");
    await waitFor("p.logFilter('commit:').length > 0", 3000);
    await waitFor("!document.getElementById('btn-commit').disabled", 3000);
    ok("the commit still finishes", (await status(rbCard)) === "deleted", await status(rbCard));

    // ---- checking the pile card by card ----
    const PILE_B = "Screenshot 2026-08-19 18-22-30.png";
    await js(`p.setStatus(${JSON.stringify(PILE_B)}, 'staged'); p.setStatus(${JSON.stringify(FIRST)}, 'staged'); p.setStatus(${JSON.stringify(SECOND)}, 'staged');`);
    await js("p.reset(); p.clickStagedBtn();");
    await waitFor("p.pileNames().length === 2");
    ok("the pile shows this folder's files only", !(await probe("p.pileNames()")).includes(PILE_B), JSON.stringify(await probe("p.pileNames()")));
    await js("[...document.querySelectorAll('.pile-actions .btn')].find((b) => /one by one/.test(b.textContent)).click();");
    await waitFor("p.hasCard()");
    ok("checking the pile stays in this folder", (await probe("p.progress()")) === "1 of 2" && (await probe("p.cardName()")) === FIRST, `${await probe("p.progress()")} ${await probe("p.cardName()")}`);
    // Escape leaves the pile review for the pile, not for the library: it goes
    // back where the review came from, same as the summary's Back button.
    await press("Escape");
    await waitFor("p.view() === 'staged'");
    ok("Escape returns the pile review to the pile", (await probe("p.view()")) === "staged", await probe("p.view()"));
    ok("Escape decided nothing", (await probe("p.logFilter('decide:').length")) === 0, JSON.stringify(await probe("p.logFilter('decide:')")));
    await js("[...document.querySelectorAll('.pile-actions .btn')].find((b) => /one by one/.test(b.textContent)).click();");
    await waitFor("p.hasCard()");
    ok("the pile review reopens where it was left", (await probe("p.progress()")) === "1 of 2", `${await probe("p.progress()")} ${await probe("p.cardName()")}`);
    // A skip would write "skipped" and silently take the file off the pile.
    ok("checking the pile offers no skip", (await probe("p.hasSel('.act-skip')")) === false);
    await press("ArrowUp");
    await sleep(200);
    ok("ArrowUp does not skip a file off the pile", (await status(FIRST)) === "staged" && (await probe("p.logFilter('decide:').length")) === 0, `${await status(FIRST)} ${JSON.stringify(await probe("p.logFilter('decide:')"))}`);
    await press("ArrowRight");
    await waitFor(`p.status(${JSON.stringify(FIRST)}) === "kept"`);
    ok("keeping a file from the pile updates the badge", (await waitFor("p.stagedCount() === '1'")) === true, await probe("p.stagedCount()"));
    await js(`p.setStatus(${JSON.stringify(PILE_B)}, 'pending');`);

    // ---- a file with no preview ----
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 0");
    await probe("p.clickMonth('2026-08')");
    await waitFor("p.hasCard()");
    ok("a HEIC card explains why there is no preview", /No preview for \.heic files/.test(await probe("p.cardPlaceholder()") || ""), await probe("p.cardPlaceholder()"));
    await press(" ");
    await sleep(200);
    ok("Space does not open a viewer for an unpreviewable file", (await probe("p.viewerOpen()")) === false);
    // An undo pressed while the last card is still leaving used to be dropped,
    // and the summary then covered the card it should have brought back.
    const lastOne = await probe("p.cardName()");
    await press("ArrowLeft");
    await sleep(60);
    await press("z");
    await sleep(700);
    ok("undo during the last card's exit brings it back", (await status(lastOne)) === "pending" && (await probe("p.cardName()")) === lastOne && !(await probe("p.finaleText()")), `${await status(lastOne)} ${await probe("p.cardName()")} ${await probe("p.finaleText()")}`);

    // ---- the library keeps its scroll position across a review ----
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months'");
    await js("p.addOldMonths(30); document.getElementById('btn-scan').click();");
    await waitFor("p.monthRows().length > 20", 3000);
    await js("p.setViewScroll(700);");
    const scrolled = await probe("p.viewScroll()");
    await probe("p.clickMonth('2026-09')");
    await waitFor("p.hasCard()");
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 20");
    await sleep(150);
    ok("coming back from a review keeps the library's scroll position", scrolled > 0 && (await probe("p.viewScroll()")) === scrolled, `${scrolled} -> ${await probe("p.viewScroll()")}`);
    // The pile is a page of its own and opens at the top, not wherever the
    // library happened to be scrolled.
    await js("p.stageOldMonths(); document.getElementById('btn-scan').click();");
    await waitFor("p.logFilter('scan:').length > 1 && p.stagedBtnVisible()", 3000);
    await sleep(150);
    await js("p.setViewScroll(700);");
    await probe("p.clickStagedBtn()");
    await waitFor("p.pileNames().length > 20");
    ok("the pile opens at the top", (await probe("p.viewScroll()")) === 0, String(await probe("p.viewScroll()")));
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months'");
    await js("p.removeOldMonths(); document.getElementById('btn-scan').click();");
    await waitFor("p.monthRows().length === 2", 3000);

    // ---- a long queue renders only the filmstrip items that fit ----
    // Three items were too few to expose the old bug: the strip rendered a
    // fixed window and, once the thumbs grew to fill less width, the current
    // item sat clipped off-screen. Add a month long enough to matter.
    await js("p.addMonthShots('2026-07', 40); document.getElementById('btn-scan').click();");
    await waitFor("document.querySelector('.month[data-month=\"2026-07\"]') !== null", 3000);
    await probe("p.clickMonth('2026-07')");
    await waitFor("p.hasCard()");
    const longShort = await probe("p.filmBounds()");
    ok("a long queue keeps the current filmstrip item on screen", longShort && longShort.currentVisible && longShort.outside === 0, JSON.stringify(longShort));
    await js("p.setFilmstripHeight(200);");
    await waitFor("p.filmBounds() && p.filmBounds().outside === 0");
    const longTall = await probe("p.filmBounds()");
    ok("a taller strip renders fewer items, all on screen", longTall && longTall.count < longShort.count && longTall.outside === 0 && longTall.currentVisible, `${JSON.stringify(longShort)} -> ${JSON.stringify(longTall)}`);
    await js("p.setFilmstripHeight(52);");
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months'");
    await js("p.removeMonthShots(); document.getElementById('btn-scan').click();");
    await waitFor("document.querySelector('.month[data-month=\"2026-07\"]') === null", 3000);

    // ---- folders ----
    await js("p.reset();");
    await js("p.backToMonths();");
    await waitFor("p.view() === 'months' && p.monthRows().length > 0");
    // A scan that finished after a forget added the folder straight back.
    await js("p.setFault('scanDelayMs', 1500); document.getElementById('btn-scan').click();");
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    await js("p.clickMenuItem('Forget');");
    ok("a folder cannot be forgotten mid-scan", /Wait for the scan to finish first/.test(await waitFor("/Wait for the scan/.test(p.toastText() || '') && p.toastText()", 600)) && (await probe("p.modalHidden()")) === true, `${await probe("p.toastText()")} / modal hidden ${await probe("p.modalHidden()")}`);
    await js("p.setFault('scanDelayMs', 0);");
    await waitFor("p.logFilter('scan:').length > 0", 3000);
    await waitFor("!document.getElementById('btn-scan').disabled", 3000);
    await js("p.reset();");
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    ok("the folder menu lists every saved folder", JSON.stringify(await probe("p.menuItems()")) === JSON.stringify(["Screenshots", "shots-b", "Add a folder…", "Forget “Screenshots”…"]), JSON.stringify(await probe("p.menuItems()")));
    await js("p.clickMenuItem('shots-b');");
    await waitFor("p.folderName() === 'shots-b' && p.monthRows().length > 0");
    ok("switching folders shows that folder's library", /August/.test((await probe("p.monthRows()"))[0] || "") && (await probe("p.monthRows()")).length === 1, JSON.stringify(await probe("p.monthRows()")));
    // The deletion pile belongs to its folder: one marked in Screenshots is not
    // on shots-b's pile, and comes back with Screenshots.
    await js("for (const s of window.__shots.values()) if (s.root_id === 1 && s.status === 'pending') { s.status = 'staged'; break; }");
    await js("document.getElementById('btn-scan').click();");
    await waitFor("p.logFilter('scan:').length > 0 && !document.getElementById('btn-scan').disabled", 3000);
    ok("another folder's pile stays out of this one", (await probe("p.stagedBtnVisible()")) === false, String(await probe("p.stagedBtnVisible()")));
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    await js("p.clickMenuItem('Screenshots');");
    await waitFor("p.folderName() === 'Screenshots' && p.stagedBtnVisible()", 2000);
    ok("each folder keeps its own pile", (await probe("p.stagedBtnVisible()")) === true, String(await probe("p.stagedBtnVisible()")));
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    await js("p.clickMenuItem('shots-b');");
    await waitFor("p.folderName() === 'shots-b'");
    await js("p.clickFolderChip();");
    await waitFor("p.menuItems().length > 0");
    await js("p.clickMenuItem('Forget');");
    await waitFor("!p.modalHidden()");
    ok("forgetting a folder asks first", /Forget “shots-b”\?/.test(await probe("p.modalTitle()")), await probe("p.modalTitle()"));
    ok("forgetting starts on Cancel", (await probe("p.focusedLabel()")) === "Cancel", await probe("p.focusedLabel()"));
    await probe("p.clickConfirmInModal()");
    await waitFor("p.folderName() === 'Screenshots'");
    ok("a forgotten folder hands over to the next one", (await probe("p.folderName()")) === "Screenshots", await probe("p.folderName()"));
    ok("forgetting touches no files", (await probe("p.logFilter('forget:')")).length === 1 && (await probe("p.logFilter('commit:')")).length === 0, JSON.stringify(await probe("p.logFilter('forget:')")));

    // ---- picking a folder scans it and lands on the library ----
    await js("p.resetToSetup();");
    await waitFor("/Choose a folder/.test(p.viewText() || '')");
    ok("setup view appears when there are no roots", /Choose a folder/.test(await probe("p.viewText()")), await probe("p.viewText()"));
    await js("p.reset(); p.setFault('scanDelayMs', 900);");
    await js("p.addFolder();");
    ok("a first scan shows what it is doing", /Looking for screenshots/.test(await waitFor("/Looking for/.test(p.viewText() || '') && p.viewText()", 600)), await probe("p.viewText()"));
    ok("a first scan counts what it finds", /Found 1,280 images so far/.test(await waitFor("/Found 1,280/.test(p.viewText() || '') && p.viewText()", 1500)), await probe("p.viewText()"));
    await waitFor("p.view() === 'months' && p.monthRows().length > 0", 3000);
    await js("p.setFault('scanDelayMs', 0);");
    ok("picking a folder scans it and shows the months", (await probe("p.monthRows().length")) > 0, JSON.stringify(await probe("p.monthRows()")));
    ok("the scan is logged", (await probe("p.logFilter('scan:')")).length > 0, JSON.stringify(await probe("p.logFilter('scan:')")));

    // ---- dark theme ----
    await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(150);
    const bg = await probe("p.bodyBg()");
    const lum = (bg.match(/\d+/g) || []).slice(0, 3).reduce((n, v) => n + Number(v), 0);
    ok("the app follows a dark system theme", lum < 120, bg);
    // The window background is what WebView2 shows before the page paints, so it
    // has to follow the theme too (this is what the fullscreen flash showed).
    await waitFor("p.windowState().background.toLowerCase() === '#0c1017'");
    ok("the native window background follows the dark theme", (await probe("p.windowState().background")).toLowerCase() === "#0c1017", JSON.stringify(await probe("p.windowState()")));
    ok("the splash is gone once the app is up", (await probe("getComputedStyle(document.getElementById('splash')).visibility")) === "hidden", await probe("getComputedStyle(document.getElementById('splash')).visibility"));

    // ---- options: a theme choice beats the system setting ----
    await press(",", CTRL);
    ok("Ctrl+, opens the options", (await waitFor("document.querySelector('.options-sheet') !== null")) === true);
    ok("the options show the versions", /2\.11\.6/.test(await probe("document.querySelector('.about-list').textContent")), await probe("document.querySelector('.about-list')?.textContent"));
    // The app's version has one source: Cargo.toml, read by the Rust
    // build and handed to the fake backend by tests/serve.cjs. It used
    // to be hardcoded "1.0.0" here.
    ok("the About panel carries the app's own version", /v1\.6\.0/.test(await probe("document.querySelector('.about-list').textContent")), await probe("document.querySelector('.about-list')?.textContent"));
    const resetRow = await probe("p.resetShortcutRow()");
    ok("the shortcut reset is on one line in the existing style", resetRow && resetRow.sameLine && resetRow.ghost, JSON.stringify(resetRow));
    ok("the shortcut reset sits in the last shortcut group, not a group of its own", resetRow && resetRow.lastShortcutsGroup && resetRow.noLoneButton, JSON.stringify(resetRow));
    await js("document.querySelector('.segmented [data-theme=light]').click();");
    ok("choosing Light overrides a dark system", (await probe("document.documentElement.dataset.theme")) === "light", await probe("document.documentElement.dataset.theme"));
    ok("the choice is saved", /"theme":"light"/.test(await probe("localStorage.getItem('shotpile.prefs')")), await probe("localStorage.getItem('shotpile.prefs')"));
    await js("document.querySelector('.segmented [data-theme=system]').click();");
    ok("System follows the system again", (await probe("document.documentElement.dataset.theme")) === "dark", await probe("document.documentElement.dataset.theme"));
    await js("[...document.querySelectorAll('.options-sheet .btn')].find((b) => b.textContent === 'Open').click();");
    ok("Open shows the data folder", (await waitFor("p.logFilter('reveal:data').length > 0")) === true, JSON.stringify(await probe("p.logFilter('reveal')")));
    await press("Escape");

    // ---- app zoom ----
    await press("=", CTRL);
    ok("Ctrl+= zooms the app in a step", (await waitFor("document.documentElement.style.zoom === '1.1'")) === true, await probe("document.documentElement.style.zoom"));
    await press("-", CTRL);
    await press("-", CTRL);
    ok("Ctrl+- zooms out", (await probe("document.documentElement.style.zoom")) === "0.9", await probe("document.documentElement.style.zoom"));
    ok("the zoom is saved", /"zoom":0.9/.test(await probe("localStorage.getItem('shotpile.prefs')")), await probe("localStorage.getItem('shotpile.prefs')"));
    await press("0", CTRL);
    ok("Ctrl+0 resets the zoom", (await probe("document.documentElement.style.zoom")) === "1", await probe("document.documentElement.style.zoom"));

    // ---- shortcut rebinding ----
    await press(",", CTRL);
    await waitFor("document.querySelector('.options-sheet') !== null");
    await js("document.querySelector('.options-sheet').scrollTop = document.querySelector('.shortcuts-list')?.offsetTop || 0;");
    const initKey = await probe("p.shortcutKey('keep')");
    ok("shortcuts section lists the current key binding", initKey === "ArrowRight", `expected "ArrowRight", got ${initKey}`);
    await probe("p.clickRebindButton('keep')");
    ok("clicking a shortcut key puts it in waiting state", (await waitFor("p.shortcutKeyBusyWaiting('keep')")) === true);
    await press("i");
    ok("pressing a key rebinds the shortcut", (await waitFor("p.shortcutKey('keep') === 'i'")) === true, await probe("p.shortcutKey('keep')"));
    ok("rebinding is persisted", /"keyBindings":\{[^}]*"i":"keep"[^}]*\}/.test(await probe("localStorage.getItem('shotpile.prefs')")), await probe("localStorage.getItem('shotpile.prefs')"));
    // A rebind must be honoured in every view, not only the review. Options was
    // the reported failure: the global handler ignored the binding table.
    ok("Help shows its default key", (await probe("p.shortcutKey('help')")) === "?", await probe("p.shortcutKey('help')"));
    ok("Options names its default chord", (await probe("p.shortcutKey('openOptions')")) === "Ctrl+,", await probe("p.shortcutKey('openOptions')"));
    await probe("p.clickRebindButton('openOptions')");
    await waitFor("p.shortcutKeyBusyWaiting('openOptions')");
    await press("p");
    ok("a key rebinds a global action", (await waitFor("p.shortcutKey('openOptions') === 'p'")) === true, await probe("p.shortcutKey('openOptions')"));
    // Escape is a cancel, not a key that can be captured.
    await probe("p.clickRebindButton('openOptions')");
    await waitFor("p.shortcutKeyBusyWaiting('openOptions')");
    await press("Escape");
    ok("Escape cancels a rebind capture", (await probe("p.shortcutKeyBusyWaiting('openOptions')")) === false && (await probe("p.shortcutKey('openOptions')")) === "p", `${await probe("p.shortcutKeyBusyWaiting('openOptions')")} / ${await probe("p.shortcutKey('openOptions')")}`);
    await press("Escape");
    await waitFor("!document.querySelector('.options-sheet')");
    await press("p");
    ok("the rebound key opens Options from the library", (await waitFor("document.querySelector('.options-sheet') !== null")) === true);
    ok("Options shows a decisions donut", (await waitFor("document.querySelector('.options-sheet .donut-seg') !== null")) === true);
    ok("the donut states its total", (await probe("document.querySelector('.options-sheet .donut-mid b')?.textContent || ''")) !== "");
    await probe("p.clickResetShortcuts()");
    await waitFor("!document.querySelector('.options-sheet')");
    await press(",", CTRL);
    await waitFor("document.querySelector('.options-sheet') !== null");
    const resetKey = await probe("p.shortcutKey('keep')");
    ok("resetting shortcuts restores defaults", resetKey === "ArrowRight", `expected "ArrowRight", got ${resetKey}`);
    ok("reset clears the keyBindings in prefs", !/"keyBindings":/.test(await probe("localStorage.getItem('shotpile.prefs')")), await probe("localStorage.getItem('shotpile.prefs')"));
    await press("Escape");

    // ---- right-click menus ----
    const rightClick = (sel) => js(`const n = document.querySelector(${JSON.stringify(sel)}); const r = n.getBoundingClientRect();
      n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));`);
    await rightClick(".month");
    const monthMenu = await probe("[...document.querySelectorAll('.menu .menu-label')].map((n) => n.textContent)");
    ok("right-clicking a month offers to sort it", monthMenu?.[0] === "Sort this month" && monthMenu.includes("Options"), JSON.stringify(monthMenu));
    await press("Escape");
    ok("Escape closes the context menu", (await probe("document.querySelector('.menu')")) === null);
    const nativeKept = await js(`const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.querySelector("#view").dispatchEvent(ev); return ev.defaultPrevented;`);
    ok("the browser's own menu is replaced", nativeKept === true);
    await press("Escape");
  } catch (e) {
    ok(`run aborted: ${e.message}`, false, e.stack);
  }

  const pageFails = await js("return window.__FAILS;").catch(() => []);

  cleanup();

  for (const r of results) {
    console.log(`${r.pass ? "  PASS" : "  FAIL"} ${r.name}${r.pass || r.detail === undefined ? "" : "  ::  " + r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (pageFails && pageFails.length) console.log("\nPAGE ERRORS:\n" + pageFails.map((f) => "  " + f).join("\n"));
  if (consoleErrors.length) console.log("\nCONSOLE ERRORS:\n" + consoleErrors.map((e) => "  " + e).join("\n"));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${consoleErrors.length} console errors`);
  process.exit(failed.length || consoleErrors.length || (pageFails && pageFails.length) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
