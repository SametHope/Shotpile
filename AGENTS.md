# AGENTS.md — Screenshot Sifter

## What this is

A Tauri 2 desktop app (Rust backend, no-bundler static frontend) for triaging
screenshot folders: month and random review queues, swipe decisions, and staged
deletion into the Windows Recycle Bin.

## Hard rules

- **Never delete on a swipe.** A left-swipe sets status `staged`. Files only move
  when the user confirms, and they go through the Recycle Bin via the `trash`
  crate. Do not add `fs::remove_file`, `remove_dir_all`, or `tauri-plugin-fs`
  remove anywhere in the app. (Tests may clean up the temp folders they create
  themselves.)
- **No plugins for filesystem access.** Everything goes through the app's own
  commands in `src-tauri/src/commands.rs`. `capabilities/default.json` stays at
  `core:default`. If a new need appears, add a command, not a permission.
- **The frontend stays bundler-free.** `src/` is plain ES modules loaded by
  `index.html`. No Vite, no npm runtime dependencies, no build step for the
  frontend. `package.json` exists only for the Tauri CLI and the tests.
- **Decisions are never reset by a rescan.** The upsert in `db.rs` deliberately
  omits `status` and `decided_ms`. Keep it that way.
- **Undo never resurrects a committed file.** `undo.rs` entries record the
  status they set (`next`) and only apply while the row still shows it; a
  `deleted` row is never changed by undo, `decide` or `unstage`, and the commit
  purges its entries. Do not "simplify" undo back to restoring `prev` blindly.
- **Forgetting a folder is database-only.** `forget_root` deletes rows (the
  cascade takes screenshots and staged entries) and purges undo entries. It must
  never touch the disk.
- **Date inference is filename-first**, then creation, then modified. Modified
  time alone is wrong for copied folders, so it is the last resort.
- **The safe option is the default in a dialog.** `confirmDialog` never binds
  Enter to the destructive action: `modal()` focuses the first footer button,
  which is *Cancel*, and the native Enter activation closes the dialog without
  committing. Every exit path (a button, Escape, a backdrop click) goes through
  the modal's cancel or button handlers and closes it, or the modal stays on
  screen and blocks the app.
- **UI text is English only**, and so is every backend log line and error
  string (errors surface in toasts).

## Layout

```
src/logic.js     pure, DOM-free, unit tested in tests/logic.test.mjs
src/log.js       leveled logger, DOM-free; forwards warn/error through a sink
src/icons.js     icon SVG strings, DOM-free
src/dom.js       h(), icon(), toast, modal, confirmDialog, popover menu
src/viewer.js    full-screen photo viewer
src/app.js       state, views, review deck, gestures, keyboard, Tauri calls
tests/serve.cjs        serves the repo; injects the fake backend into src/index.html
tests/fake-backend.js  in-memory mirror of the Rust commands (also `npm run preview`)
tests/probes.js        page-side helpers the GUI test calls
tests/gui-smoke.cjs    CDP driver: asserts on the rendered DOM and real keys
tests/browser.cjs      finds and starts headless Chrome; minimal CDP client
tools/screenshots.cjs  regenerates docs/screenshots/ (README pictures)
src-tauri/src/db.rs       schema + queries + month grouping
src-tauri/src/scan.rs     walkdir + filename date parsing
src-tauri/src/undo.rs     session undo stack (stale entries are skipped)
src-tauri/src/log.rs      file logger, one_line(), panic hook
src-tauri/src/commands.rs the entire command surface; logic in apply_* fns
tools/app-icon.svg        icon source for `npx tauri icon tools/app-icon.svg`
```

`logic.js`, `log.js` and `icons.js` must stay importable by `node --test`, so
they cannot touch `window`, `document`, or anything from `__TAURI__`.

Commands keep their logic in plain `apply_*` functions that take `&Db` (and the
`UndoStack`), so `tests/e2e.rs` and the unit tests run the real code. Lock order
is always `db`, then `undo`.

## Verify before claiming done

```powershell
npm run test:logic                          # 44 frontend logic tests
npm run test:gui                            # 209 GUI assertions in headless Chrome
cd src-tauri; cargo test                    # 65 unit + 4 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

CI runs all of them (`.github/workflows/ci.yml`), Rust on Linux and Windows.

`HANDOFF.md` records the current state and the open items. Read it first in a
fresh session.

`npm run test:gui` serves the real `src/index.html` with `tests/fake-backend.js`
and `tests/probes.js` injected, then drives `src/app.js` with real Chrome key
events via CDP. There is deliberately no copy of the app's markup under
`tests/`: the old harness kept one and it drifted. The fake must mirror the Rust
semantics (statuses, queue orders, the undo stack's stale-entry rule, missing
files kept out of queues); when a command changes, change the fake with it. If
you change a view, a shortcut, or the dialog, add a probe and an assertion.
Chrome or Chromium must be installed (`CHROME=` overrides the search); the
script has no npm dependencies. `npm run preview` serves the same page for
manual UI work; `/?demo` there swaps the test fixture for a seeded, lived-in
library (`seedDemo()` in the fake), which is also what the README pictures show.

## README pictures and releases

- `npm run screenshots` drives the `?demo` library with real mouse and key
  input and rewrites `docs/screenshots/` (WebP stills, plus the animated demo,
  which needs ffmpeg). When a change is visible in a view the README shows,
  rerun it and commit the pictures with the change. The demo data is seeded, so
  a rerun only differs where the UI did. Keep the alt texts in `README.md` true
  to the pictures.
- `.github/workflows/release.yml` builds the NSIS installer and a portable exe
  on `windows-latest` and publishes a GitHub release, when a `v*` tag is pushed
  or when it is run by hand with a new tag (it then tags the branch head it
  built). It refuses a tag that does not match `src-tauri/tauri.conf.json`, or
  one that already points at another commit, so bump the version there, in
  `src-tauri/Cargo.toml` and in `package.json` together.

## Diagnosing

- **Frontend** logs to the console through `src/log.js` (levels debug/info/warn/
  error, plus a 500-entry ring buffer). DevTools opens with `F12` or
  `Ctrl+Shift+I`; `__sifterLog.dump()` prints the ring. `?log=debug` on the URL
  lowers the level floor. Warnings and errors (including uncaught errors and
  unhandled rejections) are also sent to the file log with `log_write`,
  rate-limited, under a `ui:` scope.
- **Backend** appends dated lines to
  `%APPDATA%\com.hope.screenshotsifter\logs\sifter.log` via
  `src-tauri/src/log.rs` (rotated at 2 MiB). A panic hook writes panics there
  before the process aborts. `Ctrl+Shift+L` shows the tail in a modal; the
  `log_read` command backs it.
- Both are compiled into release builds. When something breaks, ask for the
  console output or the file log before guessing.

## CSS gotchas

- Author `display` rules outrank the UA `[hidden] { display: none }`, so
  `style.css` starts with `[hidden] { display: none !important; }`. Do not
  remove it: without it the modal and header buttons stay on screen and block
  the app even when they are marked `hidden`.
- Colours are tokens at the top of `style.css`, redefined under
  `prefers-color-scheme: dark`. Components use the tokens; a hard-coded surface
  or text colour will break the dark theme. The photo card's info bar and the
  viewer are the deliberate exceptions (they sit on photos).
- Page scrollbars are hidden (`html { scrollbar-width: none }`) because they
  flickered during swipes. The library and the pile scroll inside `#view`, which
  has a thin themed bar; `#view.reviewing` sets `overflow: visible` so a thrown
  card is never clipped. Toggle the class in `render()`.

## Review view

- The review shows a **deck**: `buildDeck()` paints the current card
  (`.deck-top`, `#card`) and the next two (`.deck-1`, `.deck-2`). Each slot's
  offset comes from `--deck-dy` / `--deck-scale` through `transform`.
- **Cards are centred with `inset: 0; margin: auto`, not with a translate.** So
  `transform` carries only the slot offset, and the gesture moves the card with
  the individual `translate`, `rotate` and `scale` properties, which compose
  with it. Never put a gesture offset into `transform` (you would have to
  restate the slot position, which is the trap the old `translate(-50%, -50%)`
  layout had) and never centre the cards with a transform again.
- The deck needs a definite height from somewhere: `#view` is `height: 100%`,
  `.review` is a flex column, `.stage` flexes, and `.deck .card` is
  `height: 100%`. Without the chain the card collapses to its border.
- **Gestures are delegated.** `wireStage()` binds the stage once per render;
  every handler resolves the current top card when the event arrives
  (`topCard()`), and a drag keeps the card it started on. Never capture the top
  card in a closure at render time: that was a real bug, after the first
  promotion every drag moved a detached node, so the visible card sat still and
  the decision landed blind. The GUI test swipes twice in a row to guard it.
- **Advancing must not re-render the deck.** `promoteDeck()` relabels the slots:
  `.deck-1` becomes the top card and `.deck-2` moves up, both gliding there on
  the slot transition (a drag has usually carried them most of the way already),
  and `fillDeckTail()` fades a new card in at the back. Only the chrome
  (`renderReviewChrome()`) updates. It checks `data-id` against the queue and
  falls back to `showCurrent()` when the deck does not hold the expected card.
  Do not "simplify" it into a `showCurrent()` call: a full render destroys the
  gliding card mid-animation, which is the flicker-then-snap this replaced.
- **Every decision exits the same way.** `decide()` throws the top card with
  `flyOut()` (a swipe continues from where the drag left it; a key or button
  starts from rest), and the card stops being the top card at once, so input
  goes straight to the next one. The thrown card removes itself on
  `transitionend`; keep `EXIT_MS` in `app.js` in step with `.card.leaving`.
  The deck is promoted only after the write lands, so a failed write can
  restore the queue and the tally and re-render.
- `.deck.inert` disables pointer events for a frame after a promotion. The
  selector has to be exactly `.deck.inert`; `deckPointerEvents()` in the GUI
  probes asserts the *computed* value, because a typo silently drops the rule.
- Entry animations (`enter-fade`, `enter-from-left|right|top` for undo, which
  brings a card back from the side it left) also animate the individual
  properties. Animations override inline styles, so `onPointerDown` removes the
  entry class before a drag starts.
- **The card info bar is an overlay, not a layout row.** `.card .foot` is
  `position: absolute` at the card's bottom with a gradient scrim and
  `pointer-events: none`, so the photo gets the card's full height. Its resting
  background must stay a gradient, because `paintIntent()` overrides it with
  the drag colour in the same `linear-gradient(to top, ...)` shape. It is hidden
  on the waiting cards, whose peeking slivers would otherwise show it.
- The card's `.tint` layer sits *under* the photo (`z-index: 1` vs the image's
  `2`), so it only shows in the letterbox margins; tinting the info bar is what
  makes the swipe colour read.
- The drag shrink is driven by raw pointer distance (`SHRINK_REACH`), not by
  `gestureVisual().progress`, which saturates at `GESTURE_THRESHOLD`.
  `SHRINK_MAX` is the floor. The tilt (`dragTilt()`) follows the horizontal
  offset only and flips when the card is grabbed below its middle.
- **Never size the card's image with a percentage.** `.card .imgwrap img` is
  `position: absolute; inset: 0` and lets `object-fit: contain` fit it. The
  photo is letterboxed, so the box is not the photo: pan bounds use
  `containedSize()` and `panLimit()` from `logic.js` (the card and the viewer
  share them). `panLimit()` takes the larger of half the content's growth and
  half the leftover frame; a "scaled content minus frame" clamp reads as zero
  for a letterboxed photo and kills the zoom anchor.
- The zoom controller lives on the card node (`zoomOf(card)`), so it follows the
  card through a promotion. Past `ZOOM_PAN_THRESHOLD` a drag pans and the arrow
  keys pan instead of deciding.
- **The queue defers a skipped card once per pass** (`ReviewQueue.deferCurrent`).
  Skipping it again, or skipping the last card, moves on; otherwise a pass of
  skips never ended and Skip looked broken on the last card. Undoing a skip
  moves the card back to the cursor (`focusId`), restoring the pre-skip order;
  seeking to the back used to end the pass and drop everything in between.
- Decision keys ignore auto-repeat (`e.repeat`): one press, one decision.
- The last decision of a pass waits `EXIT_MS` before `finishPass()` renders the
  summary, so the thrown card is never cut off by the summary.
- The footer bar (staged count + commit) is hidden during a review; the header
  badge carries the count there. It always stays in the layout and
  expands/collapses via `max-height`, so showing it never shifts the content.
- The filmstrip (`paintFilmstrip()`) shows a window of the queue around the
  cursor and hydrates any item it does not have yet; `jumpTo(index)` moves the
  cursor so a pass can be walked.
- Clicking the card opens the viewer after the double-click interval (a
  double-click zooms instead); `Space` opens it too. The viewer owns the
  keyboard while open (`viewerKeydown`), and is created on demand, so it needs
  no markup in `index.html`.

## Environment notes

- The machine has Visual Studio 2022+ with the MSVC toolset, which is what
  `rusqlite`'s `bundled` SQLite needs to compile. `cl.exe` is not on `PATH`, but
  the `cc` crate finds it automatically — do not add manual env setup unless a
  build actually fails.
- `cargo-tauri` is not installed globally. Use the local CLI: `npm run tauri ...`
  or `npx tauri ...`.
- `vswhere` lives at `C:\Tools\vswhere.exe`, not the default Program Files path.
- On Linux (CI, cloud sessions) the Tauri crates need `libwebkit2gtk-4.1-dev`,
  `libgtk-3-dev`, `librsvg2-dev` and `libayatana-appindicator3-dev`; the e2e
  tests then use the freedesktop trash.
- Tauri generates `src-tauri/gen/schemas/`, which is gitignored; the capability
  file references it via `$schema` for editor completion only.
- Icons: edit `tools/app-icon.svg`, then `npx tauri icon tools/app-icon.svg`
  regenerates every size in `src-tauri/icons/`. The glyph is the `sieve` mark
  from `src/icons.js`; keep the two in step.

## Style

- Visual tokens live at the top of `src/style.css` and deliberately mirror the
  existing single-page QoL apps (`--accent:#1d4ed8`, `--line`, `--radius:12px`,
  the soft gradient wash). Keep new colours in that palette, and give every new
  colour a dark-theme value.
- Avoid generic dashboard furniture (rows of identical stat tiles, an icon in
  a tinted circle on every element): say the number in a sentence, or show it
  where it is used, as the library's overview line and stacked bar do.
- Keep diffs minimal. No drive-by refactors.
