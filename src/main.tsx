import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./lib/i18n";
import { initMeterStyle } from "./lib/meterStyle";
import "./styles/app.css";

// Re-assert the meter material in case the boot script was skipped (e.g. a
// stale service-worker HTML without it).
initMeterStyle();

// First-entry ink reveal. When it finishes, keep a completion class on the
// root so the base page animation does not restart and flash the UI.
document.documentElement.classList.add("first-reveal");
window.setTimeout(() => {
  document.documentElement.classList.add("reveal-complete");
  document.documentElement.classList.remove("first-reveal");
}, 1320);

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
