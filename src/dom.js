/**
 * DOM primitives shared by the views: element builder, icons, toast, modal,
 * confirm dialog and the popover menu.
 *
 * Kept apart from app.js so the views read as views. Everything here is
 * stateless apart from the one modal, toast and menu the page owns.
 */

import { iconSvg } from "./icons.js";

/** Builds an element: `h("button", { class, onclick, text, html, dataset }, ...children)`. */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** An inline icon from icons.js, wrapped so it sizes and aligns like text. */
export function icon(name, { size = 18, cls = "" } = {}) {
  return h("span", { class: `ico${cls ? ` ${cls}` : ""}`, html: iconSvg(name, size), "aria-hidden": "true" });
}

export function kbd(text) {
  return h("kbd", { text });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Replays a one-shot CSS animation class on `node` (a counter bump, a button
 * flash). Removing and re-adding the class in the same frame does not restart
 * an animation, so a reflow sits in between.
 */
export function replay(node, cls, ms = 400) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  clearTimeout(node[`__${cls}`]);
  node[`__${cls}`] = setTimeout(() => node.classList.remove(cls), ms);
}

// ---------------------------------------------------------------------- toast

const toastEl = () => document.getElementById("toast");
let toastTimer = null;

/**
 * Shows the single toast. A new toast replaces the current one, so callers that
 * have several things to say must say them in one message (see the commit
 * report), or the earlier ones are never seen.
 */
export function toast(message, { action, onAction, ms = 4200, tone = "" } = {}) {
  const node = toastEl();
  if (!node) return;
  const msg = node.querySelector(".msg");
  const btn = node.querySelector("button");
  msg.textContent = message;
  node.dataset.tone = tone;
  clearTimeout(toastTimer);
  if (action) {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => {
      hideToast();
      onAction?.();
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  node.classList.add("on");
  toastTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  toastEl()?.classList.remove("on");
  clearTimeout(toastTimer);
}

// ---------------------------------------------------------------------- modal

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

let modalCancel = null;
let modalReturnFocus = null;

function modalParts() {
  const backdrop = document.getElementById("modal");
  return {
    backdrop,
    box: backdrop?.querySelector(".modal"),
    title: document.getElementById("modal-title"),
    body: document.getElementById("modal-body"),
    foot: document.getElementById("modal-foot"),
  };
}

export function modalOpen() {
  const { backdrop } = modalParts();
  return !!backdrop && !backdrop.hidden;
}

/**
 * Opens the page's one dialog.
 *
 * Every way out goes through `onCancel` (Escape, a backdrop click) or a button,
 * and all of them close the dialog. Focus starts on the first footer button,
 * which for a confirm is Cancel, so Enter on a destructive dialog activates the
 * safe option; Tab is kept inside the dialog; focus returns to where it came
 * from on close.
 */
export function modal({ title, body, actions, wide = false, onCancel = null, cls = "" }) {
  const p = modalParts();
  if (!modalOpen()) modalReturnFocus = document.activeElement;
  // The toast sits above the backdrop, so its action (Undo, Details) would
  // stay clickable behind a dialog: an Undo there re-staged a file between
  // the delete confirmation's preview and its commit.
  hideToast();
  p.title.textContent = title;
  p.body.replaceChildren(...[body].flat(Infinity).filter(Boolean));
  p.foot.replaceChildren(
    ...actions.map((a) =>
      h("button", {
        class: `btn ${a.variant || ""}`.trim(),
        onclick: () => {
          closeModal();
          a.onClick?.();
        },
      }, a.icon ? icon(a.icon, { size: 16 }) : null, a.label)
    )
  );
  p.box.className = `modal${wide ? " wide" : ""}${cls ? ` ${cls}` : ""}`;
  modalCancel = onCancel;
  p.backdrop.hidden = false;
  p.foot.querySelector("button")?.focus();
}

export function closeModal() {
  const p = modalParts();
  if (!p.backdrop || p.backdrop.hidden) return;
  p.backdrop.hidden = true;
  modalCancel = null;
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && back.isConnected && typeof back.focus === "function") back.focus();
}

function cancelModal() {
  const cancel = modalCancel;
  closeModal();
  cancel?.();
}

/** Wires the dialog's Escape, Tab trap and backdrop click. Call once at boot. */
export function initModal() {
  const p = modalParts();
  p.backdrop.addEventListener("click", (e) => {
    if (e.target === p.backdrop) cancelModal();
  });
  // Capture phase, so the dialog owns these keys before the review shortcuts.
  document.addEventListener("keydown", (e) => {
    if (!modalOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelModal();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...p.box.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!p.box.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, true);
}

/**
 * Yes/no dialog. Resolves true only from the confirm button; Escape, Enter on
 * the focused Cancel, a backdrop click and Cancel all resolve false.
 */
export function confirmDialog({ title, message, confirmLabel, variant = "danger", body, wide, confirmIcon }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    modal({
      title,
      body: [message ? h("p", { class: "modal-lead", text: message }) : null, body].filter(Boolean),
      wide,
      onCancel: () => done(false),
      actions: [
        { label: "Cancel", onClick: () => done(false) },
        { label: confirmLabel, variant, icon: confirmIcon, onClick: () => done(true) },
      ],
    });
  });
}

// ----------------------------------------------------------------------- menu

let menuState = null;

export function menuOpen() {
  return !!menuState;
}

/**
 * A small popover menu under `anchor`. Items: `{ label, sub, icon, onClick,
 * checked, danger }`, or `{ separator: true }`. Closes on an item, Escape, a
 * click elsewhere, or the window losing focus. With `at` ({ x, y }) it opens
 * at that point instead, as a context menu; `anchor` may then be null.
 */
export function openMenu(anchor, items, { align = "start", at = null } = {}) {
  closeMenu();
  const list = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.separator) {
      list.append(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    list.append(h("button", {
      class: `menu-item${item.danger ? " danger" : ""}${item.checked ? " checked" : ""}`,
      role: "menuitem",
      title: item.title || null,
      onclick: () => {
        closeMenu();
        item.onClick?.();
      },
    },
      icon(item.icon || (item.checked ? "check" : "folder"), { size: 16 }),
      h("span", { class: "menu-text" },
        h("span", { class: "menu-label", text: item.label }),
        item.sub ? h("span", { class: "menu-sub", text: item.sub }) : null),
      item.meta ? h("span", { class: "menu-meta", text: item.meta }) : null
    ));
  }
  document.body.append(list);
  const w = list.offsetWidth;
  const hgt = list.offsetHeight;
  let left;
  let top;
  if (at) {
    left = at.x;
    // Flip above the pointer when there is no room below it.
    top = at.y + hgt + 8 > window.innerHeight ? at.y - hgt : at.y;
  } else {
    const r = anchor.getBoundingClientRect();
    left = align === "end" ? r.right - w : r.left;
    top = r.bottom + 6;
  }
  list.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  list.style.top = `${Math.max(8, Math.min(top, window.innerHeight - hgt - 8))}px`;
  anchor?.setAttribute("aria-expanded", "true");

  const onDown = (e) => {
    if (!list.contains(e.target) && !anchor?.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    // Tabbing away leaves the menu behind, so it closes and lets focus move on.
    if (e.key === "Tab") {
      closeMenu();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      anchor?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const buttons = [...list.querySelectorAll(".menu-item")];
      const at = buttons.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  menuState = { list, anchor, onDown, onKey };
  list.querySelector(".menu-item")?.focus();
}

export function closeMenu() {
  if (!menuState) return;
  const { list, anchor, onDown, onKey } = menuState;
  menuState = null;
  document.removeEventListener("pointerdown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
  anchor?.setAttribute("aria-expanded", "false");
  list.remove();
}
