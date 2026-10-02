# HANDOFF

Open items for the next session. The rules, layout and how to verify a change
are in `AGENTS.md`; what the app does is in `README.md`. History is in git.

**Read the first section before trusting anything marked "shipped" in the
README or in git history.** Release 1.4.0 added a lot in one pass, and a real
Windows run found several of the new features broken even though every
automated check was green. The checks run against the fake backend in
headless Chromium, so they cannot see missing Rust registrations, platform
behaviour or real layout. Treat the features below as *implemented but
unverified* until someone has run them in a real build.

## A. Known problems in 1.4.0 (reported from a real Windows run, not yet fixed)

Nothing here has been fixed or root-caused with a debugger; the "likely cause"
lines are reading the code, not confirmed.

1. **Rebinding does nothing.** Setting the Options shortcut to `p` and pressing
   it anywhere does not open Options. Likely cause: only the review view's
   key handler (`keyBindings[e.key]` near the end of `src/app.js`) looks keys
   up through the action table; the global shortcuts (Options, zoom, help,
   viewer) are still hard-coded, and the rebinding UI saves into prefs that
   only the review handler reads. Also check that the stored map's direction
   (key to action id) matches what `getKeysForAction` and the lookup expect,
   and that captured keys are normalised the same way (`e.key` case,
   modifiers). Needs a GUI test that rebinds a key and presses it.
2. **`incr_counter` is not registered.** The console shows
   `Command incr_counter not found` (from `review:time_seconds` and the
   launch/viewer counters). The command exists in `commands.rs` but was never
   added to `tauri::generate_handler!` in `lib.rs` (only `copy_image`,
   `get_counters`, `reset_counters` were). The fake backend has it, which is
   why the tests passed. Fix, then add a test that fails when any command name
   the frontend calls via `api("...")` is missing from `lib.rs` (grep both,
   compare). Related: the frontend-driven counters swallow errors with a warn,
   so they failed silently apart from the console.
3. **"Show in file manager" still opens Documents.** It should open the folder
   containing the image with the file selected. The Windows branch runs
   `explorer /select,<path>`; explorer falls back to Documents when the path
   is not in the form it expects (forward slashes, a `\?\` prefix, or the
   argument being quoted/split wrongly by `Command::arg`). Check what path
   the `reveal` command receives for `target: "shot"` and normalise to
   backslashes, passing `/select,` and the path as one raw argument
   (`CommandExt::raw_arg` on Windows). Verify by hand on Windows; a unit test
   can only check the argument building.
4. **"Copy image" is wrong on Windows.** It spawns a PowerShell window (visible
   console flash; needs `CREATE_NO_WINDOW`) and the clipboard content cannot
   be pasted into Discord or WhatsApp with Ctrl+V. Those apps want a bitmap
   (`CF_DIB`/`CF_DIBV5`/PNG) or a file drop list of the right kind, and the
   current approach does not provide one. Prefer a native clipboard write
   from Rust (decode the image, put a bitmap on the clipboard; check any new
   crate's licence is in `about.toml`) over shelling out. macOS (`pbcopy` with
   raw bytes, which does not put an image on the pasteboard) and Linux
   (needs `xclip`, which may not be installed) are very likely wrong too.
   Never claim this works without pasting into a real app.
5. **Resizable filmstrip is cosmetic.** Dragging the handle up makes the strip
   taller, but the thumbnails keep their size, so it gains nothing. The
   thumbs must scale with `--filmstrip-height`. Also, when the strip is
   enlarged the Delete / Skip / Keep buttons overlap the deck above: the
   review layout (`.review` flex column, `.stage`, the action row, the strip)
   does not reserve the extra height, so the deck needs to shrink instead
   (keep the flex height chain from AGENTS.md "Review view"). Check small
   windows too.
6. **The filename filter is unstyled.** The input in the review chrome has no
   CSS beyond the browser default; it needs the same styling as the other
   inputs, dark-theme values, and a sensible place in the layout.
7. **Test coverage of the 1.3/1.4 features is thin.** The agents that wrote
   them added little GUI coverage for: the filename filter, library keyboard
   navigation, batched grids, "Restore all", the duplicates dialog, the
   progress modal, the statistics section, filmstrip resizing and rebinding.
   Every item in this section got through CI for that reason. Fixing the
   bugs above should come with tests that fail first.

Suggested way to work this section: reproduce each item in `npm run dev` (or a
real build), write the failing test where one is possible, fix, then check by
hand on Windows. Do not mark one done on the strength of the fake backend.

## B. Longer-standing items, in rough priority order



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
5. **Remaining planned work** (also in the README's Planned section):
   - The statistics infographic (a small window or section; totals as
     sentences or bars, themed with tokens and dark values; no libraries).
   - More counters if wanted (longest streak, folders added). Counters live
     in the SQLite `counters` table, keyed by name; recording a new one needs
     no migration. Forgetting a folder must not erase lifetime totals;
     nothing leaves the machine.
   - Rust tests for the swipe-direction counters (the 80 px threshold in
     `apply_decision`).
   - Possible later: a grouped undo for a whole pass, near-duplicate
     detection (today only byte-identical files).
6. **White flash on fullscreen and first scroll.** The start-up flash is handled
   (hidden window, `#splash`, boot.js). 1.4.0 also set `backgroundColor` on the
   window in `tauri.conf.json` (light theme colour only), but that was never
   checked on Windows and does not cover the dark theme. Still to research:
   the WebView2 background (dark theme), the resize-to-fullscreen repaint,
   and compositing of the scrolling `#view`.

## C. What 1.3/1.4 added (implemented; verified only by the fake-backend tests
unless section A says otherwise)

- Right-click: copy image, copy file name, show in file manager (see A3, A4);
  a pile-tile menu (restore, open, show in file manager, copy path/name).
- `A`/`D`/ArrowDown step the filmstrip; shortcut rebinding UI in Options
  (see A1); the Filter-button dot was removed.
- "Next month" is chronological (`nextMonthWithWork` in `logic.js`: nearest
  later month with work, else nearest earlier, with tests).
- Done months can be opened (`kept` scope in `queue_ids`).
- Resizable filmstrip (see A5), lighter info-bar blur limited to the corners,
  striped "deleted" segment in the progress bar.
- A blocking progress modal for commits over 20 files (`commit-progress`
  events every 5 files) and batched rendering of the library and pile grids
  (100 per animation frame).
- Local statistics: `counters` table, `get_counters` / `reset_counters` /
  `incr_counter` commands, an Options section (see A2).
- Library keyboard navigation (arrows, Enter), a filename filter in a review
  (A6), "Restore all" in the pile (`unstage_multiple`), Linux file selection
  through the FileManager1 DBus call with an `xdg-open` fallback.
- Exact duplicate detection (`dupes.rs`: size, hash, then a byte compare;
  staging only, never deletes).

## D. Lessons for the next session

- The fake backend and the Rust backend are two implementations of one
  contract. A command can exist in `commands.rs`, work in the fake and still
  be missing from `lib.rs`. Add the registration check from A2.
- Anything that touches the OS (clipboard, file manager, window background)
  cannot be proven by headless Chromium. Say "implemented, unverified" until
  it has been run on the target platform.
- GUI assertions that check a menu or button exists are not tests of what it
  does. Test the effect (the key opens Options, the thumbs resize, the
  clipboard holds a bitmap where that can be read back).
- Work done by parallel helpers merges cleanly in git and still breaks:
  re-run every suite after the merge and read the diff of shared files
  (`app.js`, `commands.rs`, `fake-backend.js`, `style.css`).
