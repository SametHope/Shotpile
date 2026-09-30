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
- **Remember** every decision in SQLite, so a month is only "done" when it stays
  done. Skipped files come back at the end of the same pass.
- **Delete safely.** A left-swipe only marks a file. Nothing touches the disk
  until you press *Geri dönüşüm kutusuna taşı*, which uses the Recycle Bin, so
  the files stay recoverable.

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

## Tests

```powershell
npm run test:logic   # 23 frontend logic tests (node --test)
npm run test:gui     # 49 GUI assertions: the real src/app.js in headless Chrome
cd src-tauri; cargo test                  # 36 unit + 2 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

`npm run test:gui` loads `tests/gui-smoke.html` in headless Chrome, which runs
the unmodified `src/app.js` against an in-memory stand-in for the Rust commands,
then drives it with real browser key events. It covers what the Rust tests
cannot: the rendered card, the keyboard shortcuts, drag-decision rollback, and
the confirmation dialog. It needs Chrome installed and asserts that Enter does
**not** confirm a destructive action.

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
