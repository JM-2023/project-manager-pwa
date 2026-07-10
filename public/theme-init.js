// Apply a pinned theme before first paint to avoid a flash of the wrong
// theme. "system" (or unset) falls through to prefers-color-scheme. Same for
// the UI language ("en" is the default; i18n.tsx re-applies after hydration).
// Lives as an external file (not inline) so the CSP can stay 'self'-only.
(function () {
  try {
    var t = localStorage.getItem("pm:theme");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
      // Pin the browser chrome color to the pinned theme; the media-query
      // metas only track the OS scheme.
      var color = t === "dark" ? "#0c0e13" : "#f3f4f7";
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i += 1) {
        metas[i].setAttribute("content", color);
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
