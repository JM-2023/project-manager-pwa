import { flushSync } from "react-dom";

/* Tab switches used to be a hard cut: the old page unmounted and the new one
   rose from opacity 0, so for a beat the screen was bare ground — a blink,
   not a transition. Where View Transitions exist the swap now runs inside
   one: the old frame is captured and cross-faded into the new page with a
   short drift along the navigation's axis (app.css, "Tab switch"), so the
   screen is never empty. The navigation is lifted out as a live layer, so
   its pill and icons keep animating on top.

   State lives on data-* attributes, not classes: canvasLoop's palette
   observer watches `class` and `style` on the root and would repaint every
   canvas on each switch. */

const supported = () => typeof document.startViewTransition === "function";

/** Mark the root once so app.css can retire the fallback page-in entrance. */
export function initPageTransitions(): void {
  if (supported()) document.documentElement.dataset.pageVt = "";
}

let transitionToken = 0;

/**
 * Run a tab swap, cross-faded when possible. `dir` is the travel direction in
 * navigation order (1 = towards later tabs); 0 swaps instantly.
 */
export function switchPageAnimated(dir: number, swap: () => void): void {
  const root = document.documentElement;
  const animatable =
    dir !== 0 &&
    supported() &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animatable) {
    swap();
    return;
  }
  // The token keeps a rapid second tap from clearing the attribute while its
  // own transition is still running.
  const token = ++transitionToken;
  root.dataset.pageSwitch = dir > 0 ? "fwd" : "back";
  document
    .startViewTransition(() => {
      // flushSync: the new page must be in the DOM (and its canvases painted)
      // when the callback returns, or the new snapshot is captured empty.
      flushSync(swap);
    })
    .finished.catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) delete root.dataset.pageSwitch;
    });
}
