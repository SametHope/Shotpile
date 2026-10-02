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

## A. Known problems in 1.4.0 (reported from a real Windows run)

Nothing here was root-caused with a debugger; the "likely cause" lines are reading
the code, not confirmed. Status as of the last session:

- **Fixed in code, still needs a manual pass on the target OS:** A1 (rebinding),
  A2 (missing command registrations), A3 (file manager), A4 (clipboard),
  A5 (filmstrip), A6 (unstyled filename filter), plus the GUI suite's
  dependence on the host OS colour scheme.
- **Open:** A7 (the rest of the thin coverage).

### Later follow-ups from a real Windows run (this session)

- **The filmstrip could select items that were off-screen.** The strip rendered
  a fixed window (5 before, 9 after) regardless of how many items fit; once the
  thumbnails grew with the strip, the current item — and clickable neighbours —
  sat clipped outside it. It now derives the window from the strip width and the
  item size (`filmItemsPerSide` in logic.js) and re-paints on the strip drag and
  on window resize, so the current item stays centred and nothing off-screen is
  rendered. The two edges also fade with a mask now.
- **The waiting cards, not the top card, overlapped the buttons.** `.deck-1` /
  `.deck-2` are translated below the stage; the stage only reserved 12px, so the
  peeking stack rode up over Delete/Skip/Keep. `.stage` now reserves 48px, and
  `reviewLayout()` measures the *lowest* card, not the top one, so the old test
  could not hide it. At the original 12px the lowest card crossed the action row
  by 6px in the suite, so this one is reproduced headlessly — the display-scaling
  report was not the cause. The short-window (`max-height: 600px`) branch was
  measured too and needed no change: it cuts `--deck-dy` to 24px, so its 20px
  margin already leaves ~14px. The two are coupled; the suite now asserts both
  sizes.
- **The progress-bar stripes were on the wrong part.** 1.4.0 striped the deleted
  segment; the user wanted deleted solid red and the *unsorted* remainder (the
  track) striped, which is what it does now. See the CSS gotchas in AGENTS.md.

1. **Rebinding did nothing outside the review.** *Fixed:* the keydown handler
   now resolves every key through the binding table, so Options, Help, zoom, the
   viewer, undo and redo are rebindable and work in every view, not just the
   review. Help is a default action (`?`); Options keeps Ctrl+, as a permanent
   alias but also accepts a rebind. The capture ignores lone modifiers, cancels
   on Escape, and reads the map fresh each time (a second rebind in one Options
   sheet used to overwrite the first, and cancel/conflict restored a stale
   label). GUI tests rebind Options and press it from the library, and cancel
   with Escape. Confirmed in the fake-backend suite; press it in a real build
   too.
2. **`incr_counter` was not registered.** *Fixed:* it and `unstage_multiple`
   (which "Restore all" in the pile calls, and the report missed) are now in
   `tauri::generate_handler!`. `tests/commands.test.mjs` now compares every
   `api("...")`/`invoke("...")` name in `src/` against `lib.rs` and fails on a
   gap, so this class of bug cannot ship again. The frontend-driven counters
   still swallow errors with a warn; registration was the actual fault.
3. **"Show in file manager" opened Documents.** *Fixed:* the Windows branch now
   passes a single `raw_arg` of the form `/select,"C:\dir\file.png"`, instead of
   letting `Command::arg` quote the whole `/select,...` token — explorer parses
   its own command line and answering a quoted token with Documents is the
   documented failure. Forward slashes are normalised first. The argument string
   is unit tested; the spawn still needs a glance on Windows (see the manual
   list in the reply).
4. **"Copy image" was wrong on Windows.** *Fixed, unverified:* the PowerShell
   spawn and the `pbcopy`/`xclip` branches are gone. `copy_image` decodes the file
   with the `image` crate (guessing the format, so a `.jfif` works) and puts a
   bitmap on the clipboard with `arboard`: `CF_DIB`/`CF_BITMAP` on Windows, an
   `NSImage` on macOS, `image/png` on Linux. That removes the console flash and
   is what Discord and WhatsApp accept. Both crates are `MIT OR Apache-2.0`,
   already inside `about.toml`; the resolved license expressions were checked
   against the allowlist. Decoding is unit tested. **It still has to be pasted
   into a real app** — neither headless Chromium nor the Rust tests can prove the
   clipboard. AVIF cannot be decoded (the `avif` feature is deliberately off), so
   copying one reports an error.
5. **Resizable filmstrip was cosmetic.** *Fixed:* the thumbnails now scale with
   `--filmstrip-height` (`.film-item` height/width derive from it, keeping the
   thumbnail aspect), so enlarging the strip shows bigger previews. At the
   default 52 px the item is still the original 42x60. The original "buttons
   overlap the deck" report turned out to be the *peeking* cards, not the top
   one: the stage now reserves 48px for them (see the follow-ups above), and the
   overlap reproduces headlessly, so it is worth one look at 125%/150% by hand
   only to confirm the fix looks right at your scale.
6. **The filename filter was unstyled.** *Fixed:* `.filter-box` now uses the
   token surface/line colours, the `.btn` radius and the accent focus ring, and
   a GUI test checks the computed style and that typing actually hides
   non-matching filmstrip items.
7. **Test coverage of the 1.3/1.4 features is thin.** *Partly fixed:* command
   registration, the filename filter, filmstrip resizing and global rebinding are
   now covered. Still thin: library keyboard navigation, batched grids, "Restore
   all", the duplicates dialog, the progress modal and the statistics section.
   A3/A4 have unit tests only for what can be tested off-device (the explorer
   argument, the image decode), which is the honest ceiling for OS-level work.

Suggested way to work the rest: reproduce each item in `npm run dev` (or a
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
   - Requested on a real run, not started yet:
     - A toggle to hide the Delete/Skip/Keep row (it sits between the card deck
       and the filmstrip) so the filmstrip can be made much taller.
     - More horizontal room for the filmstrip, so it holds more items — wider
       default window, and/or a taller-than-wide default.
     - Hide the filename filter in the review. Nobody remembers why it was made
       visible; it is not earning its place next to the filmstrip.
     - Consistency: the overview progress bar stripes its unsorted track, but the
       per-month stacked bars do not. Stripe the month bars the same way.
6. **Black flash on the first scroll after a resize.** *Root-caused and fixed in
   code.* Two rounds: `set_window_background` now sets the theme colour on the
   window and the webview (`syncWindowBackground()` in app.js follows
   `data-theme`), because WebView2's `DefaultBackgroundColor` defaults to white.
   On a real run that changed the flash from **white to black** and did not stop
   it — which proved the flash *is* the webview base colour showing through, not
   the page. The cause was `backdrop-filter` on `.topbar` (and `.footbar`): it
   sat over nothing, but still forced a render surface, and WebView2 presented
   that surface uninitialised (black) when the window was resized and the
   library was scrolled afterwards. Both filters are gone and `#view` (the
   scroll container) now paints `var(--bg)` instead of being transparent.
   **Needs a real Windows re-check** (maximise or F11, then scroll the grid).
   Still open and explicitly out of scope for now: small black flashes while
   *moving* a non-fullscreen window.

## C. What 1.3/1.4 added (implemented; verified only by the fake-backend tests
unless section A says otherwise)

- Right-click: copy image (native clipboard, A4), copy file name, show in file
  manager (raw-arg select, A3); a pile-tile menu (restore, open, show in file
  manager, copy path/name).
- `A`/`D`/ArrowDown step the filmstrip; shortcut rebinding UI in Options
  (now wired to the handler, A1); the Filter-button dot was removed.
- "Next month" is chronological (`nextMonthWithWork` in `logic.js`: nearest
  later month with work, else nearest earlier, with tests).
- Done months can be opened (`kept` scope in `queue_ids`).
- Resizable filmstrip (fixed, A5), lighter info-bar blur limited to the corners,
  striped unsorted track in the progress bar (the deleted segment is solid red
  again; see the follow-ups in section A).
- A blocking progress modal for commits over 20 files (`commit-progress`
  events every 5 files) and batched rendering of the library and pile grids
  (100 per animation frame).
- Local statistics: `counters` table, `get_counters` / `reset_counters` /
  `incr_counter` commands, an Options section (registration fixed, A2).
- Library keyboard navigation (arrows, Enter), a filename filter in a review
  (styled and tested, A6), "Restore all" in the pile (`unstage_multiple`),
  Linux file selection through the FileManager1 DBus call with an `xdg-open`
  fallback.
- Exact duplicate detection (`dupes.rs`: size, hash, then a byte compare;
  staging only, never deletes).

## D. Lessons for the next session

- The fake backend and the Rust backend are two implementations of one
  contract. A command can exist in `commands.rs`, work in the fake and still
  be missing from `lib.rs`. `tests/commands.test.mjs` now enforces it; keep
  that test as the source of truth. It caught a second unregistered command
  (`unstage_multiple`) the original report missed.
- Anything that touches the OS (clipboard, file manager, window background)
  cannot be proven by headless Chromium. Say "implemented, unverified" until
  it has been run on the target platform.
- The host OS leaked into the GUI suite: with Windows in dark mode, an
  assertion that hard-coded the light accent failed. The suite now pins
  `prefers-color-scheme: light` at the start and emulates dark only in the
  dark-theme section, so a green run no longer depends on the developer's
  theme.
- GUI assertions that check a menu or button exists are not tests of what it
  does. Test the effect (the key opens Options, the thumbs resize, the
  clipboard holds a bitmap where that can be read back).
- Some apps parse their own command line. `explorer.exe` is the example here:
  it wants `/select,"C:\dir\file.png"` as one `raw_arg`, not an `arg` (Rust
  would quote the whole token once it has a space, and explorer then opens
  Documents). Extract the argument into a pure function so the part that can be
  tested is tested.
- A native clipboard write beats shelling out. `arboard` puts a bitmap
  (`CF_DIB`/`CF_BITMAP`) on Windows, an `NSImage` on macOS and `image/png` on
  Linux, with no PowerShell window. Before adding a dependency here, check its
  license against `about.toml` (the release runs `cargo-about`); `cargo metadata`
  lists every resolved package's license, which is enough to grep the allowlist.
- Work done by parallel helpers merges cleanly in git and still breaks:
  re-run every suite after the merge and read the diff of shared files
  (`app.js`, `commands.rs`, `fake-backend.js`, `style.css`).
