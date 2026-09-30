// GUI smoke test: runs the real src/app.js in headless Chrome against a fake
// Tauri bridge, driving it with real CDP key events (so native Enter/Escape
// semantics on a focused button are exercised, not just a synthetic handler).
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8731;
const CDP_PORT = 9222;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, url === "/" ? "tests/gui-smoke.html" : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

// Minimal dependency-free CDP client over raw WebSocket.
function cdp(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let id = 0;
    const pending = new Map();
    const events = {};

    const api = {
      send(method, params = {}) {
        const payload = Buffer.from(JSON.stringify({ id: ++id, method, params }));
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        sock.write(Buffer.concat([header, mask, masked]));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      on(event, cb) { events[event] = cb; },
      close() { sock.destroy(); },
    };

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        upgraded = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      for (;;) {
        if (buf.length < 2) return;
        let off = 2;
        const len0 = buf[1] & 127;
        let len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const data = buf.subarray(off, off + len).toString();
        buf = buf.subarray(off + len);
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const h = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? h.rej(new Error(JSON.stringify(msg.error))) : h.res(msg.result);
        } else if (msg.method && events[msg.method]) {
          events[msg.method](msg.params);
        }
      }
    });
    sock.on("error", reject);
  });
}

// Windows virtual key codes, so the browser sees the real key.
const VK = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, z: 90, Z: 90, F12: 123, i: 73, l: 76 };
const KEY_TEXT = { Enter: "\r", z: "z", Z: "z" };
// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const CTRL_SHIFT = 2 | 8;

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const userDir = path.join(process.env.TEMP, "opencode", "chrome-smoke-profile");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`, "about:blank",
  ], { stdio: "ignore" });

  const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
  process.on("exit", cleanup);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  if (!target) { cleanup(); throw new Error("chrome did not start"); }

  const client = await cdp(target.webSocketDebuggerUrl);
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
  await client.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/tests/gui-smoke.html` });

  const js = async (body) => {
    const r = await client.send("Runtime.evaluate", {
      // Wrapped as a function body so multi-statement probes work.
      expression: `(function () { const p = window.__probe;\n${body}\n})()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // For one-liner probes: auto-returns the expression.
  const probe = (expr) => js(`return ${expr};`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Real key press through the browser input pipeline.
  const press = async (key, mods = 0) => {
    const common = { modifiers: mods, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], key };
    if (KEY_TEXT[key] !== undefined) common.text = KEY_TEXT[key];
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
    if (KEY_TEXT[key] !== undefined) {
      await client.send("Input.dispatchKeyEvent", { type: "char", ...common });
    }
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  };

  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
  };

  await sleep(1200);

  // ---- boot ----
  const months = await probe("p.monthRows()");
  ok("boots into the months view", months.length === 2, JSON.stringify(months));
  ok("months are ordered newest first", /September/.test(months[0] || ""), JSON.stringify(months));
  ok("month rows carry totals", /3 files/.test(months[0] || "") && /1 files/.test(months[1] || ""), JSON.stringify(months));
  ok("month rows show a thumbnail preview strip", (await probe("p.monthThumbCount()")) > 0, String(await probe("p.monthThumbCount()")));

  // ---- open the September queue ----
  await probe("p.clickFirstMonth()");
  await sleep(250);
  ok("review view shows a card", await probe("p.hasCard()"));
  ok("card renders an image element", await probe("p.hasImg()"));
  const first = await probe("p.cardName()");
  ok("first card is the oldest pending file", /2026-09-02/.test(first || ""), String(first));
  ok("progress shows position in queue", (await probe("p.progress()")) === "1 / 3", await probe("p.progress()"));

  // ---- the deck shows the upcoming cards below the current one ----
  ok("deck shows the current card plus two upcoming", (await probe("p.deckCount()")) === 3, String(await probe("p.deckCount()")));
  ok("the top card is the current one", (await probe("p.deckTopName()")) === first, await probe("p.deckTopName()"));
  const cr = await probe("p.cardRect()");
  ok("the card fills the deck", cr && cr.w > 400 && cr.h > 150, JSON.stringify(cr));

  // ---- queue filmstrip ----
  ok("filmstrip shows the queue", (await probe("p.filmCount()")) > 0, String(await probe("p.filmCount()")));
  ok("filmstrip marks the current item", (await probe("p.filmCurrent()")) >= 0, String(await probe("p.filmCurrent()")));
  const beforeJump = await probe("p.cardName()");
  await js("p.clickFilm(1);");
  await sleep(300);
  ok("clicking a film item jumps to it", (await probe("p.cardName()")) !== beforeJump, `${beforeJump} -> ${await probe("p.cardName()")}`);
  // Jump back so later tests start from the first card again.
  await js("p.clickFilm(0);");
  await sleep(300);
  const nat = await probe("p.imgNatural()");
  ok("the card image loads at full size", nat && nat.w > 100, JSON.stringify(nat));

  // ---- photo viewer ----
  await js("p.openViewer();");
  await sleep(300);
  ok("clicking the image opens the viewer", (await probe("p.viewerOpen()")) === true);
  ok("viewer shows the current file", (await probe("p.viewerName()")) === first, await probe("p.viewerName()"));
  ok("viewer starts at 100%", (await probe("p.viewerZoom()")) === "100%", await probe("p.viewerZoom()"));
  await js("document.querySelector('.viewer-imgwrap').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, cancelable: true, bubbles: true }));");
  await sleep(200);
  ok("scrolling zooms in", (await probe("p.viewerZoom()")) !== "100%", await probe("p.viewerZoom()"));
  await js("p.closeViewer();");
  await sleep(200);
  ok("viewer closes", (await probe("p.viewerOpen()")) === false);

  // ---- clicking the card itself opens the viewer ----
  await js("p.clickCard();");
  await sleep(300);
  ok("clicking the card opens the viewer", (await probe("p.viewerOpen()")) === true);
  await js("p.closeViewer();");
  await sleep(200);
  ok("viewer closes after a card click", (await probe("p.viewerOpen()")) === false);

  // ---- keep, then undo ----
  await press("ArrowRight");
  await sleep(300);
  ok("ArrowRight keeps the card", (await probe(`p.status(${JSON.stringify(first)})`)) === "kept", await probe(`p.status(${JSON.stringify(first)})`));
  const afterKeep = await probe("p.cardName()");
  ok("view advances after a keep", afterKeep !== first, String(afterKeep));

  await press("z");
  await sleep(300);
  ok("Z undoes the keep", (await probe(`p.status(${JSON.stringify(first)})`)) === "pending", await probe(`p.status(${JSON.stringify(first)})`));
  ok("undo shows the undone card again", (await probe("p.cardName()")) === first, await probe("p.cardName()"));
  ok("cursor returns to the undone position", (await probe("p.progress()")) === "1 / 3", await probe("p.progress()"));

  // ---- skip, then undo (the deferred-item case) ----
  await press("ArrowUp");
  await sleep(300);
  ok("ArrowUp marks the card skipped", (await probe(`p.status(${JSON.stringify(first)})`)) === "skipped", await probe(`p.status(${JSON.stringify(first)})`));
  const afterSkip = await probe("p.cardName()");
  ok("view advances after a skip", afterSkip !== first, String(afterSkip));

  await press("z");
  await sleep(300);
  ok("undo of a skip restores the status", (await probe(`p.status(${JSON.stringify(first)})`)) === "pending", await probe(`p.status(${JSON.stringify(first)})`));
  ok("undo of a skip shows the deferred card, not the wrong one", (await probe("p.cardName()")) === first, await probe("p.cardName()"));

  // The skip-undo left the cursor on the deferred item at the back of the
  // queue, so start the staging checks from a freshly opened queue.
  await js("p.backToMonths();");
  await sleep(300);
  await probe("p.clickFirstMonth()");
  await sleep(300);
  const stageA = await probe("p.cardName()");
  ok("reopened queue starts from the first pending file", stageA === first, String(stageA));

  // ---- stage deletions ----
  await press("ArrowLeft");
  await sleep(300);
  ok("ArrowLeft stages the deletion", (await probe(`p.status(${JSON.stringify(stageA)})`)) === "staged", await probe(`p.status(${JSON.stringify(stageA)})`));
  ok("footbar appears once something is staged", (await probe("p.footbarOn()")) === true);
  ok("staged counter reads 1", (await probe("p.stagedCount()")) === "1", await probe("p.stagedCount()"));
  ok("staged button shows the count", /To Delete \(1\)/.test(await probe("p.stagedBtn()")), await probe("p.stagedBtn()"));

  const stageB = await probe("p.cardName()");
  ok("view advances after a stage", stageB !== stageA, String(stageB));
  await press("ArrowLeft");
  await sleep(300);
  ok("a second card can be staged", (await probe(`p.status(${JSON.stringify(stageB)})`)) === "staged", String(stageB));
  ok("staged counter reads 2", (await probe("p.stagedCount()")) === "2", await probe("p.stagedCount()"));

  // ---- a failed write must not advance the queue ----
  const progressBefore = await probe("p.progress()");
  const cardBefore = await probe("p.cardName()");
  await js("p.setFailNextDecide(true);");
  await press("ArrowRight");
  await sleep(400);
  ok("failed write leaves the card on screen", (await probe("p.cardName()")) === cardBefore, `${cardBefore} -> ${await probe("p.cardName()")}`);
  ok("failed write does not advance the counter", (await probe("p.progress()")) === progressBefore, `${progressBefore} -> ${await probe("p.progress()")}`);
  ok("failed write leaves the status untouched", (await probe(`p.status(${JSON.stringify(cardBefore)})`)) === "pending", await probe(`p.status(${JSON.stringify(cardBefore)})`));
  ok("failed write tells the user", /Couldn't save decision/i.test(await probe("p.toastText()")), await probe("p.toastText()"));
  await js("p.setFailNextDecide(false);");

  // ---- Ctrl+Z also undoes ----
  await press("z", 2 /* Ctrl */);
  await sleep(300);
  ok("Ctrl+Z undoes the most recent stage", (await probe(`p.status(${JSON.stringify(stageB)})`)) === "pending", await probe(`p.status(${JSON.stringify(stageB)})`));
  ok("staged counter drops back to 1", (await probe("p.stagedCount()")) === "1", await probe("p.stagedCount()"));

  // re-stage so the commit test has two files
  await press("ArrowLeft");
  await sleep(300);
  ok("re-staging restores the count to 2", (await probe("p.stagedCount()")) === "2", await probe("p.stagedCount()"));

  // ---- drain the queue ----
  for (let i = 0; i < 4; i++) { await press("ArrowRight"); await sleep(200); }
  await sleep(250);
  ok("queue drains back to the months view", (await probe("p.monthRows()")).length === 2, JSON.stringify(await probe("p.monthRows()")));

  // ---- staged drawer ----
  await probe("p.clickStagedBtn()");
  await sleep(300);
  ok("staged drawer lists both files", (await probe("p.stagedRowNames().length")) === 2, String(await probe("p.stagedRowNames().length")));

  // ---- commit dialog: Enter must not confirm ----
  await js("p.reset();");
  await js("p.clickCommit();");
  await sleep(250);
  ok("commit dialog opens", (await probe("p.modalHidden()")) === false);
  ok("focus starts on the safe option", (await probe("p.focusedLabel()")) === "Cancel", await probe("p.focusedLabel()"));

  await press("Enter");
  await sleep(250);
  ok("Enter closes the dialog", (await probe("p.modalHidden()")) === true);
  ok("Enter did not delete anything", (await probe("p.logFilter('commit:').length")) === 0, JSON.stringify(await probe("p.logFilter('commit:')")));
  ok("staged files survive the dismissed dialog", (await probe("p.stagedCount()")) === "2", await probe("p.stagedCount()"));

  // ---- Escape also aborts ----
  await probe("p.clickCommit()");
  await sleep(200);
  await press("Escape");
  await sleep(250);
  ok("Escape closes the dialog", (await probe("p.modalHidden()")) === true);
  ok("Escape did not delete anything", (await probe("p.logFilter('commit:').length")) === 0);
  ok("staged files survive Escape", (await probe("p.stagedCount()")) === "2", await probe("p.stagedCount()"));

  // ---- clicking outside the modal also aborts ----
  await probe("p.clickCommit()");
  await sleep(200);
  await js("document.getElementById('modal').click()");
  await sleep(200);
  ok("backdrop click closes the dialog", (await probe("p.modalHidden()")) === true);
  ok("backdrop click did not delete anything", (await probe("p.logFilter('commit:').length")) === 0);

  // ---- actually commit ----
  await probe("p.clickCommit()");
  await sleep(200);
  ok("confirm button is present", await probe("p.clickConfirmInModal()"));
  await sleep(500);
  ok("commit moved exactly 2 files", (await probe("p.logFilter('commit:')"))[0] === "commit:2", JSON.stringify(await probe("p.logFilter('commit:')")));
  ok("staged counter resets to 0", (await probe("p.stagedCount()")) === "0", await probe("p.stagedCount()"));
  ok("footbar hides when nothing is staged", (await probe("p.footbarOn()")) === false);
  ok("staged button hides when nothing is staged", /\(0\)/.test(await probe("p.stagedBtn()")), await probe("p.stagedBtn()"));

  // ---- a re-scan preserves decisions ----
  await js("p.clickStagedBtn(); document.getElementById('btn-scan').click();");
  await sleep(400);
  ok("rescan keeps the deleted status", (await probe(`p.status(${JSON.stringify(first)})`)) === "deleted", await probe(`p.status(${JSON.stringify(first)})`));

  // ---- DevTools shortcut ----
  await press("F12");
  await sleep(300);
  ok("F12 asks the backend to open DevTools", (await probe("p.devtoolsCalled()")) === true, JSON.stringify(await probe("p.logFilter('devtools')")));

  // ---- file-log viewer ----
  await press("l", CTRL_SHIFT);
  await sleep(300);
  ok("Ctrl+Shift+L opens the log viewer", (await probe("p.modalHidden()")) === false);
  ok("log viewer shows the log text", /fake log line/.test((await probe("p.logModalText()")) || ""), await probe("p.logModalText()"));
  await js("document.querySelector('#modal-foot button').click()");
  await sleep(200);
  ok("log viewer closes", (await probe("p.modalHidden()")) === true);

  // ---- a counter-refresh failure must not roll back a saved decision ----
  await probe("p.backToMonths()");
  await sleep(300);
  await js("p.resetShots();");
  await sleep(200);
  await probe("p.clickFirstMonth()");
  await sleep(300);
  const rbCard = await probe("p.cardName()");
  await js("p.setFailNextSummary(true);");
  await press("ArrowLeft");
  await sleep(400);
  ok("stage persists even when the counter refresh fails", (await probe(`p.status(${JSON.stringify(rbCard)})`)) === "staged", await probe(`p.status(${JSON.stringify(rbCard)})`));
  ok("card advances even when the counter refresh fails", (await probe("p.cardName()")) !== rbCard, `${rbCard} -> ${await probe("p.cardName()")}`);

  // ---- an undo from another queue must not inject an out-of-scope card ----
  await js("p.setUndoOutOfScope(true);");
  await press("z");
  await sleep(400);
  ok("out-of-scope undo returns to the months view", (await probe("p.monthRows()")).length === 2, JSON.stringify(await probe("p.monthRows()")));
  ok("out-of-scope undo does not show a card", (await probe("p.hasCard()")) === false);

  // ---- picking a folder scans it and lands on the months view ----
  await js("p.resetToSetup();");
  await sleep(300);
  ok("setup view appears when there are no roots", /Choose Folder/.test(await probe("p.viewText()")), await probe("p.viewText()"));
  await js("p.reset();");
  await js("p.addFolder();");
  await sleep(600);
  ok("picking a folder scans it and shows the months", (await probe("p.monthRows().length")) > 0, JSON.stringify(await probe("p.monthRows()")));
  ok("the scan is logged", (await probe("p.logFilter('scan:')")).length > 0, JSON.stringify(await probe("p.logFilter('scan:')")));

  const pageFails = await js("return window.__FAILS;").catch(() => []);

  client.close();
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
