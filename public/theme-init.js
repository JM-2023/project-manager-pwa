// Apply a pinned theme before first paint to avoid a flash of the wrong
// theme. "system" (or unset) falls through to prefers-color-scheme. Same for
// the UI language ("en" is the default; i18n.tsx re-applies after hydration).
// Lives as an external file (not inline) so the CSP can stay 'self'-only.
(function () {
  try {
    // Browser-chrome colors per ground × scheme; keep in sync with
    // src/lib/chromeColor.ts and the --bg tokens in app.css.
    var COLORS = {
      default: { light: "#f5f3ee", dark: "#131211" },
      gray: { light: "#eef0f3", dark: "#17181a" },
      prussian: { light: "#f6f0e7", dark: "#0e1720" }
    };

    // Ground colour: Prussian unless another ground is pinned ("default" is
    // the bone paper, which carries no attribute). Applied pre-paint so the
    // ground never flashes a different one first.
    var storedBg = localStorage.getItem("pm:bg");
    var bg = storedBg && COLORS.hasOwnProperty(storedBg) ? storedBg : "prussian";
    if (bg !== "default") {
      document.documentElement.setAttribute("data-bg", bg);
    }

    var t = localStorage.getItem("pm:theme");
    var pinned = t === "light" || t === "dark";
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    }
    // A pinned theme overrides both media-scoped metas; any other ground
    // retints each meta within its own scheme. (The static HTML already
    // carries the Prussian ground's colors.)
    if (pinned || bg !== "prussian") {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i += 1) {
        var scheme = pinned ? t : ((metas[i].getAttribute("media") || "").indexOf("dark") >= 0 ? "dark" : "light");
        metas[i].setAttribute("content", COLORS[bg][scheme]);
      }
    }
    if (localStorage.getItem("pm:lang") === "zh") {
      document.documentElement.lang = "zh-CN";
    }
    // Meter material (progress bars / heat tiles): flat ("Minimal") unless
    // glass is pinned. Applied pre-paint so the bars never flash the other skin.
    var meters = localStorage.getItem("pm:meterStyle");
    document.documentElement.setAttribute("data-meters", meters === "glass" ? "glass" : "flat");
  } catch (e) {}
})();
