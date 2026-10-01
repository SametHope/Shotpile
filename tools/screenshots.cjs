// Regenerates the README's screenshots and the swipe demo from the real UI.
//
//   npm run screenshots      -> docs/screenshots/*.webp
//
// It serves the real src/ with the fake backend's demo library (the same
// `?demo` data `npm run preview` can show), drives it in headless Chrome with
// real mouse and key input, and captures the result. Nothing here is staged
// by hand: if the UI changes, rerunning this updates the pictures.
//
// WebP, because the same set as PNG and GIF came to 16 MB. Needs Chrome,
// Chromium or Edge (see tests/browser.cjs), and ffmpeg on PATH for the
// animated demo; without ffmpeg the stills are still written. The pictures use
// whatever fonts the machine has; on Windows that is the app's real Segoe UI.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { start } = require("../tests/serve.cjs");
const { launchChrome } = require("../tests/browser.cjs");

const OUT = path.resolve(__dirname, "..", "docs", "screenshots");
const CDP_PORT = 9333;
// The window the stills are taken at, and their pixel density.
const SIZE = { width: 1200, height: 760 };
const SCALE = 2;
// The animated demo is smaller: every frame costs bytes.
const DEMO_SIZE = { width: 960, height: 640 };
const DEMO_FPS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// A pointer drawn into the page, since headless screenshots have no cursor.
const CURSOR = `
  <svg width="26" height="26" viewBox="0 0 26 26" style="display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))">
    <path d="M2 1.5v18.2l4.6-4.1 3.1 6.9 3.1-1.4-3-6.7h6.4z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;

const OVERLAY_CSS = `
  #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; translate: -60px -60px; }
  #demo-cursor .ring { position: absolute; left: -15px; top: -15px; width: 34px; height: 34px; border-radius: 50%;
    background: rgba(29, 78, 216, .22); border: 2px solid rgba(29, 78, 216, .55); scale: .4; opacity: 0;
    transition: scale .15s ease, opacity .15s ease; }
  #demo-cursor.down .ring { scale: 1; opacity: 1; }
  #demo-key { position: fixed; left: 50%; bottom: 26px; z-index: 2147483646; pointer-events: none; display: flex; align-items: center; gap: 10px;
    translate: -50% 10px; opacity: 0; transition: opacity .14s ease, translate .18s ease;
    padding: 8px 14px 8px 8px; border-radius: 14px; background: rgba(15, 23, 42, .86); color: #fff;
    font: 600 14px/1 "Segoe UI", system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  #demo-key.on { opacity: 1; translate: -50% 0; }
  #demo-key kbd { min-width: 34px; height: 34px; display: grid; place-items: center; padding: 0 8px; border-radius: 9px;
    background: #fff; color: #0f172a; font: 700 18px/1 "Segoe UI", system-ui, sans-serif; box-shadow: inset 0 -3px 0 #cbd5e1; }
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}/src/index.html?demo=1`;
  const chrome = await launchChrome({ port: CDP_PORT, windowSize: `${SIZE.width},${SIZE.height}`, profile: "sifter-chrome-shots-profile" });
  const c = chrome.client;
  const done = () => { chrome.close(); server.close(); };
  process.on("exit", done);

  await c.send("Runtime.enable");
  await c.send("Page.enable");

  const js = async (body) => {
    const r = await c.send("Runtime.evaluate", {
      expression: `(async function () { const p = window.__probe;\n${body}\n})()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try { v = await js(`return ${expr};`); } catch { v = undefined; }
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${expr}`);
      await sleep(40);
    }
  };

  // ---------------------------------------------------------------- page setup

  let size = SIZE;
  async function open({ dark = false, viewport = SIZE, scale = SCALE } = {}) {
    size = viewport;
    await c.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: scale, mobile: false });
    await c.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-color-scheme", value: dark ? "dark" : "light" },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ] });
    await c.send("Page.navigate", { url: base });
    await until("window.__probe && p.view() === 'months' && p.monthRows().length > 0");
    await js(`
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(OVERLAY_CSS)};
      document.head.append(style);
      const cur = document.createElement('div');
      cur.id = 'demo-cursor';
      cur.innerHTML = '<div class="ring"></div>' + ${JSON.stringify(CURSOR)};
      const key = document.createElement('div');
      key.id = 'demo-key';
      document.body.append(cur, key);
    `);
    mouse = { x: viewport.width * 0.62, y: viewport.height * 0.9 };
    await settle();
  }

  // Lets images decode and transitions finish before a capture.
  const settle = (ms = 450) => sleep(ms);

  // `height` crops off empty space below the content.
  async function still(name, { height = null } = {}) {
    const clip = height ? { x: 0, y: 0, width: size.width, height, scale: 1 } : undefined;
    const { data } = await c.send("Page.captureScreenshot", { format: "webp", quality: 90, ...(clip ? { clip } : {}) });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }

  // ------------------------------------------------------------ mouse and keys

  let mouse = { x: 0, y: 0 };
  let cursorShown = false;

  async function paintCursor(down) {
    await js(`const n = document.getElementById('demo-cursor');
      n.style.translate = '${mouse.x.toFixed(1)}px ${mouse.y.toFixed(1)}px';
      ${down === undefined ? "" : `n.classList.toggle('down', ${down});`}`);
  }

  async function showCursor() {
    cursorShown = true;
    await paintCursor(false);
  }

  async function hideCursor() {
    cursorShown = false;
    await js("document.getElementById('demo-cursor').style.translate = '-60px -60px';");
  }

  // Moves the real mouse (the app sees genuine pointer events) along an eased
  // path, `ms` long, painting the fake cursor at every step.
  async function moveTo(x, y, { ms = 400, down = false } = {}) {
    const from = { ...mouse };
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      mouse = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t };
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mouse.x, y: mouse.y, button: down ? "left" : "none", buttons: down ? 1 : 0 });
      if (cursorShown) await paintCursor();
      await sleep(ms / steps);
    }
  }

  async function press() {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: mouse.x, y: mouse.y, button: "left", buttons: 1, clickCount: 1 });
    if (cursorShown) await paintCursor(true);
  }

  async function release() {
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mouse.x, y: mouse.y, button: "left", buttons: 0, clickCount: 1 });
    if (cursorShown) await paintCursor(false);
  }

  async function click(selector) {
    const r = await js(`const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null;
      const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
    if (!r) throw new Error(`nothing to click at ${selector}`);
    await moveTo(r.x, r.y, { ms: cursorShown ? 450 : 0 });
    await press();
    await sleep(70);
    await release();
  }

  // The center of the top card, where a drag starts.
  const cardCenter = () => js(`const b = document.querySelector('#stage .deck-top .imgwrap').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);

  const KEYS = {
    ArrowLeft: { vk: 37, code: "ArrowLeft", cap: "←" },
    ArrowRight: { vk: 39, code: "ArrowRight", cap: "→" },
    ArrowUp: { vk: 38, code: "ArrowUp", cap: "↑" },
    z: { vk: 90, code: "KeyZ", text: "z", cap: "Z" },
    Escape: { vk: 27, code: "Escape", cap: "Esc" },
  };

  // A real key press; with `caption`, a keycap shows it on screen too.
  async function key(name, caption = null) {
    const k = KEYS[name];
    if (caption) await js(`const n = document.getElementById('demo-key');
      n.innerHTML = '<kbd>${k.cap}</kbd><span>${caption}</span>';
      n.classList.add('on'); clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove('on'), 850);`);
    const common = { windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, key: name, code: k.code };
    await c.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...common, ...(k.text ? { text: k.text } : {}) });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  // ------------------------------------------------------------------ the GIF

  // Records the page while `script` runs, via the screencast (frames arrive as
  // the page repaints), and turns the frames into a looping animated WebP with
  // ffmpeg. Unlike a GIF it keeps the gradients and costs a fraction of the size.
  async function record(name, script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sifter-demo-"));
    const frames = [];
    c.on("Page.screencastFrame", (f) => {
      frames.push({ data: f.data, t: f.metadata.timestamp });
      c.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await script();
    await c.send("Page.stopScreencast");
    c.on("Page.screencastFrame", () => {});
    if (frames.length < 2) throw new Error("the screencast produced no frames");

    // ffmpeg's concat demuxer takes each frame with how long it stays up.
    let list = "";
    frames.forEach((f, i) => {
      const file = `f${String(i).padStart(5, "0")}.png`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, "base64"));
      const next = frames[i + 1];
      const hold = next ? Math.max(0.001, next.t - f.t) : 1.2;
      list += `file '${file}'\nduration ${hold.toFixed(4)}\n`;
      if (!next) list += `file '${file}'\n`;
    });
    fs.writeFileSync(path.join(dir, "list.txt"), list);
    const out = path.join(OUT, name);
    const r = spawnSync("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt",
      "-vf", `fps=${DEMO_FPS},scale=${DEMO_SIZE.width}:-1:flags=lanczos`,
      "-c:v", "libwebp_anim", "-quality", "80", "-compression_level", "6", "-loop", "0", out,
    ], { cwd: dir, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
    console.log(`  ${name} (${frames.length} frames, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  }

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

  // ------------------------------------------------------------------- scenes

  console.log(`Writing to ${path.relative(process.cwd(), OUT) || OUT}`);

  // 1. The first run: pick a folder.
  await open();
  await js("p.resetToSetup();");
  await until("/Choose a folder/.test(p.viewText() || '')");
  await settle();
  await still("welcome.webp", { height: 640 });

  // 2. The library: the folder at a glance, months grouped by year.
  await open();
  await still("library.webp");

  // 3. Sorting: a card mid-swipe, with the keep stamp and the deck behind.
  await js("p.clickMonth('2026-09');");
  await until("p.hasCard() && p.deckCount() === 3");
  await settle(700);
  await showCursor();
  const at = await cardCenter();
  await moveTo(at.x, at.y + 40, { ms: 0 });
  await press();
  await moveTo(at.x + 150, at.y + 22, { ms: 300, down: true });
  await settle(250);
  await still("review.webp");
  await moveTo(at.x, at.y + 40, { ms: 200, down: true });
  await release();
  await hideCursor();
  await settle(500);

  // 4. The end of a pass: what was decided and what it frees.
  const pass = ["ArrowRight", "ArrowLeft", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowLeft",
    "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowRight", "ArrowLeft"];
  for (const k of pass) {
    if (await js("return !!p.finaleText();")) break;
    await key(k);
    await sleep(420);
  }
  await until("p.finaleText()");
  await settle(900);
  await still("summary.webp", { height: 470 });

  // 5. The deletion pile, and the confirmation that lists every file.
  await click("#btn-staged");
  await until("p.pileNames().length > 0");
  await settle(700);
  await still("pile.webp", { height: 600 });
  await click("#btn-pile-commit");
  await until("!p.modalHidden()");
  await settle(600);
  await still("confirm.webp");
  await key("Escape");

  // 6. Dark mode follows Windows.
  await open({ dark: true });
  await js("p.clickMonth('2026-09');");
  await until("p.hasCard() && p.deckCount() === 3");
  await settle(700);
  await showCursor();
  const atDark = await cardCenter();
  await moveTo(atDark.x, atDark.y + 40, { ms: 0 });
  await press();
  await moveTo(atDark.x - 160, atDark.y + 30, { ms: 300, down: true });
  await settle(250);
  await still("review-dark.webp");
  await moveTo(atDark.x, atDark.y + 40, { ms: 200, down: true });
  await release();
  await hideCursor();

  // 7. The animated demo: two swipes, then the keyboard, with an undo.
  if (!hasFfmpeg) {
    console.log("  swipe.webp skipped: ffmpeg is not on PATH");
  } else {
    await open({ viewport: DEMO_SIZE, scale: 1 });
    await js("p.clickMonth('2026-09');");
    await until("p.hasCard() && p.deckCount() === 3");
    await settle(800);
    await showCursor();
    await record("swipe.webp", async () => {
      await sleep(500);
      // Keep, by mouse.
      let pt = await cardCenter();
      await moveTo(pt.x + 10, pt.y + 30, { ms: 500 });
      await sleep(150);
      await press();
      await moveTo(pt.x + 90, pt.y + 34, { ms: 260, down: true });
      await moveTo(pt.x + 230, pt.y + 20, { ms: 360, down: true });
      await release();
      await sleep(700);
      // Delete, by mouse.
      pt = await cardCenter();
      await moveTo(pt.x - 10, pt.y + 30, { ms: 350 });
      await sleep(120);
      await press();
      await moveTo(pt.x - 90, pt.y + 36, { ms: 260, down: true });
      await moveTo(pt.x - 240, pt.y + 26, { ms: 360, down: true });
      await release();
      await sleep(800);
      await moveTo(size.width * 0.8, size.height * 0.92, { ms: 400 });
      await hideCursor();
      // Then the keyboard: keep, skip, and an undo that brings the skip back.
      await key("ArrowRight", "Keep");
      await sleep(900);
      await key("ArrowUp", "Skip for now");
      await sleep(900);
      await key("z", "Undo");
      await sleep(900);
      await key("ArrowLeft", "Delete");
      await sleep(1200);
    });
  }

  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
