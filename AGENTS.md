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
npm run test:logic                          # 23 frontend logic tests
npm run test:gui                            # 49 GUI assertions in headless Chrome
cd src-tauri; cargo test                    # 36 unit + 2 end-to-end tests
cd src-tauri; cargo clippy --all-targets -- -D warnings
cd src-tauri; cargo fmt --check
```

`npm run test:gui` runs the real `src/app.js` in `tests/gui-smoke.html`, which
fakes the Rust command surface in memory, then drives it with real Chrome key
events via CDP. It is where the rendered card, the shortcuts and the confirm
dialog get covered. If you change a view, a shortcut, or the dialog, add a
probe there. Chrome must be installed; the script has no npm dependencies.

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

- UI text is Turkish, matching the user's other apps.
- Visual tokens live at the top of `src/style.css` and deliberately mirror the
  existing single-page QoL apps (`--accent:#1d4ed8`, `--line`, `--radius:12px`,
  the same soft gradient wash). Keep new colours in that palette.
- Keep diffs minimal. No drive-by refactors.
