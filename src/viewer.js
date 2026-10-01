/**
 * Full-screen photo viewer: wheel zoom around the cursor, drag to pan,
 * double-click to toggle 1x/2x, keyboard pan and zoom.
 *
 * Created on demand and removed on close, so it needs no markup in index.html.
 * While open it owns the keyboard (see `viewerKeydown`).
 */

import { anchorZoom, clampScale, containedSize, formatBytes, formatDateTime, panLimit, wheelZoomFactor } from "./logic.js";
import { h, icon } from "./dom.js";
import { log } from "./log.js";

const PAN_STEP = 60;

const v = { el: null, img: null, frame: null, label: null, dims: null, scale: 1, x: 0, y: 0, drag: null, onClose: null, returnFocus: null };

export function viewerOpen() {
  return !!v.el;
}

/**
 * Opens `shot`. `inherit` carries a zoom from the card as `{ scale, fx, fy }`,
 * where fx/fy are the pan as a fraction of the card's photo size; the card and
 * the viewer frames differ in size, so raw pixels would land somewhere else.
 */
export function openViewer(shot, { src, inherit = null, onClose = null } = {}) {
  if (!shot?.viewable || !src) return;
  closeViewer();

  const img = h("img", { src, alt: shot.name, draggable: "false" });
  const frame = h("div", { class: "viewer-frame" }, img);
  const label = h("span", { class: "viewer-zoom", text: "100%" });
  const dims = h("span", { class: "viewer-dims" });

  const overlay = h("div", { class: "viewer", id: "viewer", role: "dialog", "aria-label": `Viewing ${shot.name}` },
    frame,
    h("div", { class: "viewer-bar" },
      h("div", { class: "viewer-info" },
        h("span", { class: "viewer-name", text: shot.name, title: shot.path }),
        h("span", { class: "viewer-meta" },
          h("span", { text: formatDateTime(shot.taken_ms) }),
          h("span", { text: formatBytes(shot.size) }),
          dims)),
      h("div", { class: "viewer-tools" },
        h("button", { class: "btn sm icon", title: "Zoom out (-)", "aria-label": "Zoom out", onclick: () => zoomBy(1 / 1.25) }, icon("zoom-out", { size: 16 })),
        label,
        h("button", { class: "btn sm icon", title: "Zoom in (+)", "aria-label": "Zoom in", onclick: () => zoomBy(1.25) }, icon("zoom-in", { size: 16 })),
        h("button", { class: "btn sm", title: "Fit to window (0)", onclick: resetZoom }, "Fit"),
        h("button", { class: "btn sm", title: "Close (Esc)", onclick: closeViewer }, icon("close", { size: 16 }), "Close"))
    )
  );

  Object.assign(v, { el: overlay, img, frame, label, dims, scale: 1, x: 0, y: 0, drag: null, onClose, returnFocus: document.activeElement });
  document.body.append(overlay);
  // The app behind goes inert while the viewer is up: with focus left on, say,
  // the Keep button, Enter would otherwise decide the card behind the photo.
  document.getElementById("app")?.setAttribute("inert", "");
  overlay.querySelector(".viewer-tools .btn:last-child")?.focus();

  const applyInherited = () => {
    dims.textContent = img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : "";
    if (!inherit || inherit.scale <= 1.001) return;
    const c = content();
    v.scale = inherit.scale;
    v.x = (inherit.fx || 0) * c.w;
    v.y = (inherit.fy || 0) * c.h;
    clampPan();
    apply();
  };
  if (img.complete && img.naturalWidth) applyInherited();
  else img.addEventListener("load", applyInherited, { once: true });

  overlay.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX, e.clientY);
  }, { passive: false });

  // WKWebView reports a touchpad pinch as gesture events, not ctrl+wheel.
  let pinchBase = 1;
  overlay.addEventListener("gesturestart", (e) => { e.preventDefault(); pinchBase = v.scale; });
  overlay.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    zoomBy((pinchBase * e.scale) / v.scale, e.clientX, e.clientY);
  });

  frame.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    v.drag = { id: e.pointerId, px: e.clientX, py: e.clientY, ox: v.x, oy: v.y };
    frame.classList.add("panning");
    try { frame.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  });
  frame.addEventListener("pointermove", (e) => {
    if (!v.drag || v.drag.id !== e.pointerId) return;
    v.x = v.drag.ox + (e.clientX - v.drag.px);
    v.y = v.drag.oy + (e.clientY - v.drag.py);
    clampPan();
    apply();
  });
  const endDrag = () => {
    v.drag = null;
    frame.classList.remove("panning");
  };
  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);

  frame.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (v.scale > 1) resetZoom();
    else zoomBy(2, e.clientX, e.clientY);
  });

  apply();
  log.info("viewer", shot.name);
}

export function closeViewer() {
  if (!v.el) return;
  const onClose = v.onClose;
  const back = v.returnFocus;
  v.el.remove();
  document.getElementById("app")?.removeAttribute("inert");
  Object.assign(v, { el: null, img: null, frame: null, label: null, dims: null, drag: null, scale: 1, x: 0, y: 0, onClose: null, returnFocus: null });
  if (back && back.isConnected && typeof back.focus === "function") back.focus();
  onClose?.();
}

/** Keyboard while the viewer is open. Returns true when the key was handled. */
export function viewerKeydown(e) {
  if (!v.el) return false;
  const pan = (dx, dy) => {
    v.x += dx;
    v.y += dy;
    clampPan();
    apply();
  };
  switch (e.key) {
    case "Escape":
    case " ":
    case "Enter":
      closeViewer();
      break;
    case "ArrowLeft": pan(PAN_STEP, 0); break;
    case "ArrowRight": pan(-PAN_STEP, 0); break;
    case "ArrowUp": pan(0, PAN_STEP); break;
    case "ArrowDown": pan(0, -PAN_STEP); break;
    case "+": case "=": zoomBy(1.25); break;
    case "-": case "_": zoomBy(1 / 1.25); break;
    case "0": resetZoom(); break;
    default: return false;
  }
  e.preventDefault();
  return true;
}

function content() {
  const r = v.frame.getBoundingClientRect();
  return { ...containedSize(v.img.naturalWidth, v.img.naturalHeight, r.width, r.height), frameW: r.width, frameH: r.height };
}

function clampPan() {
  if (v.scale <= 1.001) {
    v.x = 0;
    v.y = 0;
    return;
  }
  const c = content();
  const mx = panLimit(c.w, c.frameW, v.scale);
  const my = panLimit(c.h, c.frameH, v.scale);
  v.x = Math.min(mx, Math.max(-mx, v.x));
  v.y = Math.min(my, Math.max(-my, v.y));
}

function apply() {
  if (!v.img) return;
  v.img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  v.frame.classList.toggle("zoomed", v.scale > 1.001);
  if (v.label) v.label.textContent = `${Math.round(v.scale * 100)}%`;
}

/**
 * Zooms by `factor`, keeping the point under (cx, cy) fixed. Without a cursor
 * position it zooms about the frame centre, which is what the buttons and the
 * keyboard want.
 */
function zoomBy(factor, cx = null, cy = null) {
  if (!v.frame) return;
  const next = clampScale(v.scale, factor);
  if (next === v.scale) return;
  const r = v.frame.getBoundingClientRect();
  const ox = r.left + r.width / 2;
  const oy = r.top + r.height / 2;
  const pos = anchorZoom((cx ?? ox) - ox, (cy ?? oy) - oy, v.x, v.y, next, v.scale);
  v.x = pos.x;
  v.y = pos.y;
  v.scale = next;
  clampPan();
  apply();
}

function resetZoom() {
  v.scale = 1;
  v.x = 0;
  v.y = 0;
  apply();
}
