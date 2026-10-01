# Screenshot Sifter

Local-first desktop app for reviewing a folder of screenshots: month-by-month or
at random, keep / skip / stage-for-deletion with a swipe, then send the staged
files to the Windows Recycle Bin in one explicit step.

Nothing is uploaded. The database, the queue logic and every filesystem touch
live on the local machine.

## What it does

- **Scan** a folder tree for image files and remember each one by absolute path.
- **Group** screenshots into months using the best available date: a date in the
  filename, else the file's creation time, else its modified time.
- **Review** a month, all unreviewed files, the skipped pile, or a random shuffle.
  Swipe left to stage for deletion, right to keep, up to skip. Arrow keys and
  on-screen buttons do the same thing; `Z` / `Ctrl+Z` / `Backspace` undoes.
  The current card sits on top of a small deck, so the next couple of photos peek
  out below it and a swipe always has somewhere to land. The card itself tints as
  you drag — red to delete, green to keep, yellow to skip — while the photo stays
  untinted, and it shrinks slightly as it recedes before animating off-screen.
- **See the whole photo.** The photo fills the card and is never cropped or hidden
  behind the info bar: the filename, date, size and format sit in a translucent
  overlay pinned to the bottom edge, so they cost the image no height.
- **Inspect** without leaving the queue. Scroll to zoom the current card in place
  around the cursor (up to 8×) and double-click to toggle 1×/2×. Zoom past 20% and
  a drag pans the zoomed image instead of swiping, so you cannot decide a photo by
  accident while inspecting it; a percentage pill appears in the progress row.
  Clicking the image opens a full-screen viewer with the same zoom and pan.
- **Walk the queue.** A filmstrip under the buttons shows the previous few
  decisions and the next few photos; click any of them to jump back. It fills the
  width and scrolls sideways, and the accent ring always marks the current item.
- **Inspect** any photo full-screen. Click the image to open a viewer where scroll
  zooms (up to 8×), drag pans, double-click toggles 1×/2×, and `Esc` closes.
- **Preview** months visually: each month row carries a strip of sample
  thumbnails and an icon-led stat, not just numbers.
- **Remember** every decision in SQLite, so a month is only "done" when it stays
  done. Skipped files come back at the end of the same pass.
- **Delete safely.** A left-swipe only marks a file. Nothing touches the disk
  until you press *Move to Recycle Bin*, which uses the Recycle Bin, so the
  files stay recoverable. The confirmation dialog shows every staged file as a
  small thumbnail with its name, plus the total count and size, so you can spot
  anything that should not be there. The footer bar expands and collapses
  smoothly, so showing it never shifts the content.

## Requirements

- Windows 10/11 with WebView2 (preinstalled on current Windows).
- [Rust](https://rustup.rs) with the MSVC toolchain.
- Node.js only to run the Tauri CLI.

Verified on: Windows 11, Rust 1.98 (stable-msvc), Node 24, Visual Studio 2022
toolset.

## Running it

```powershell
npm install
npm run dev          # tauri dev
npm run build        # NSIS installer in src-tauri/target/release/bundle
```

## Diagnosing problems

Two logs, because a release build cannot always be attached to a debugger:

- **DevTools** — press `F12` or `Ctrl+Shift+I`. The frontend logs every command,
  view change, decision and error to the console via `src/log.js`. Type
  `__sifterLog.dump()` in the console to print the whole recent history.
- **File log** — the Rust backend appends to
  `%APPDATA%\com.hope.screenshotsifter\logs\sifter.log` (rotated at 2 MiB, the
  previous file kept as `sifter.log.old`). Press `Ctrl+Shift+L` to read the tail
  in a modal, or open the file directly.

Both are always on, including in release builds.

## Tests

```powershell
npm run test:logic   # 28 frontend logic tests (node --test)
npm run test:gui     # 114 GUI assertions: the real src/app.js in headless Chrome
cd src-tauri; cargo test                  # 39 unit + 2 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

`npm run test:gui` loads `tests/gui-smoke.html` in headless Chrome, which runs
the unmodified `src/app.js` against an in-memory stand-in for the Rust commands,
then drives it with real browser key events. It covers what the Rust tests
cannot: the rendered card, the keyboard shortcuts, drag-decision rollback, the
confirmation dialog, the DevTools and log-viewer shortcuts, and the two edge
cases around failed writes and cross-queue undo. It needs Chrome installed and
asserts that Enter does **not** confirm a destructive action.

## Architecture

```
src/                  static frontend, no bundler
  index.html
  style.css
  logic.js            pure helpers + ReviewQueue, unit tested
  app.js              views, gestures, keyboard
src-tauri/
  src/db.rs           SQLite schema, queries, month grouping
  src/scan.rs         directory walk + filename date inference
  src/commands.rs     the Tauri command surface
  src/lib.rs          app setup and state
```

### Why no plugins

The frontend calls `window.__TAURI__.core.invoke` and nothing else. Folder
picking, scanning, the database and the Recycle Bin are all this app's own Rust
commands, so the capability file grants `core:default` and nothing more. There is
no filesystem plugin scope to get wrong.

The one exception is the asset protocol, which is how the review card displays an
image from an arbitrary folder. It is configured in `tauri.conf.json` rather than
through a plugin permission.

### Deletion model

| Status | Meaning | On disk |
| --- | --- | --- |
| `pending` | not decided | yes |
| `staged` | marked for deletion | **yes** |
| `kept` | keep | yes |
| `skipped` | revisit later | yes |
| `deleted` | sent to Recycle Bin | no |

A rescan refreshes size, dates and the missing flag but never resets a decision,
so deleting a folder and restoring it later does not undo your work.

## Data

The database lives in Tauri's app data directory (`%APPDATA%\com.hope.screenshotsifter\`):

- `sifter.db` — SQLite, WAL mode.
- Tables: `roots`, `screenshots`, `staged`, `meta` (schema version).

To start over, close the app and delete that file.

## Supported formats

Previewable by WebView2: `png`, `jpg`/`jpeg`, `jfif`, `webp`, `bmp`, `gif`, `avif`.

Tracked but not previewable, shown as a placeholder you can still decide on:
`heic`, `heif`, `tif`, `tiff`. Video files are ignored entirely.

## Limitations

- Skipped files reappear at the end of the same pass. There is no separate
  "skipped this session only" mode.
- Undo is per session. Decisions survive a restart; the ability to walk them
  back does not.
- The undo stack is not re-seeded when you switch folders.
- There is no thumbnail grid yet, by design. The month list is numbers only.
- Staging and the Recycle Bin commit are global across every watched folder,
  while the month list and per-month counts are per folder.

## License

MIT. See [LICENSE](LICENSE).
