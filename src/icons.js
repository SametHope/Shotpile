/**
 * The app's icon set: 24x24 outline glyphs drawn for this app, one stroke
 * weight throughout. Pure strings, so this module has no DOM dependency;
 * `dom.js` turns them into elements.
 *
 * `sieve` is the brand mark and mirrors the app icon (three narrowing bars with
 * the kept "grains" falling through), so the window chrome and the taskbar
 * icon read as the same thing.
 */

const P = {
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/><path d="M10.2 11v6M13.8 11v6"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  skip: '<path d="M12 20V8.5"/><path d="M6.8 13.2L12 8l5.2 5.2"/><path d="M5.5 4h13"/>',
  undo: '<path d="M8.5 14.5L4 10l4.5-4.5"/><path d="M4 10h10a5.5 5.5 0 0 1 0 11h-3"/>',
  folder:
    '<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.9l2 2.1h7.7a1.7 1.7 0 0 1 1.7 1.7v8.5a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/>',
  "folder-plus":
    '<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.9l2 2.1h7.7a1.7 1.7 0 0 1 1.7 1.7v8.5a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/><path d="M12 11v5M9.5 13.5h5"/>',
  "chevron-down": '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  "chevron-left": '<path d="M14.5 6l-6 6 6 6"/>',
  "chevron-right": '<path d="M9.5 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.8h-4.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  "zoom-in": '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M10.5 8v5M8 10.5h5"/>',
  "zoom-out": '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M8 10.5h5"/>',
  shuffle:
    '<path d="M3.5 7.5H7c1.8 0 2.8.8 3.7 2.4l2.6 4.6c.9 1.6 1.9 2.4 3.7 2.4h3.5"/><path d="M3.5 16.9H7c1.2 0 2-.3 2.7-1"/><path d="M14.3 8.5c.7-.7 1.5-1 2.7-1h3.5"/><path d="M18 4.8l2.6 2.7L18 10.2"/><path d="M18 14.2l2.6 2.7L18 19.6"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z"/>',
  expand: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
  keyboard:
    '<rect x="3" y="6" width="18" height="12" rx="2.2"/><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7.5 14h9"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 0 1 4.7.7c0 1.6-2.4 2-2.4 3.6"/><path d="M12 16.9h.01"/>',
  alert: '<path d="M12 4.2l8.6 15H3.4z"/><path d="M12 10v4.2M12 16.8h.01"/>',
  "check-circle": '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.4l2.6 2.6 5-5.2"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="9.8" r="1.6"/><path d="M20.5 15.8l-4.8-4.8-8.6 8.5"/>',
  log: '<path d="M7 4.5h7.5L18 8v11.5H7z"/><path d="M14 4.5V8h4"/><path d="M9.8 12h5M9.8 15.2h5"/>',
  sieve:
    '<path d="M4.2 6.2h15.6M6.8 10.5h10.4M9.4 14.8h5.2"/><circle cx="9.3" cy="19.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="19.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.7" cy="19.2" r="1.1" fill="currentColor" stroke="none"/>',
};

export const ICON_NAMES = Object.keys(P);

/** Full `<svg>` markup for `name`; unknown names render an empty glyph. */
export function iconSvg(name, size = 18) {
  const body = P[name] || "";
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}
