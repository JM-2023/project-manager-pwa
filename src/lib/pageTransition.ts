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

/**
 * Jump the arriving page's own CSS entrances (sections, rows and cards that
 * fade up from 0, several of them staggered) to their end state. Those are
 * written for things appearing within a page; under a page entrance they made
 * the page arrive twice — mostly transparent inside the cross-fade, then a
 * second staggered wave fading up after it had ended, which read as a blink
 * on landing (worst on a phone, where more of the stagger outlives the
 * fade). Elements that mount later, like a newly added row, still animate.
 */
function settleEntrances(): void {
  const page = document.querySelector(".page-content");
  if (!page || typeof CSSAnimation === "undefined") return;
  for (const animation of page.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (animation.effect?.getComputedTiming().endTime === Infinity) continue;
    animation.finish();
  }
}

let transitionToken = 0;

/**
 * Run a tab swap, cross-faded when possible. `dir` is the travel direction in
 * navigation order (1 = towards later tabs); 0 swaps instantly.
 */
export function switchPageAnimated(dir: number, swap: () => void): void {
  const root = document.documentElement;
  if (dir === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    swap();
    return;
  }
  // flushSync: the new page must be in the DOM (and its canvases painted)
  // before its entrances can be settled and the new snapshot is captured.
  const land = () => {
    flushSync(swap);
    settleEntrances();
  };
  if (!supported()) {
    land();
    return;
  }
  // The token keeps a rapid second tap from clearing the attribute while its
  // own transition is still running.
  const token = ++transitionToken;
  root.dataset.pageSwitch = dir > 0 ? "fwd" : "back";
  document
    .startViewTransition(land)
    .finished.catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) delete root.dataset.pageSwitch;
    });
}
