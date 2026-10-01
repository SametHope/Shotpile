// Headless Chrome for the GUI test and the screenshot tool: finds a browser,
// starts it with remote debugging, and talks to it over a minimal
// dependency-free Chrome DevTools Protocol client.
//
// Needs Chrome, Chromium or Edge; set CHROME=/path/to/chrome if it is not
// found.
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");

// `CHROME` overrides the search; otherwise the first browser that exists wins.
// Playwright's bundled Chromium is on the list so CI and dev containers work
// without a system Chrome.
function findChrome() {
  return [
    process.env.CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/pw-browsers/chromium",
  ].find((p) => p && fs.existsSync(p)) || null;
}

// Minimal CDP client over a raw WebSocket. One listener per event is enough
// for these scripts.
function connect(wsUrl) {
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

/**
 * Starts headless Chrome and connects to its first page. Resolves to
 * `{ client, close }`; `close()` disconnects and kills the browser.
 */
async function launchChrome({ port = 9222, windowSize = "1180,880", profile = "shotpile-chrome-profile" } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chrome/Chromium found; set CHROME=/path/to/chrome");
  const proc = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    // A fixed window, so layout does not depend on the host.
    `--window-size=${windowSize}`,
    // Chrome refuses to start as root without this (containers), and CI
    // runners may block the user namespaces its sandbox needs. The pages are
    // our own local harness, so the sandbox buys nothing here.
    ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), profile)}`, "about:blank",
  ], { stdio: "ignore" });
  const kill = () => { try { proc.kill(); } catch { /* already gone */ } };

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  if (!target) {
    kill();
    throw new Error("chrome did not start");
  }
  const client = await connect(target.webSocketDebuggerUrl);
  return {
    client,
    close() {
      client.close();
      kill();
    },
  };
}

module.exports = { findChrome, connect, launchChrome };
