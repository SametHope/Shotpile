# HANDOFF

Open items for the next session. The rules, layout and how to verify a change
are in `AGENTS.md`; what the app does is in `README.md`. History is in git.

Nothing is known broken. In rough priority order:

1. **A manual pass in a real Windows build.** Everything is verified in
   headless Chromium against the fake backend, plus the Rust tests. Worth one
   pass in `npm run dev` after UI changes: the start-up (no white flash), swipe
   and keys, undo and redo of each kind of decision, finishing a month, the
   pile and its commit, Options (theme, zoom, the Open buttons), right-click
   menus, and Windows display scaling at 125% and 150%.
2. **Thumbnails are full-size images.** The month fans, the filmstrip and the
   pile load the original files and let the WebView scale them. Fine for
   hundreds of screenshots; for many thousands a Rust-side thumbnail cache
   (small JPEGs in the app data folder) would cut memory and decode time.
3. **DST at month edges.** Months are grouped with the current UTC offset for
   every date, so a shot taken in the first or last hour of a month across a
   DST change can land in the neighbouring month.
4. **A file restored from the Recycle Bin stays `deleted`.** By design a rescan
   never changes a decision; restoring is rare enough that it has no UI.
5. **Code signing.** Releases are unsigned, so SmartScreen warns on first run.
