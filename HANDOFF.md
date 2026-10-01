# HANDOFF

Open items for the next session. The rules, layout and how to verify a change
are in `AGENTS.md`; what the app does is in `README.md`. History is in git.

Nothing is known broken. In rough priority order:

1. **A manual pass in a real Windows build.** Everything is verified in
   headless Chromium against the fake backend, plus the Rust tests. Worth one
   pass in `npm run dev` after UI changes: the start-up (no white flash), swipe
   and keys, undo and redo of each kind of decision, finishing a month, the
   pile and its commit, Options (theme, zoom, the Open buttons), right-click
   menus, Windows display scaling at 125% and 150%, a per-folder pile with two
   folders, and a file restored from the Recycle Bin coming back as kept.
2. **Thumbnails are full-size images.** The month fans, the filmstrip and the
   pile load the original files and let the WebView scale them. Fine for
   hundreds of screenshots; for many thousands a Rust-side thumbnail cache
   (small JPEGs in the app data folder) would cut memory and decode time.
3. **DST at month edges.** Months are grouped with the current UTC offset for
   every date, so a shot taken in the first or last hour of a month across a
   DST change can land in the neighbouring month.
4. **macOS and Linux have seen little real use.** They build in the release
   workflow and the Rust tests run on Linux in CI, but nobody has done a manual
   pass on a Mac. On macOS the `trash` crate goes through Finder, which asks
   for Automation permission on the first commit. Shortcut labels say `Ctrl`
   even where `Cmd` works.
5. **Planned features** (also in the README's Planned section):
   - Right-click menu: copy image; make "show in file manager" select the file
     (it currently opens Documents); extend the menu to pile tiles with
     restore, open, show in file manager, copy full path and copy file name.
   - `A`/`D` (maybe Down for previous) to move through the filmstrip relative
     to the current photo.
   - Rebindable shortcuts in Options. Needs actions separated from keys first
     (an action table in `logic.js`, keys looked up through it, saved in
     prefs), so the keyboard handler and the Keyboard help share one source.
   - Remove the dot on the Filter button while months are hidden.
   - Ideas, unrated: library keyboard navigation, filename filter in a review,
     bulk restore from the pile, a per-file failure list after a commit,
     grouped undo for a pass, duplicate detection (needs a hashing crate whose
     licence is in `about.toml`).
6. **White flashes after start-up.** The start-up flash is handled (hidden
   window, `#splash`, boot.js), but a white flash can still show when the
   window goes fullscreen and on the first scroll afterwards. Not yet
   investigated: it may be the WebView (WebView2) painting before the page
   catches up, or a Tauri window background issue. Worth researching properly:
   the window and WebView background colour (including dark theme), the
   resize-to-fullscreen repaint, and compositing of the scrolling `#view`.
7. **"Next month" ordering.** The next-month button on a finished month does not
   use that month's date: working in 2025 can land in 2026. It should pick the
   nearest later month that still has work, else the nearest earlier one,
   chronologically. Look at where the summary picks the next month in
   `src/app.js` and add the selection as a pure function in `logic.js` with
   tests (including the library hiding done months).
8. **Large piles freeze the app.** Committing a big deletion pile gives no
   feedback and the UI stalls. Plan: a blocking modal with progress (done of
   total, current file) fed by the commit, which probably means running the
   trash calls in chunks or emitting progress events from `commit_deletes` and
   keeping the `apply_*` logic testable. Related: render the month and pile
   grids in batches (e.g. per animation frame or on scroll) instead of
   building every tile at once.
9. **Local statistics.** Track many counters, all local: files and bytes
   deleted, swipes per direction, keeps/stages/skips, undos and redos,
   commits, app launches, folders added, time in review, longest streak, and so
   on. The more the better, but cheap to record. Viewable and resettable from
   Options (a reset per group and a reset all, behind a confirm dialog), and
   possibly an infographic window later. Design notes: store in SQLite (a
   counters table keyed by name, so new stats need no migration) rather than
   prefs; increment in the `apply_*` functions so the tests cover it; a
   forgotten folder must not erase the lifetime totals; nothing leaves the
   machine, and the README's Data section should say so.
