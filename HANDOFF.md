# HANDOFF

State of the project for a fresh session. `AGENTS.md` holds the rules and
architecture traps; this file holds where things stand and what is unfinished.

Last updated after `d1bba4a` (deck promotion rework). Working tree clean.

## Current state

Working, tested, no known bugs. All suites green:

| Suite | Command | Result |
| --- | --- | --- |
| Frontend logic | `npm run test:logic` | 28 passed |
| GUI (real `app.js` in headless Chrome) | `npm run test:gui` | 135 passed, 0 console errors |
| Rust | `cd src-tauri; cargo test` | 39 unit + 2 e2e |
| Rust lint / format | `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | clean |

Release installer built and current:
`src-tauri\target\release\bundle\nsis\Screenshot Sifter_1.0.0_x64-setup.exe`

## What was just worked on

The review deck used to rebuild the entire view on every decision
(`render()` does `el.view.replaceChildren(...)`). That destroyed the card that
had just slid forward under the top one and replaced it with a fresh node that
faded in, so advancing read as flicker → snap → fade. `advanceDeck()` now
promotes the parked card in place instead. See the "Advancing must not re-render
the deck" notes in `AGENTS.md`.

## Open items

Nothing is broken. These are the loose ends, in rough priority order:

1. **Manual WebView2 check.** Automated tests fake the Rust surface and drive
   synthetic pointer events, so real drag/zoom feel is unverified. Worth one
   pass in a release build: swipe right, swipe left, drag a zoomed card, click
   through a review pass. Transition timing is a one-line change
   (`.26s` in `src/style.css`) if it feels off.
2. **`DELETE_GRID_LIMIT = 60`** in `src/app.js`. The Recycle Bin confirmation
   caps its preview grid at 60 thumbnails and shows a "+N more" count. If every
   staged file should be previewable, make the grid scroll or paginate.
3. **Turkish strings in backend diagnostics.** User-facing UI is English only,
   but a few log/error strings are still Turkish:
   - `src-tauri/src/db.rs`: `db açıldı`
   - `src-tauri/src/commands.rs`: `geçersiz kuyruk: {other}`
   - `src-tauri/src/log.rs`: `açılamadı`
   These only surface in logs and error toasts, never in normal UI copy.

## Where things are

```
src/app.js          all DOM, gestures, keyboard, Tauri calls (largest file)
src/logic.js        pure, DOM-free, unit tested
src/log.js          leveled logger + ring buffer
src/style.css       visual tokens at the top, then per-view rules
src-tauri/src/      db.rs, scan.rs, commands.rs, log.rs
tests/              logic.test.mjs (node --test), gui-smoke.{html,cjs} (CDP)
tools/make-icon.ps1 icon source generator
```

## How to verify a change

Run all four suites before claiming done — see the table above. If you touch a
view, a shortcut, or the confirm dialog, add a probe in `tests/gui-smoke.html`
and an assertion in `tests/gui-smoke.cjs`; that is where the rendered card, the
keyboard map and the dialog are actually covered.

For debugging: frontend `F12` (or `Ctrl+Shift+I`) and `__sifterLog.dump()`;
backend log at `%APPDATA%\com.hope.screenshotsifter\logs\sifter.log`, also
viewable in-app with `Ctrl+Shift+L`.