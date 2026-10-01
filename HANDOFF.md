# HANDOFF

State of the project for a fresh session. `AGENTS.md` holds the rules and
architecture traps; this file holds where things stand and what is unfinished.

## Current state

Working, tested, no known bugs. All suites green on Linux (the cloud session
that made these changes); CI runs them on Linux and Windows.

| Suite | Command | Result |
| --- | --- | --- |
| Frontend logic | `npm run test:logic` | 44 passed |
| GUI (real `app.js` in headless Chrome) | `npm run test:gui` | 227 passed, 0 console errors |
| Rust | `cd src-tauri; cargo test` | 69 unit + 4 e2e |
| Rust lint / format | `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | clean |

Releases are built by `.github/workflows/release.yml`, from a pushed `v*` tag
or a hand-started run that creates the tag; the README links the latest one.

## What the last session changed

A full pass over the app: correctness, UX, look, tests, logging, docs.

Bugs fixed (each has a regression test):

- **Swiping only worked once per render.** Gesture handlers captured the top
  card in a closure, so after the first promotion every drag moved a detached
  node: the visible card did not follow the pointer, showed no tint or stamp,
  and the decision still landed on release. Gestures are now delegated.
- **Undo after "Move to Recycle Bin"** set the committed row back to pending
  although its file was in the bin. The undo stack (`undo.rs`) now skips stale
  entries and never touches a committed row.
- **Undoing a skip** sought the card at the back of the queue, so deciding it
  ended the pass and silently dropped every card in between.
- **Skipping the last card** showed it again forever (and a pass of skips never
  ended). Each card is now deferred once per pass.
- **Keyboard decisions** snapped the next card into place and cut the outgoing
  card's fade short; they now throw the card like a swipe and the deck glides.
- **Races in the review:** a key pressed while the last card was leaving
  decided it a second time; a key during a drag decided the dragged card and
  the release then decided the next one; holding an arrow key machine-gunned
  through the queue. All locked out, each with a test.
- A rescan blocked every decision until it finished and then pulled the user
  out of the review they had opened meanwhile.
- A rescan flagged the app's own deletes as **missing**, resetting the deleted
  counts and reporting them as vanished files; missing files appeared in review
  queues as broken cards.
- Commit failures were reported one toast per file, each overwriting the last,
  so only the final one was ever visible.
- A backdrop click on the confirm dialog left its promise and Escape handler
  alive; Escape did not close the log viewer; a dialog opened from the viewer
  appeared behind it.
- "1 files" and friends; Turkish strings in backend errors (shown in toasts) and
  in the folder picker title.
- The app icon had stray "feet" from wrong arc angles in the old generator.

A review pass over the reworked UI then found and fixed (each with a test that
fails when the fix is reverted):

- A key pressed while a jumped-to card was still loading decided the card still
  on screen and advanced from the new position, skipping a card unseen.
- Opening a month while a commit was moving files gave a review that ignored
  every key; folders could be switched or forgotten mid-scan or mid-commit (a
  scan finishing after a forget added the folder straight back).
- Checking the deletion pile card by card used the current folder's filter, so
  other folders' files never came up; `Skip` there silently took a file off the
  pile; keeping one did not update the badge.
- An undo pressed while the last card was leaving was dropped, and the summary
  then covered the card.
- With focus on a review button, `Enter` in the viewer decided the card behind
  the photo; `Enter` on a dialog over the viewer closed the viewer instead.
- A toast's *Undo* stayed clickable above the delete confirmation; the
  collapsed footer kept its buttons in the tab order; *Put back* lost its
  confirmation when the count refresh failed; the pile opened scrolled to
  wherever the library was.

New: a redesigned library (overview line, stacked status bars, months grouped
by year with a fan of thumbnails), an end-of-pass summary that offers the next
month, the deletion pile as a thumbnail grid with *put back*, a folder switcher
with *forget folder*, onboarding that explains the gestures, a `?` shortcuts
sheet, a dark theme, undo animations, screen-reader announcements, a live
count during scans, frontend errors and panics in the file log,
`npm run preview` (with a `?demo` library), CI, a README tour with pictures
generated from the real UI (`npm run screenshots`), and a release workflow.

## Open items

Nothing is known broken. In rough priority order:

1. **Manual WebView2 pass.** Everything was verified in headless Chromium
   against the fake backend, plus the Rust tests; no one has driven the new UI
   in a real Windows build yet. Worth one pass in `npm run dev`: swipe, use the
   keys, undo each kind of decision, finish a month, commit from the pile, and
   switch Windows to dark mode. Motion timings are tokens (`EXIT_MS` in
   `app.js` with `.card.leaving`, the slot transition on `.deck .card`).
2. **Thumbnails are full-size images.** The month fans, the filmstrip and the
   pile all load the original files through the asset protocol and let the
   WebView scale them. Fine for hundreds of screenshots; for many thousands a
   Rust-side thumbnail cache (e.g. the `image` crate writing small JPEGs into the
   app data dir) would cut memory and decode time.
3. **DST at month edges.** Months are grouped with the current UTC offset for
   every date, so a shot taken in the first or last hour of a month across a DST
   change can land in the neighbouring month.
4. **A file restored from the Recycle Bin stays `deleted`.** By design a rescan
   never changes a decision; restoring files is rare enough that it has no UI.
5. Version numbers are still 1.0.0 everywhere; bumping is a release decision.

## Where things are

```
src/app.js          views, deck, gestures, keyboard, Tauri calls (largest file)
src/dom.js          element builder, toast, modal, confirm dialog, menu
src/viewer.js       full-screen viewer
src/logic.js        pure, DOM-free, unit tested
src/log.js          leveled logger + ring buffer + file-log sink
src/style.css       tokens (light, dark) first, then per-view rules
src-tauri/src/      db.rs, scan.rs, commands.rs, undo.rs, log.rs
tests/              logic.test.mjs, gui-smoke.cjs (+ serve.cjs, fake-backend.js, probes.js)
tools/              app-icon.svg (icon source), screenshots.cjs (README pictures)
docs/screenshots/   the README pictures, generated; do not edit by hand
```

## How to verify a change

Run all suites before claiming done; see the table above. If you touch a view,
a shortcut, or the confirm dialog, add a probe in `tests/probes.js` and an
assertion in `tests/gui-smoke.cjs`. If you change a command, change
`tests/fake-backend.js` to match.

For debugging: frontend `F12` (or `Ctrl+Shift+I`) and `__sifterLog.dump()`;
backend log at `%APPDATA%\com.hope.screenshotsifter\logs\sifter.log`, also
viewable in-app with `Ctrl+Shift+L`.
