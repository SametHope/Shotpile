# AGENTS.md — Screenshot Sifter

## What this is

A Tauri 2 desktop app (Rust backend, no-bundler static frontend) for triaging
screenshot folders: month and random review queues, swipe decisions, and staged
deletion into the Windows Recycle Bin.

## Hard rules

- **Never delete on a swipe.** A left-swipe sets status `staged`. Files only move
  when the user confirms, and they go through the Recycle Bin via the `trash`
  crate. Do not add `fs::remove_file`, `remove_dir_all`, or `tauri-plugin-fs`
  remove anywhere.
- **No plugins for filesystem access.** Everything goes through the app's own
  commands in `src-tauri/src/commands.rs`. `capabilities/default.json` stays at
  `core:default`. If a new need appears, add a command, not a permission.
- **The frontend stays bundler-free.** `src/` is plain ES modules loaded by
  `index.html`. No Vite, no npm runtime dependencies, no build step for the
  frontend. `package.json` exists only for the Tauri CLI and the logic tests.
- **Decisions are never reset by a rescan.** The upsert in `db.rs` deliberately
  omits `status` and `decided_ms`. Keep it that way.
- **Date inference is filename-first**, then creation, then modified. Modified
  time alone is wrong for copied folders, so it is the last resort.
- **The safe option is the default in a dialog.** `confirmDialog` never binds
  Enter to the destructive action: `modal()` focuses the first button, which is
  *Vazgeç*, and the native Enter activation closes the dialog without
  committing. Every exit path, including Escape, must call `closeModal()`, or
  the modal stays on screen and blocks the app.

## Layout

```
src/logic.js     pure, DOM-free, unit tested in tests/logic.test.mjs
src/app.js       all DOM, gestures, keyboard, Tauri calls
tests/gui-smoke.html   real app.js + a fake command surface, loaded by Chrome
tests/gui-smoke.cjs    CDP driver: asserts on the rendered DOM and real keys
src-tauri/src/db.rs       schema + queries + month grouping
src-tauri/src/scan.rs     walkdir + filename date parsing
src-tauri/src/commands.rs the entire command surface
```

`logic.js` must stay importable by `node --test`, so it cannot touch `window`,
`document`, or anything from `__TAURI__`.

## Verify before claiming done

```powershell
npm run test:logic                          # 28 frontend logic tests
npm run test:gui                            # 114 GUI assertions in headless Chrome
cd src-tauri; cargo test                    # 39 unit + 2 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

`npm run test:gui` runs the real `src/app.js` in `tests/gui-smoke.html`, which
fakes the Rust command surface in memory, then drives it with real Chrome key
events via CDP. It is where the rendered card, the shortcuts and the confirm
dialog get covered. If you change a view, a shortcut, or the dialog, add a
probe there. Chrome must be installed; the script has no npm dependencies.

## Diagnosing

- **Frontend** logs to the console through `src/log.js` (levels debug/info/warn/
  error, plus a 500-entry ring buffer). DevTools opens with `F12` or
  `Ctrl+Shift+I`; `__sifterLog.dump()` prints the ring. `?log=debug` on the URL
  lowers the level floor.
- **Backend** appends to `%APPDATA%\com.hope.screenshotsifter\logs\sifter.log`
  via `src-tauri/src/log.rs` (rotated at 2 MiB). `Ctrl+Shift+L` shows the tail
  in a modal; the `log_read` command backs it.
- Both are compiled into release builds. When something breaks, ask for the
  console output or the file log before guessing.

## CSS gotcha

- Author `display` rules outrank the UA `[hidden] { display: none }`, so
  `style.css` starts with `[hidden] { display: none !important; }`. Do not
  remove it: without it the modal and header buttons stay on screen and block
  the app even when they are marked `hidden`.

## Review view

- The review shows a **deck**, not a single card: `cardStack()` paints the next
  couple of shots behind the current one (`.deck-1`, `.deck-2`) so a swipe has
  somewhere to land. The upcoming shots are hydrated in `showCurrent()` before
  the first render, otherwise the deck would show only one card until the
  background preload landed.
- The deck is absolutely positioned, so it needs a definite height from
  somewhere. `#view` is `height: 100%` (so the chain `#view → .review → .wrap
  → .stage → .deck` resolves) and `.deck .card` is `height: 100%`. Without both,
  the card collapses to its 2px border and the review shows an empty area. The
  old grid layout supplied this height for free; absolute positioning does not.
- `.review .wrap` sets `margin: 0` to override the `.wrap` class's
  `margin: 0 auto`. On a flex item, auto margins absorb the free space and stop
  the wrap from stretching, which would leave the card narrow.
- **Never size the card's image with a percentage.** It used to be
  `max-width/max-height: 100%` as an in-flow grid item of `.imgwrap`, and that
  constrained nothing: `.imgwrap`'s height comes from flex distribution, so the
  percentage had no definite height to resolve against and a 2000x1500 shot
  rendered at its full 696x522 inside a 100px frame. `.card .imgwrap img` is now
  `position: absolute; inset: 0` and lets `object-fit: contain` do the fitting,
  which cannot overflow whatever the container does.
- **The card info bar is an overlay, not a layout row.** `.card .foot` is
  `position: absolute` at the card's bottom with a translucent background and
  `pointer-events: none`, so the photo gets the card's full height and the bar
  never blocks a swipe or a zoom. Do not give it `flex: 0 0 auto` or an opaque
  background: that is what made it eat the photo's height.
- Because the image box now fills the frame and the photo is *letterboxed*
  inside it, the box size is not the photo size. Two places must measure the
  content instead: `clampPan()` (bounds panning) and the zoom-anchor test.
  `object-fit: contain` scales it as
  `k = min(frameW / naturalW, frameH / naturalH)`.
- `clampPan()` takes the larger of two bounds: half the content's growth, which
  is the most translate a cursor-anchored zoom point can ever need, and half the
  leftover frame, so a photo smaller than its frame can still be slid around.
  A bounds-only-clamp of "scaled content minus frame" reads as zero for a
  letterboxed photo and silently zeroes the zoom anchor.
- Scrollbars are hidden globally (`html { scrollbar-width: none }`). During a
  swipe the card leaves the stage, so `#view.reviewing` sets `overflow: visible`
  to avoid clipping it or throwing scrollbars. Toggle the class in `render()`.
- The footbar is always in the layout and expands/collapses via a `max-height`
  transition (`.footbar.on`), so showing it never shifts the content above.
- The swipe exit animation holds the decision until the card has animated off
  (`state.animating`), so a swipe never flashes the "queue done" finale. A
  keyboard/button decision fades the card out instead.
- The queue filmstrip (`.filmstrip`) shows the previous few decisions and the
  next few photos; `jumpTo(index)` moves the cursor so a pass can be walked.
- The deck cards are absolutely positioned and centred via
  `translate(-50%, -50%)`. The swipe gesture sets `cardEl.style.transform`
  inline, so every one of those transforms must repeat the
  `translate(-50%, -50%)` prefix or the card jumps to the corner.
- Clicking the image opens the **photo viewer** (`.viewer`), a full-screen
  overlay with scroll-zoom, drag-pan and double-click toggle. While it is open
  it owns the keyboard: `Esc` closes, arrows pan, `+`/`-` zoom. The viewer is
  created dynamically in `openViewer()`, so it needs no markup in `index.html`.

## Environment notes

- The machine has Visual Studio 2022+ with the MSVC toolset, which is what
  `rusqlite`'s `bundled` SQLite needs to compile. `cl.exe` is not on `PATH`, but
  the `cc` crate finds it automatically — do not add manual env setup unless a
  build actually fails.
- `cargo-tauri` is not installed globally. Use the local CLI: `npm run tauri ...`
  or `npx tauri ...`.
- `vswhere` lives at `C:\Tools\vswhere.exe`, not the default Program Files path.
- Tauri generates `src-tauri/gen/schemas/`, which is gitignored; the capability
  file references it via `$schema` for editor completion only.
- Reusable icon source: `tools/make-icon.ps1` then `npx tauri icon`. The source
  PNG is gitignored; the generated `src-tauri/icons/` files are not.

## Style

- UI text is English only. Do not reintroduce Turkish strings.
- Visual tokens live at the top of `src/style.css` and deliberately mirror the
  existing single-page QoL apps (`--accent:#1d4ed8`, `--line`, `--radius:12px`,
  the same soft gradient wash). Keep new colours in that palette.
- Keep diffs minimal. No drive-by refactors.
