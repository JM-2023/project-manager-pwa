import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

// Marauder's Map reveal: ink the first screen in on entry, then drop the flag
// so later in-app navigation uses the lighter transitions.
document.documentElement.classList.add("first-reveal");
window.setTimeout(() => document.documentElement.classList.remove("first-reveal"), 1500);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}
