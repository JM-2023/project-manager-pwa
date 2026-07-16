import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./lib/i18n";
import { initMeterStyle } from "./lib/meterStyle";
import "./styles/app.css";

const PRELOAD_RELOAD_KEY = "project-manager:last-preload-reload";
const PRELOAD_RELOAD_COOLDOWN_MS = 10_000;
const FIRST_REVEAL_SEEN_KEY = "project-manager:first-reveal-seen";

// An already-open tab can request an old lazy chunk after a new deployment has
// removed that hash. Vite emits this cancellable event before surfacing the
// import failure; one online reload moves the tab onto the new document graph.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (!navigator.onLine) return;

  const now = Date.now();
  try {
    const lastReload = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0);
    if (Number.isFinite(lastReload) && now - lastReload < PRELOAD_RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
  } catch {
    // Without session storage there is no cross-reload loop guard, so leave
    // the current page mounted and let the user retry after the deployment.
    return;
  }
  window.location.reload();
});

// Re-assert the meter material in case the boot script was skipped (e.g. a
// stale service-worker HTML without it).
initMeterStyle();

// The ink reveal is a one-time welcome, not a reload animation. Persist the
// marker before starting so a refresh during the reveal cannot replay it. If
// storage is unavailable, skip the optional reveal rather than repeat it on
// every visit.
const root = document.documentElement;
let shouldPlayFirstReveal = false;
try {
  if (window.localStorage.getItem(FIRST_REVEAL_SEEN_KEY) === null) {
    window.localStorage.setItem(FIRST_REVEAL_SEEN_KEY, "1");
    shouldPlayFirstReveal = true;
  }
} catch {
  shouldPlayFirstReveal = false;
}

if (shouldPlayFirstReveal) {
  root.classList.remove("reveal-complete");
  root.classList.add("first-reveal");
  window.setTimeout(() => {
    root.classList.add("reveal-complete");
    root.classList.remove("first-reveal");
  }, 1320);
} else {
  root.classList.remove("first-reveal");
  root.classList.add("reveal-complete");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}
