// Apply a pinned theme before first paint to avoid a flash of the wrong
// theme. "system" (or unset) falls through to prefers-color-scheme. Same for
// the UI language ("en" is the default; i18n.tsx re-applies after hydration).
// Lives as an external file (not inline) so the CSP can stay 'self'-only.
(function () {
  try {
    // Ground colour: bone paper unless the neutral gray is pinned.
    // Applied pre-paint so the gray never flashes bone first.
    var bg = localStorage.getItem("pm:bg") === "gray" ? "gray" : "default";
    if (bg === "gray") {
      document.documentElement.setAttribute("data-bg", "gray");
    }

    // Browser-chrome colors per ground × scheme; keep in sync with
    // src/lib/chromeColor.ts and the --bg tokens in app.css.
    var COLORS = {
      default: { light: "#f5f3ee", dark: "#131211" },
      gray: { light: "#eef0f3", dark: "#17181a" }
    };

    var t = localStorage.getItem("pm:theme");
    var pinned = t === "light" || t === "dark";
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    }
    // A pinned theme overrides both media-scoped metas; a non-default ground
    // retints each meta within its own scheme. (The static HTML already
    // carries the default ground's colors.)
    if (pinned || bg !== "default") {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i += 1) {
        var scheme = pinned ? t : ((metas[i].getAttribute("media") || "").indexOf("dark") >= 0 ? "dark" : "light");
        metas[i].setAttribute("content", COLORS[bg][scheme]);
      }
    }
    if (localStorage.getItem("pm:lang") === "zh") {
      document.documentElement.lang = "zh-CN";
    }
    // Meter material (progress bars / heat tiles): glass unless flat is
    // pinned. Applied pre-paint so the bars never flash the other skin.
    var meters = localStorage.getItem("pm:meterStyle");
    document.documentElement.setAttribute("data-meters", meters === "flat" ? "flat" : "glass");
  } catch (e) {}
})();
