// Cross-file consistency checks. Each test reads the real source and compares
// two places that must agree, so nothing here is a copied constant: when the
// source changes, the expectation follows it. They exist because of bugs that
// type-checked and passed the GUI suite: a toast option named `duration` that
// the toast never read, and a `var(--error)` token that was never defined.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACTIONS,
  DEFAULT_KEYS,
  FIXED_SHORTCUTS,
  fixedKey,
  keyLabel,
  shortcutHelp,
  getKeyBindings,
} from "../src/logic.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(root, f), "utf8");
const css = read("style.css");
const app = read("app.js");
const dom = read("dom.js");
const html = read("index.html");

/** The body of `:root { ... }` / `:root[data-theme="dark"] { ... }` (first block). */
function block(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} block exists`);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
}

const declared = (body) => new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

test("every var(--token) used in the CSS is declared somewhere", () => {
  // Properties app.js sets itself in an inline style (`--i:${i}`) count as declared.
  const known = new Set([...declared(css), ...declared(app)]);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((t) => !known.has(t));
  assert.deepEqual(missing, [], `undeclared tokens: ${missing.join(", ")}`);
});

test("var(--token, fallback) never hides an undeclared token", () => {
  const known = declared(css);
  const withFallback = [...css.matchAll(/var\((--[a-z0-9-]+)\s*,/g)].map((m) => m[1]);
  const hidden = withFallback.filter((t) => !known.has(t));
  assert.deepEqual(hidden, [], `fallback masks undeclared token: ${hidden.join(", ")}`);
});

test("inline styles in app.js only use declared tokens", () => {
  const known = declared(css);
  const used = new Set([...app.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((t) => !known.has(t));
  assert.deepEqual(missing, [], `undeclared tokens in app.js: ${missing.join(", ")}`);
});

test("every colour token has a dark value, except the ones that are theme-neutral", () => {
  const light = declared(block(":root {"));
  const dark = declared(block(':root[data-theme="dark"]'));
  // Shared on purpose: sizes, easing, fonts, and the on-accent text colour.
  const neutral = /^--(radius|ease|ease-out|ease-in|spring|font|font-display|font-mono|on-accent)$/;
  // Line tints are the same translucent colour on both themes.
  const sameBoth = /^--(danger|ok|warn)-line$/;
  const lacking = [...light].filter((t) => !dark.has(t) && !neutral.test(t) && !sameBoth.test(t));
  assert.deepEqual(lacking, [], `no dark value: ${lacking.join(", ")}`);
});

test("dark tokens do not invent names the light theme lacks", () => {
  const light = declared(block(":root {"));
  const dark = declared(block(':root[data-theme="dark"]'));
  assert.deepEqual([...dark].filter((t) => !light.has(t)), []);
});

test("toast() calls only pass options that toast() reads", () => {
  const sig = dom.match(/export function toast\(message, \{([^}]*)\}/);
  assert.ok(sig, "toast signature found");
  const accepted = new Set([...sig[1].matchAll(/([A-Za-z]+)\s*(?:=|,|$)/g)].map((m) => m[1]));
  assert.ok(accepted.has("ms") && accepted.has("tone"), "signature parsed");
  const bad = [];
  for (const call of app.matchAll(/toast\((?:`[^`]*`|"[^"]*"|[^,)]+)\s*,\s*\{([^}]*)\}\s*\)/g)) {
    for (const key of call[1].matchAll(/([A-Za-z]+)\s*:/g)) {
      if (!accepted.has(key[1])) bad.push(key[1]);
    }
  }
  assert.deepEqual(bad, [], `unknown toast option(s): ${bad.join(", ")}`);
});

test("every ACTIONS.X the app reads exists", () => {
  const used = new Set([...app.matchAll(/ACTIONS\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 5, "found the ACTIONS references");
  const missing = [...used].filter((k) => !(k in ACTIONS));
  assert.deepEqual(missing, []);
});

test("every fixedKey(id) and hintKey(id) in app.js resolves", () => {
  const fixedIds = new Set([...app.matchAll(/fixedKey\("([A-Za-z]+)"\)/g)].map((m) => m[1]));
  assert.ok(fixedIds.size > 0);
  for (const id of fixedIds) assert.notEqual(fixedKey(id), "", `fixedKey("${id}") is empty`);
  const actionIds = new Set(Object.values(ACTIONS).map((a) => a.id));
  // hintKey takes an action id: either a literal or ACTIONS.X.id (checked above).
  const hintIds = new Set([...app.matchAll(/hintKey\("([A-Za-z]+)"\)/g)].map((m) => m[1]));
  const unknown = [...hintIds].filter((id) => !actionIds.has(id));
  assert.deepEqual(unknown, [], `hintKey with no such action: ${unknown.join(", ")}`);
});

test("shortcut tables are internally consistent", () => {
  const ids = Object.values(ACTIONS).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "action ids are unique");
  for (const [key, id] of Object.entries(DEFAULT_KEYS)) {
    assert.ok(ids.includes(id), `default key ${key} -> unknown action ${id}`);
  }
  // The Options rebind list can only offer an action that has a default key
  // or is documented as unbound (Options itself is a modifier chord).
  for (const a of Object.values(ACTIONS)) {
    const bound = Object.values(DEFAULT_KEYS).includes(a.id);
    assert.ok(bound || a.id === ACTIONS.OPEN_OPTIONS.id, `${a.id} has no default key`);
  }
  const fixedIds = FIXED_SHORTCUTS.map((f) => f.id).filter(Boolean);
  assert.equal(new Set(fixedIds).size, fixedIds.length, "fixed shortcut ids are unique");
  for (const f of FIXED_SHORTCUTS) {
    assert.ok(f.chords.length > 0 && f.chords.every((c) => c.length > 0), `${f.what} has chords`);
    assert.ok(f.what.trim() && !/[.]$/.test(f.what), `${f.what}: sentence case, no full stop`);
  }
});

test("the help sheet lists every action and every fixed shortcut exactly once", () => {
  const help = shortcutHelp(getKeyBindings({ get: () => ({}) }));
  const rows = help.flatMap((g) => g.rows);
  for (const a of Object.values(ACTIONS)) {
    assert.equal(rows.filter((r) => r.id === a.id).length, 1, `${a.id} appears once`);
  }
  const fixedRows = rows.filter((r) => !r.id).length;
  assert.equal(fixedRows, FIXED_SHORTCUTS.length);
  const groups = new Set([...Object.values(ACTIONS).map((a) => a.group), ...FIXED_SHORTCUTS.map((f) => f.group)]);
  assert.deepEqual(new Set(help.map((g) => g.title)), groups, "no action or fixed shortcut falls outside a help group");
});

test("a default key and a fixed shortcut never claim the same plain key", () => {
  // Plain (unmodified) fixed chords: a rebind to one of them would be swallowed.
  const plainFixed = new Set(FIXED_SHORTCUTS.filter((f) => f.chords.some((c) => c.length === 1))
    .flatMap((f) => f.chords.filter((c) => c.length === 1).map((c) => c[0])));
  for (const [key, id] of Object.entries(DEFAULT_KEYS)) {
    const label = keyLabel(key);
    if (!plainFixed.has(label)) continue;
    // Allowed only when the fixed meaning is context-dependent (arrows pan a
    // zoomed card, Escape closes things); the help names both.
    assert.ok(["delete", "keep", "skip", "prevImage", "nextImage", "zoomOut"].includes(id) || label === "Esc",
      `${label} is both a fixed shortcut and the default for ${id}`);
  }
});

test("keyLabel is total and never returns an empty label", () => {
  const keys = [...Object.keys(DEFAULT_KEYS), " ", "Enter", "Escape", "a", "Z", "F5", "ArrowDown", ","];
  for (const k of keys) {
    const l = keyLabel(k);
    assert.equal(typeof l, "string");
    assert.ok(l.length > 0, `keyLabel(${JSON.stringify(k)}) is empty`);
  }
  assert.equal(keyLabel("a"), keyLabel("A"), "letters label the same in either case");
});

test("every icon-only control in index.html has a title and an aria-label", () => {
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  const iconOnly = buttons.filter((b) => /class="[^"]*\bicon\b/.test(b));
  assert.ok(iconOnly.length > 0);
  for (const b of iconOnly) {
    assert.match(b, /\btitle="[^"]+"/, `no title: ${b.slice(0, 80)}`);
    assert.match(b, /\baria-label="[^"]+"/, `no aria-label: ${b.slice(0, 80)}`);
  }
});

test("every .btn.icon built in app.js carries a title and an aria-label", () => {
  const bad = [];
  for (const m of app.matchAll(/h\("button",\s*\{([^}]*class:\s*"[^"]*\bicon\b[^}]*)\}/g)) {
    if (!/\btitle\b/.test(m[1]) || !/aria-label/.test(m[1])) bad.push(m[1].slice(0, 70));
  }
  assert.deepEqual(bad, []);
});

test("UI text keeps the bin and file manager names behind the helpers", () => {
  // Strings in app.js and index.html must not hard-code the OS-specific names.
  const literal = /["'`][^"'`\n]*\b(Recycle Bin|File Explorer)\b[^"'`\n]*["'`]/;
  // The two helpers are where the fallback names legitimately live.
  const defines = /^\s*(\/\*\*|\/\/|\*|const (binName|fileManager) =)/;
  const offenders = [...app.split("\n"), ...html.split("\n")].filter((l) => literal.test(l) && !defines.test(l));
  assert.deepEqual(offenders.map((l) => l.trim().slice(0, 80)), []);
});
