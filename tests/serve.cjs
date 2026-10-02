// Serves the repository over HTTP and injects the fake backend into the real
// src/index.html, so the unmodified app runs in any browser without Rust.
//
//   node tests/serve.cjs        -> http://127.0.0.1:8731/  (npm run preview)
//
// `/?demo` loads a lived-in demo library instead of the test fixture.
//
// The GUI test starts the same server. There is deliberately no copy of the
// app's markup under tests/: the old harness kept one, and it drifted (Turkish
// labels, a footer bar the real app does not hide) without anyone noticing.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

// The app has exactly one version: src-tauri/Cargo.toml, which the Rust build
// reads through env!("CARGO_PKG_VERSION"). The fake backend has to report that
// same string, so it is read here and handed to the page. It used to hardcode
// "1.0.0", which put a stale number in the About panel of Options and in the
// README pictures without anything failing.
function appVersion() {
  const toml = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
  const pkg = toml.slice(toml.indexOf("[package]"));
  const m = pkg && pkg.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no version in src-tauri/Cargo.toml [package]; update tests/serve.cjs");
  return m[1];
}

// Classic scripts, so they run before the app's module script.
const INJECT = [
  `<script>window.__SHOTPILE_VERSION__ = ${JSON.stringify(appVersion())};</script>`,
  '<script src="/tests/fake-backend.js"></script>',
  '<script src="/tests/probes.js"></script>',
].join("\n  ");

function appPage() {
  const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
  if (!html.includes('<script type="module" src="./app.js">')) {
    throw new Error("src/index.html no longer loads ./app.js; update tests/serve.cjs");
  }
  return html.replace('<script type="module" src="./app.js">', `${INJECT}\n  <script type="module" src="./app.js">`);
}

function start(port = 8731, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const [rawPath, query] = req.url.split("?");
    const url = decodeURIComponent(rawPath);
    if (url === "/" || url === "/index.html") {
      res.writeHead(302, { location: `/src/index.html${query ? `?${query}` : ""}` }).end();
      return;
    }
    if (url === "/src/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(appPage());
      return;
    }
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8731;
  start(port).then(() => {
    console.log("Shotpile preview, on an in-memory fake backend:");
    console.log(`  demo library   http://127.0.0.1:${port}/?demo`);
    console.log(`  test fixture   http://127.0.0.1:${port}/`);
  });
}
