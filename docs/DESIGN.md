# Shotpile design conventions

The UI and UX rules for Shotpile, written down so a session (human or AI) does
not have to read `style.css` and `app.js` to find them. Rules that guard against
a specific past bug live in `AGENTS.md` (CSS gotchas, Review view); this file is
the **how it should look and behave** reference. When the two disagree, fix the
docs in the same change. Known inconsistencies are listed at the end, in
"Design debt"; do not silently "fix" them while doing something else.

Everything here describes the code as of 1.9.0. Values are quoted from
`src/style.css` (tokens at the top of the file) and `src/dom.js`.

## 1. Principles

1. **Calm and utilitarian.** A tool for a chore, not a dashboard. State a number
   in a sentence or show it where it is used. No rows of identical stat tiles,
   no icon-in-a-tinted-circle on every element.
2. **Safe by default.** Anything destructive is staged first, confirmed in a
   dialog whose first (focused) button is Cancel, and goes to the Recycle Bin.
   The destructive button is never the default and never bound to Enter.
3. **Keyboard first, mouse and touch equal.** Every action has a key; every key
   has a button or a gesture; every button shows its live key in its tooltip.
4. **One source for each fact.** Shortcuts (`ACTIONS`, `DEFAULT_KEYS`,
   `FIXED_SHORTCUTS` in logic.js), colours (tokens), icons (icons.js), the bin's
   name (`binName()`). Never copy one into a string or a second table.
5. **No surprises while working.** No layout shift when a control appears, no
   modal flash when a dialog swaps content, no toast for something the screen
   already shows (the old "Zoom N%" toast is gone for this reason).
6. **Plain English, sentence case.** UI text, errors and log lines are English
   only (see section 9).

## 2. Hard UI rules (do / don't)

| Do | Don't |
|---|---|
| Use `var(--token)` for every surface, text, line, accent and state colour. | Hard-code a hex or `rgba()` for a themed surface or text. |
| Give every new colour a `:root[data-theme="dark"]` value. | Use `@media (prefers-color-scheme)`; boot.js resolves "System" itself. |
| Build DOM with `h()` and `icon()` from dom.js. | Use `innerHTML` with data (only `icon()` and static markup use `html`). |
| Use the existing `.btn` family (section 4). | Invent a one-off button style or a second tooltip. |
| Put a `title` on every icon-only control, plus an `aria-label`. | Add a hover bubble of your own; `title` is rendered by `initTooltips()`. |
| Show key hints with `hintKey(actionId)` (app.js). | Type a key name ("Ctrl+Z", "Space") into UI text. |
| Name the bin and file manager with `binName()` / `fileManager()`. | Write "Recycle Bin" or "File Explorer" in text. |
| Use `confirmDialog()` for anything that deletes, forgets or resets. | Confirm with `window.confirm`, or make the destructive button the default. |
| Swap a dialog's content in place (`modal()` replaces while open). | Call `closeModal()` then `modal()` to switch dialogs: it flashes. |
| Keep `[hidden]` authoritative (`display: none !important` stays). | Rely on a `display` rule to hide something. |
| Respect `prefers-reduced-motion` for any new looping or large animation. | Animate layout properties (`height`, `top`) on the review view. |
| Add a probe and an assertion in the GUI suite for a new view, key or dialog. | Ship UI the tests cannot see. |

## 3. Design tokens

All defined in `:root` (light) and `:root[data-theme="dark"]` at the top of
`style.css`. The set below is complete; use these and add to the pair, never to
one theme only.

- **Surfaces:** `--bg` (page), `--surface` (cards, dialogs, menus), `--surface-2`
  (dialog footers, hover wash, table stripes), `--surface-3` (pressed/hover on
  ghost buttons, segmented track, menu hover), `--topbar`, `--letterbox`
  (photo background), `--wash-1..4` (the soft page gradient).
- **Lines:** `--line` (default border), `--line-2` (control borders, scrollbar
  thumb), `--line-soft` (hairlines inside a surface).
- **Text:** `--text` (headings, values), `--text-2` (body, button labels),
  `--muted` (captions, meta, icons).
- **Accent (blue):** `--accent` (fills), `--accent-hover`, `--accent-text` (links
  and text on a surface; lighter in dark), `--accent-soft` (tint), `--on-accent`.
- **State:** `--danger` / `--danger-strong` / `--danger-soft`, `--ok` /
  `--ok-soft`, `--warn` / `--warn-soft`. `danger` is text/border, `danger-strong`
  is a solid fill (badge, solid button).
- **Decision colours** (the same meaning everywhere: bars, tally chips, stamps,
  donut): `--seg-kept` green, `--seg-staged` red, `--seg-deleted` darker red,
  `--seg-skipped` amber, `--seg-track` (the unsorted remainder, striped via
  `--track-line`).
- **Shape:** `--radius: 12px`; shadows `--shadow` (resting), `--shadow-md`
  (hover, tooltip), `--shadow-lg` (dialogs, menus), `--shadow-card` (the photo
  card).
- **Motion:** `--ease` (default), `--ease-out` (entrances), `--ease-in` (exits),
  `--spring` (card settle and gesture return only).
- **Type:** `--font` (UI), `--font-display` (large numbers and titles),
  `--font-mono` (paths, log).

### Colour semantics

| Meaning | Colour | Where |
|---|---|---|
| Primary action, selection, links, focus | accent | primary button, `aria-pressed`, focus ring |
| Keep / done / success | ok green (`--seg-kept` in charts) | Keep button, kept bar, ok toast edge |
| Mark for deletion / destructive | danger red (`--seg-staged` for staged, `--seg-deleted` for committed) | delete button, pile, badge |
| Skip / warning | warn amber (`--seg-skipped`) | Skip button, warnings |
| Not decided yet | `--seg-track` stripes | progress bars |

Never use red for "keep" or green for "delete", in any component.

### Values that are deliberately not tokens

The photo card's info bar, the swipe stamps, the viewer chrome and the log view
sit on photos or on a fixed dark surface, so they hard-code colours
(`#fff`, `#0a0e15`, `#d7e0ea`, the stamp reds/greens). That is the only allowed
exception (AGENTS.md); anything else needs a token. The stamp colours are
duplicated in `.stamp` and `.mini-stamp`; keep them equal.

## 4. Components

### Buttons (`.btn`)

Base: 1px `--line-2` border, `--surface` fill, `--text-2` label, 9px radius,
`7px 12px`, 13px, weight 560, 7px icon gap. Variants combine as classes:

| Class | Use |
|---|---|
| `.btn.primary` | The one main action of a screen or dialog (accent fill). One per surface. |
| `.btn` (plain) | Everything else, including Cancel. |
| `.btn.danger` | Destructive but reversible or staged (red outline). |
| `.btn.danger.solid` | The final destructive confirmation (red fill). |
| `.btn.ok` | Positive confirmation that is not the main action (green outline). |
| `.btn.ghost` | Low-emphasis toolbar action, no border until hover. |
| `.btn.sm` / `.btn.lg` | Compact (5px 9px, 12px) / prominent (10px 16px, 14px, 10px radius). |
| `.btn.icon` | Icon-only, min 32px wide. Needs `title` + `aria-label`. |
| `.btn-count` | The small count pill inside a button. |

Icon size inside buttons is 16 (modal buttons) or 18 (default `icon()`); do not
mix within one row. The review's large sorting buttons are `.act` /
`.act-keep|delete|skip|undo`, not `.btn`; they flash (`.flash`) when triggered by
a key.

### Dialogs (`modal()` / `confirmDialog()` in dom.js)

- One modal exists; calling `modal()` while open replaces its content.
- Structure: `.modal-head` (h2, 17px) / `.body` (grid, 12px gap, scrolls) /
  `.foot` (right-aligned buttons, `--surface-2`, top border). Width 520px;
  `wide` is 880px; `cls: "options-sheet"` for Options.
- Footer order: **Cancel first, confirm last.** The first footer button is
  focused on open, so the safe choice is the default.
- Every exit (button, Escape, backdrop) closes via the modal handlers.
  `blocking: true` removes Escape/backdrop and is for work in progress only.
- Opening a dialog hides the toast (an Undo behind a dialog is a bug).
- Lead text is `.modal-lead` (`--text-2`); small print is `.muted`.
- Settings rows are `.opt-row` (label left with optional `<small>` caption,
  control right), grouped under `.opt-group` headings. Use `.segmented` for a
  small exclusive choice (2 to 4 options, `aria-pressed`), a `.btn` for an
  action, a native checkbox for on/off.

### Menus (`openMenu()` in dom.js)

Popover under an anchor (`.menu`, 12px radius, `--shadow-lg`, min 280px).
Items: `.menu-item` with an optional icon, `.menu-label` (600) and `.menu-sub`
(11.5px muted); `.checked` shows the current choice; `.danger` is red;
`separator` entries draw `.menu-sep`. Escape and outside click close it.

### Toasts (`toast()`)

Bottom-centre, one at a time, 4.2s default. `tone: "error"` (red left edge) for a
failure the user must know about, `tone: "ok"` (green edge) for a success that
is not otherwise visible. An `action` adds one text button (Undo, Details).
The duration option is **`ms`**, not `duration`. A toast confirms something the
screen does not already show: not a zoom change, not a keystroke that visibly
did something. Errors say what failed and, if known, why.

### Tooltips (`title` + `initTooltips()`)

Write a normal `title`; the themed bubble (`#tooltip`: `--text` background,
`--bg` text, 12px, 8px radius, max 280px) replaces the native one. It waits
450ms on hover and 200ms on keyboard focus, hides on pointer down, key, scroll,
blur and resize, flips above/below to stay on screen, and returns the attribute
on leave. Write them as:

- A short verb phrase for an action ("Mark for deletion"), the live key in
  brackets when there is one: `${label} (${hintKey("delete")})`.
- A value or fact for read-only chips and tiles ("12 kept, 3 marked, 5 left").
- Never repeat the visible label word for word, and never write "Click to".
- Truncated text gets its full text as the `title`.

### Segmented bars, tally chips, donut

`.segbar` (6px) and `.segbar.lg` (the big one) show kept/staged/deleted/skipped
as solid segments over the striped track. `.tally-chip.t-keep|t-delete|t-skip`
use the decision colours. The donut in Options uses `.donut-seg.seg-*`. All read
the `--seg-*` tokens; keep the order kept, staged, deleted, skipped everywhere.

### Other recurring pieces

- **Section label:** `.section-label` (small caps-style heading with a trailing
  hairline) for page sections.
- **Empty state:** `.empty` with `.empty-glyph` (`.ok` for finished), an `h2`
  (18px), a short `p` (max 460px), then the primary action.
- **Cards and tiles:** `.month`, `.tile`, `.legend-card`: `--surface`, 1px
  `--line`, 12px radius, `--shadow`, hover `--shadow-md` and `--line-2`.
- **Folder chip, badge:** pill (`999px`), `--danger-strong` for the pile badge.
- **Links in text:** `.linklike` (accent, underlined, button element).
- **Loading:** `.busy` spinner (`.busy.lg` for a screen); never a blank gap.
- **Keys:** `kbd()` / `.chord` for a key cap; `keyLabel()` formats names.

## 5. Typography

- Family: `--font` everywhere, `--font-display` for the big stats and titles,
  `--font-mono` for paths and the log.
- Scale in use (px): 11, 11.5, 12, 12.5, 13 (body and buttons), 14, 15, 16, 17
  (dialog title), 18 (empty title), 20, 26, 30 (hero numbers). Body is 13 to 14.
  Prefer the existing step nearest your need; do not add a new half-step.
- Weights in use: 500, 560 (buttons), 600 (labels, names), 650 (headings and
  emphasis, the most common), 700 (badges and counts), 800. Headings use
  `letter-spacing: -.01em`.
- Numbers that change or align use `font-variant-numeric: tabular-nums`.
- Truncate with `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
  and put the full text in `title`.

## 6. Layout and spacing

- Gaps in use: 4, 5, 6 (most common), 7, 8, 10, 12, 16. Pick from these.
- Radii: 12 (cards, `--radius`), 16 (dialogs), 9 to 10 (buttons, inputs), 8
  (menu items, small chips, tooltip), 999 (pills), 50% (dots).
- Page width: `.page` is the library measure, `.page.narrow` is 760px; the
  review is capped at 1600px (AGENTS.md says why).
- Breakpoints: `max-width: 900px`, `max-width: 720px`, `max-height: 600px`.
  Windows scaling at 125% and 150% lands in them; test small sizes.
- Z-order: viewer 70, menu 70, modal backdrop 80, toast 75 (74 while a dialog
  is open, so it sits under the backdrop), pile ghost 90, splash 200, tooltip
  10000 (always on top). Inside the review: top card 3, next 2, then 1. Do not
  add a layer without updating this list.
- Scrolling happens inside `#view` (thin themed bar), never on the page.
- Never shift layout when something appears: reserve the space or fold it with
  `max-height` (the footer bar and the sorting buttons do).

## 7. Motion

- Easing tokens only (`--ease*`, `--spring`). Springs are for physical movement
  (card throw and return); UI chrome uses `--ease-out` in and `--ease-in` out.
- Durations: 0.1 to 0.16s for hover and press, 0.2 to 0.25s for panels and
  dialogs, about 0.35s for cards. Tooltips 0.12s.
- Animate `opacity`, `translate`, `scale`, `rotate`, `transform`. The card uses
  the individual properties (AGENTS.md, Review view).
- Wrap new continuous or large motion in `prefers-reduced-motion: reduce`.

## 8. Icons

`src/icons.js` holds every icon as an SVG string (stroke style, `currentColor`).
Current set: trash, check, skip, undo, redo, copy, filter, sliders, folder,
refresh, plus, close, shuffle, play, expand, keyboard, help, alert, image, log,
pile. Add new ones there in the same stroke style and 24 viewBox, then call
`icon("name", { size })`. Icons are decorative (`aria-hidden`); the control
carries the `title`/`aria-label`. Icon colour is `--muted` in menus and rows and
`currentColor` in buttons. The app icon is `tools/app-icon.svg` (the `pile` mark).

## 9. Copy and tone

- Sentence case, no trailing full stop on buttons, titles and toasts. Full
  sentences in captions and lead text.
- Say what the thing does, not how: "Mark for deletion", not "Stage".
  ("Staged" survives only in internal names and the count wording.)
- Buttons are verbs ("Keep", "Skip", "Move to Recycle Bin"); name the bin with
  `binName()`. Dialog titles are short statements or questions.
- Dialogs that destroy something say how many and where it goes, and that it is
  recoverable if so.
- Errors: what failed, then the reason if useful. No stack text, no "Oops".
- Prefer a comma or a colon to the em dash in new UI text. A few exist
  (folder tooltip, filmstrip titles, the empty shortcut cell); see Design debt.
- Everything is English only, backend strings included.

## 10. Accessibility floor

- Every interactive element is a real `button`/`a`/`input`, reachable by Tab,
  with the global `:focus-visible` ring (`2px --accent-text`, 2px offset). Do not
  remove outlines; the menu is the one exception and uses a fill instead.
- Icon-only controls: `title` + `aria-label`. Toggles: `aria-pressed`. Dialogs
  trap focus and restore it on close (`modalReturnFocus`).
- Text contrast uses the token pairs (`--text`/`--text-2` on surfaces). `--muted`
  is for captions and meta only, never for the only label of an action.
- Targets: icon buttons at least 32px; keyboard-driven actions never need the
  mouse.
- Motion respects `prefers-reduced-motion`.

## 11. Checklist for a UI change

1. Tokens only; dark value added; no new one-off hex.
2. Existing component and class reused; no near-duplicate created.
3. Title plus aria-label on icon controls; key hints via `hintKey()`.
4. Copy in sentence case, English, bin/file manager via helpers.
5. Dialog flow: Cancel first, no close-then-open flash, safe default focus.
6. Looks right at 900, 720 and 600px high, light and dark.
7. GUI probe and assertion added; counts in AGENTS.md and README updated.
8. If the change shows in a README picture, rerun `npm run screenshots`.
9. Add a line to HANDOFF.md if it is unverified on a real Windows build.

## 12. Design debt (found during the 1.9.0 documentation pass)

Nothing here was changed in this pass (it was documentation only). Do these as
one dedicated pass, with the GUI suite and the screenshots regenerated.

**Bugs found while reading**

1. `src/app.js` (Reset shortcuts): `toast("Shortcuts reset to defaults", { duration: 2000 })`
   passes `duration`, but `toast()` reads `ms`, so it shows for 4.2s, not 2s.
2. `.shortcut-key.conflict` uses `var(--error, #d32f2f)` and `white` with
   `!important`. `--error` is not a token (the fallback always wins), so the
   conflict colour is a stray red that is not `--danger-strong`, and the
   `!important`s hide a specificity fight with `.shortcut-key.waiting`.

**Near-duplicate colours that should be one token**

3. Reds: `--danger` `#b91c1c`, `--danger-strong` `#c92a2a`, `--seg-staged`
   `#dc4646`, `--seg-deleted` `#b91c1c`, the stamp and `.btn.danger` border red
   `#dc2626` / `rgba(220,38,38,.28|.3|.35)`, solid hover `#b32424`, conflict
   `#d32f2f`, dark `#d23c3c`, `#ff8a8a` (missing-file text) next to `--danger`
   dark `#ff8080`. At least three of these are meant to be the same red.
   Proposal: `--danger`, `--danger-strong`, `--danger-hover`, and
   `--danger-line` (the border tint), with the stamps and the missing text using
   them (dark `#ff8a8a` becomes `--danger`).
4. Greens and ambers repeat as literals: `#15803d` is `--ok`, but the stamps and
   `rgba(21,128,61,.3|.32)` borders restate it; the skip stamp `#c2620c` is
   close to `--warn` `#b45309` and `--seg-skipped` `#d98c2b`. Proposal: stamps
   read `--ok` / `--danger-strong` / `--warn`; add `--ok-line` and `--warn-line`
   border tints.
5. The button borders for danger/ok/skip use three slightly different alphas
   (`.28`, `.3`, `.32`, `.35`) for the same idea; the `.act-*` and `.pile-btn`
   rules repeat what `.btn.danger` / `.btn.ok` already do.
6. The viewer and log view hard-code a second dark palette (`#0f141b`,
   `#232b36`, `#1a2230`, `#2c3748`, `#232f42`, `#3a475c`, `#9aa7b8`, `#d7e0ea`,
   `rgba(20,26,35,.96)`) that sits next to, but is not, the dark theme tokens
   (`--surface #151b25`, `--line #253041`, `--surface-3 #212a37`). Proposal: a
   small `--viewer-*` token group, or reuse the dark theme values.
7. Info-bar scrim colours `rgba(248,250,252,…)` and `rgba(12,16,23,…)` are the
   `--letterbox` and `--bg` colours restated; `app.js` also restates `--bg` as
   `#0c1017` / `#eef1f6` for `set_window_background` (documented, but a third
   copy).
8. The brand gradient `linear-gradient(160deg, #3b82f6, #1d4ed8)` appears twice
   (brand mark and onboarding mark); `#1d4ed8` is also `--accent` light.

**Near-duplicate components that should share a class**

9. Pill/chip shapes: `.badge`, `.folder-chip`, `.tally-chip`, `.done-tag`,
   `.btn-count`, `.fin-badge` all re-declare a 999px pill with slightly
   different padding (`0 6px`, `1px 7px`, …) and font size (11 to 12.5px).
   One `.pill` base with tone modifiers would cover them.
10. Card surfaces: `.month`, `.tile-photo`, `.legend-card`, `.overview` and the
    Options groups each restate border + radius + shadow with radii of 10, 12 or
    14. One `.surface-card` (12px, `--line`, `--shadow`) would do.
11. Radii outside the scale: 2, 3, 4, 5, 6, 7, 9, 11, 14, 18, 20. The scale in
    section 6 is 8 / 9-10 / 12 / 16 / 999; 7, 9, 11 and 14 are single-purpose
    near-misses (`.btn` is 9, `.btn.lg` and `.segmented` are 10, menus 12).
12. Font sizes: 9.5, 11.5, 12.5 sit half a pixel from 12 and 13, and weights
    560, 620, 650, 750 are close neighbours of 600 and 700. Collapse to
    11 / 12 / 13 / 14 and 500 / 600 / 700 when a pass can verify the layout.
13. Transitions are written inline 25 different ways (`.12s`, `.15s`, `.16s`,
    `.2s ease`, …). Add `--t-fast` (.12s), `--t-base` (.2s) and use them.
14. Segmented control, view toggles and `.pile-btn.is-active` express
    "selected" three ways (`aria-pressed` fill, `.is-active` class, `.checked`
    in menus). Pick `aria-pressed` plus one visual.
15. Spacing is raw px everywhere (gaps 4, 5, 6, 7, 8, 10, 12, 16). A 4px-based
    scale (`--space-1..5`) would stop 5/6/7 drift.
16. Icon sizes: modal buttons use 16, `icon()` defaults to 18, some call sites
    pass 14, 15 or 20. Settle on 16 inline and 18 standalone.

**Behaviour inconsistencies**

17. Hand-typed key names remain, against the one-source rule: Undo/Redo
    titles in `index.html` ("Ctrl+Z", "Ctrl+Y"), the app-menu items' `meta`
    ("Ctrl+Z", "Ctrl+Y", "Ctrl+,"), the Options app-zoom titles ("Ctrl and −",
    "Ctrl and +", "Ctrl and 0"), the Options button title "Options (Ctrl+,)" and
    the log hint "Ctrl+Shift+L ... F12". They are all fixed shortcuts, so they
    should come from `FIXED_SHORTCUTS`/`keyLabel()`. The app zoom titles also
    spell the chord "Ctrl and −" while the rest say "Ctrl+Z"; use "+".
18. Some toasts end with a full stop or use "Couldn't" vs "Could not" (see
    `Could not switch fullscreen` and `Couldn't copy the image`). Pick
    "Couldn't" and no full stop.
19. `.menu` and `.viewer` share `z-index: 70`, below the modal backdrop (80): a
    menu opened from inside a dialog would sit under it. No current flow does
    this; keep it that way or raise the menu.
20. The Options "Settings" rows mix `h("small")` captions (`.opt-label small`)
    with `.muted` paragraphs for the same kind of help text.
