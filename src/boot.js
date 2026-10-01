/**
 * Runs before the first paint: a classic script in <head>, not a module, so it
 * blocks rendering just long enough to set the theme. The page therefore never
 * flashes the wrong colours, and the splash in index.html shows at once.
 *
 * It owns the user's preferences (theme, zoom), kept in localStorage, which
 * the WebView persists next to the app's data. app.js reads and changes them
 * through `window.shotpilePrefs`.
 */
(function () {
  "use strict";
  var KEY = "shotpile.prefs";
  var THEMES = ["system", "light", "dark"];
  var prefs = { theme: "system", zoom: 1, showDone: false };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (THEMES.indexOf(saved.theme) !== -1) prefs.theme = saved.theme;
    if (typeof saved.zoom === "number" && saved.zoom >= 0.5 && saved.zoom <= 2) prefs.zoom = saved.zoom;
    if (typeof saved.showDone === "boolean") prefs.showDone = saved.showDone;
    if (typeof saved.keyBindings === "object" && saved.keyBindings !== null) prefs.keyBindings = saved.keyBindings;
  } catch (e) {
    // Storage can be unavailable or hold junk; the defaults stand.
  }

  var media = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    var dark = prefs.theme === "dark" || (prefs.theme === "system" && media.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }
  media.addEventListener("change", applyTheme);
  applyTheme();

  window.shotpilePrefs = {
    THEMES: THEMES,
    get: function () {
      var result = { theme: prefs.theme, zoom: prefs.zoom, showDone: prefs.showDone };
      if (prefs.keyBindings) result.keyBindings = prefs.keyBindings;
      return result;
    },
    set: function (patch) {
      if (patch.theme !== undefined && THEMES.indexOf(patch.theme) !== -1) prefs.theme = patch.theme;
      if (typeof patch.zoom === "number") prefs.zoom = Math.min(2, Math.max(0.5, Math.round(patch.zoom * 100) / 100));
      if (typeof patch.showDone === "boolean") prefs.showDone = patch.showDone;
      if (patch.keyBindings !== undefined) {
        if (patch.keyBindings === null || (typeof patch.keyBindings === "object" && Object.keys(patch.keyBindings).length === 0)) {
          delete prefs.keyBindings;
        } else if (typeof patch.keyBindings === "object") {
          prefs.keyBindings = patch.keyBindings;
        }
      }
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch (e) {
        // Not saved, but still applied for this session.
      }
      applyTheme();
      return this.get();
    },
  };
})();
