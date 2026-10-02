# AGENTS.md — Shotpile

## What this is

A Tauri 2 desktop app (Rust backend, no-bundler static frontend) for triaging
screenshot folders: month and random review queues, swipe decisions, and staged
deletion into the Recycle Bin (Trash on macOS and Linux). Windows is the main
platform; releases also ship macOS and Linux builds.

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
- **Decisions are never reset by a rescan.** The upsert in `db.rs` leaves
  `status` and `decided_ms` alone, with one exception: a `deleted` row whose
  file is on disk again was restored from the bin by hand, so it becomes
  `kept`. Keep it that way.
- **The deletion pile is per folder.** `staged_list`, `commit_deletes` and the
  summary's `pile` take the current `root_id`, like the library; a commit never
  moves another folder's files.
- **Redo mirrors undo.** An undone entry moves to the redo side and only
  reapplies while its row still shows `prev`; a new decision clears redo, and
  commits and forgets purge both sides.
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
- **The license is PolyForm Noncommercial 1.0.0** (`LICENSE`, with the
  required notice on top). Do not add a dependency whose licence is not in
  `src-tauri/about.toml`; the release fails on one, by design.
- **Never drop the legacy data move.** `adopt_legacy_db()` in `lib.rs` moves a
  1.0.0 database (`com.hope.screenshotsifter\sifter.db`) over by renaming it.
  The identifier `com.samethope.shotpile` decides the data folder; changing it
  again needs the same kind of move.
- **UI text is English only**, and so is every backend log line and error
  string (errors surface in toasts). Name the bin and the file manager with
  `binName()` and `fileManager()` in app.js (from `app_info`), never a
  hard-coded "Recycle Bin" or "File Explorer".

## Layout

```
src/boot.js      classic <head> script: theme + zoom prefs before first paint
src/logic.js     pure, DOM-free, unit tested in tests/logic.test.mjs
src/log.js       leveled logger, DOM-free; forwards warn/error through a sink
src/icons.js     icon SVG strings, DOM-free
src/dom.js       h(), icon(), toast, modal, confirmDialog, popover menu
src/viewer.js    full-screen photo viewer
src/app.js       state, views, review deck, gestures, keyboard, Tauri calls
tests/commands.test.mjs  asserts every api()/invoke() name is in lib.rs's handler
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
npm run test:logic                          # 56 frontend logic tests
npm run test:gui                            # 283 GUI assertions in headless Chrome
cd src-tauri; cargo test                    # 79 unit + 4 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

CI runs all of them (`.github/workflows/ci.yml`), Rust on Linux and Windows.

`HANDOFF.md` lists the open items, including known problems in the latest
release that the tests did not catch. Read it first in a fresh session. A green
run against the fake backend does not prove a Tauri command is registered or
that an OS-level feature (clipboard, file manager, window) works.

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
  on Windows, a universal `.dmg` on macOS and an AppImage and `.deb` on
  Ubuntu 22.04 (one job each), and publishes them as one GitHub release, when a `v*` tag is pushed
  or when it is run by hand with a new tag (it then tags the branch head it
  built). It refuses a tag that does not match the version in
  `src-tauri/Cargo.toml` (the single source: `tauri.conf.json` and
  `package.json` deliberately have none), or one that already points at
  another commit. A branch push that
  changes the workflow is a dry run (builds, uploads an artifact, publishes
  nothing).

## Diagnosing

- **Frontend** logs to the console through `src/log.js` (levels debug/info/warn/
  error, plus a 500-entry ring buffer). DevTools opens with `F12` or
  `Ctrl+Shift+I`; `__shotpileLog.dump()` prints the ring. `?log=debug` on the URL
  lowers the level floor. Warnings and errors (including uncaught errors and
  unhandled rejections) are also sent to the file log with `log_write`,
  rate-limited, under a `ui:` scope.
- **Backend** appends dated lines to
  `logs/shotpile.log` in the app data folder (`%APPDATA%\com.samethope.shotpile`
  on Windows) via
  `src-tauri/src/log.rs` (rotated at 2 MiB). A panic hook writes panics there
  before the process aborts. `Ctrl+Shift+L` shows the tail in a modal; the
  `log_read` command backs it.
- Both are compiled into release builds. When something breaks, ask for the
  console output or the file log before guessing.

## Start-up, theme and zoom

- The window starts hidden (`visible: false`); `revealApp()` in app.js calls
  `app_ready` after the first view paints, and lib.rs shows it after 4 s
  regardless. The `#splash` in index.html covers the gap.
- Dark mode is `:root[data-theme="dark"]`, never a `prefers-color-scheme`
  query: boot.js resolves "System" itself, so an Options choice can beat it.
  Give every new dark override that selector.
- Zoom is the WebView's own (`set_zoom`), saved by boot.js. Tauri's built-in
  zoom hotkeys are off so the app's steps and saved value stay the only path.
- Narrow and short windows (Windows scaling at 125%/150%) are handled by the
  `small windows` media queries at the end of style.css.

## CSS gotchas

- Author `display` rules outrank the UA `[hidden] { display: none }`, so
  `style.css` starts with `[hidden] { display: none !important; }`. Do not
  remove it: without it the modal and header buttons stay on screen and block
  the app even when they are marked `hidden`.
- Colours are tokens at the top of `style.css`, redefined under
  `:root[data-theme="dark"]`. Components use the tokens; a hard-coded surface
  or text colour will break the dark theme. The photo card's info bar and the
  viewer are the deliberate exceptions (they sit on photos).
- Page scrollbars are hidden (`html { scrollbar-width: none }`) because they
  flickered during swipes. The library and the pile scroll inside `#view`, which
  has a thin themed bar; `#view.reviewing` sets `overflow: visible` so a thrown
  card is never clipped. Toggle the class in `render()`.
- The progress bar carries the stripes on the **track**, not on a segment: the
  uncovered track is the unsorted remainder and the segments are the decided
  statuses (kept, staged, deleted, skipped), all solid. 1.4.0 striped the
  deleted segment, which read as if it were the unsorted part; do not restripe a
  segment. Change `--track-line` with the theme, like the other tokens.
- **`--track-line` must stay an opaque colour mixed out of `--seg-track`,** and
  the gradient stops are what make the stripe. A gradient is composited over
  what is *behind* the element, not stop over stop, so a translucent stop
  (`rgba(255,255,255,.16)`) is a wash of the page behind the bar, not a line
  across the track: 1.4.0 and 1.5.0 both shipped that, and at 6px it read as flat
  grey no matter how far the alpha was raised. Use
  `color-mix(in srgb, var(--seg-track) 78%, #fff)`. The `segbarStripes()` probe
  resolves both tokens through a throwaway element (color-mix() is substituted at
  computed-value time) and the suite asserts `alpha === 1`: a probe that
  composites the two stops itself reports a healthy step for a stripe that never
  paints, which is exactly how this one got through.
- The native window background is set from JS (`set_window_background`), not just
  `tauri.conf.json`, because WebView2's default is white and flashes through on
  the first scroll when fullscreen. `syncWindowBackground()` in app.js follows
  `data-theme` through a MutationObserver; keep it in step with `--bg`.
- **No `backdrop-filter` on the shell bars.** `.topbar` and `.footbar` used to
  carry one for a frosted look they did not need (they are flex siblings, so
  nothing scrolls behind them). The filter still forces a WebView2 render
  surface, and that surface is presented uninitialised — a black band — when the
  window is resized and the library is scrolled afterwards. The same applies to
  `#view`: keep its `background: var(--bg)`, never leave the scrolling layer
  transparent. The blur on `.backdrop` (a dialog) and `.card .foot` is fine,
  because those genuinely sit over content.
- F11 is a real action (`ACTIONS.FULLSCREEN`, default binding `F11`) handled in
  the global keydown, and `toggle_fullscreen` flips the window and returns the
  new state so the frontend cannot drift. WebView2 has no F11 of its own.

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
  cursor so a pass can be walked. The window is **derived from the strip's width
  and item size** (`filmItemsPerSide()` in logic.js, called by `filmPerSide()`),
  not a fixed count: the strip does not scroll, so a fixed window clipped the
  current item off-screen once the strip grew taller. Re-paint on the filmstrip
  drag and on window resize (`scheduleFilmstripPaint()`). The two edges carry a
  mask fade; keep it in step with `.filmstrip` in style.css.
- **The waiting cards peek below the stage.** `.deck-1`/`.deck-2` are translated
  down by up to `--deck-dy` (44px) and scaled, so the bottom card reaches past
  the stage's padding box. `.stage` reserves that room with `margin-bottom: 48px`;
  reducing it lets the stack ride up over the action row (at the old 12px the
  lowest card crossed it by 6px, and the GUI suite now fails on that).
  `reviewLayout()` in the probes measures the lowest deck card, not just the top
  one, because measuring the top card hid this. The `max-height: 600px` query
  pairs a smaller `margin-bottom` with a smaller `--deck-dy`, so its 20px is
  enough: **change the two together**, and the suite covers that size too.
- Clicking the card opens the viewer after the double-click interval (a
  double-click zooms instead); `Space` opens it too. The viewer owns the
  keyboard while open (`viewerKeydown`), and is created on demand, so it needs
  no markup in `index.html`.
- **The sorting-button row collapses, but the freed height goes to the
  filmstrip, never to the stage.** `.review.no-actions` sets
  `--filmstrip-grow: 62px`, which `.filmstrip` and `.film-item` add to their
  `--filmstrip-height`. Do not give the space to `.stage` by making the strip a
  flexible item instead: `.deck .card` is `height: 100%`, so the deck loses its
  definite height and the card collapses to its border. `.actions` leaves the
  layout the same way `.footbar` does — `max-height: 0` plus
  `visibility: hidden` — so the hidden buttons take no space and cannot take
  focus, and the visibility change is delayed by the transition so the row is
  still visible while it folds away. The toggle (`stageToggle()`) is a child of
  `.stage`, not of the row, or it would hide itself; the choice is persisted as
  the `hideActions` pref and `setActionsHidden()` re-runs
  `scheduleFilmstripPaint()` so the fitted window is recomputed.
- The review is capped at `1600px`, wider than the library's measure, because
  `filmItemsPerSide()` is derived from the strip's width: every extra pixel is
  another item in the queue. The default window is 1360 wide for the same
  reason. The filename filter was removed entirely (UI, `matchesFilename()`,
  `state.filter`); the sorted-month *Filter* modal is unrelated and stays.
- Small `.segbar`s (the 6px month bars) need a finer stripe than `.segbar.lg`:
  the 8px period flattens into grey at that size, so `.segbar:not(.lg)` uses a
  4px period. Keep the meaning identical to the big bar.

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
  regenerates every size in `src-tauri/icons/`. The glyph is the `pile` mark
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
