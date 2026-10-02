// The Tauri command surface is defined twice: the Rust `generate_handler!` list
// in `src-tauri/src/lib.rs` and the `api("name")` calls in `src/`. The fake
// backend in `tests/fake-backend.js` implements commands whether or not they
// are registered, so a missing registration is invisible to the GUI suite and
// only shows up at runtime as `Command <name> not found`. This test compares the
// two lists directly. It is the check HANDOFF.md asks for after `incr_counter`
// shipped unregistered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Command names in the `tauri::generate_handler![...]` list. */
function registeredCommands() {
  const lib = readFileSync(join(repo, "src-tauri", "src", "lib.rs"), "utf8");
  const block = lib.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  assert.ok(block, "no generate_handler![...] block found in src-tauri/src/lib.rs");
  return new Set([...block[1].matchAll(/commands::([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
}

/**
 * Command names the frontend passes to `api("...")` or a raw `invoke("...")`.
 * Only literal strings count; every call site uses one.
 */
function frontendCommands() {
  const dir = join(repo, "src");
  const names = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/\b(?:api|invoke)\(\s*"([a-z_][a-z0-9_]*)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

test("every command the frontend invokes is registered in lib.rs", () => {
  const registered = registeredCommands();
  const missing = [...frontendCommands()].filter((c) => !registered.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `frontend calls these commands but lib.rs never registers them (add commands::<name> to generate_handler!): ${missing.join(", ")}`,
  );
});

// Guards the test itself: a typo in the regexes would silently pass forever.
test("the command lists are found and non-trivial", () => {
  const registered = registeredCommands();
  const called = frontendCommands();
  assert.ok(registered.size > 20, `expected many registered commands, found ${registered.size}`);
  assert.ok(called.size > 15, `expected many invoked commands, found ${called.size}`);
  assert.ok(
    [...called].every((c) => /^[a-z_][a-z0-9_]*$/.test(c)),
    "an invoked command name did not match the expected shape",
  );
});
