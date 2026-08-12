import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { syncChromeColor } from "./chromeColor";

/**
 * Ground colour under the whole app. "default" is the bone paper the app
 * ships with; "gray" turns the ground a near-white neutral gray (see the
 * Ground section in app.css) beneath the same cards. A device-local display
 * preference stored like the theme; theme-init.js applies it before first
 * paint and the CSS keys off html[data-bg].
 */
export type BackgroundStyle = "default" | "gray";

const STORAGE_KEY = "pm:bg";

function isBackgroundStyle(value: unknown): value is BackgroundStyle {
  return value === "default" || value === "gray";
}

export function getStoredBackground(): BackgroundStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isBackgroundStyle(raw) ? raw : "default";
  } catch {
    return "default";
  }
}

/** Apply a ground to the document root. Mirrors the boot script. */
export function applyBackground(style: BackgroundStyle): void {
  const root = document.documentElement;
  if (style === "default") {
    root.removeAttribute("data-bg");
  } else {
    root.setAttribute("data-bg", style);
  }
  syncChromeColor();
}

export function setStoredBackground(style: BackgroundStyle): void {
  try {
    if (style === "default") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, style);
    }
  } catch {
    /* storage may be unavailable (private mode); the in-memory state still applies */
  }
  applyBackground(style);
}

/** Reconcile the root attribute with the stored value (mirrors theme-init.js). */
export function initBackground(): void {
  applyBackground(getStoredBackground());
}

let transitionToken = 0;

/**
 * Swap the ground inside a View Transition, but not as a cross-fade: the
 * material change has a place it comes from — the toggle the user pressed —
 * so the new ground pours out of that point as an expanding circle, and on
 * the way back the old ground drains into the same point (app.css,
 * "Ground switch"). The circle's centre and the radius that reaches the
 * farthest viewport corner are handed to the CSS as --bg-vt-* variables;
 * .bg-switching--in/--out pick the direction. Falls back to an instant swap
 * without the API or with reduced motion.
 */
function swapBackgroundAnimated(next: BackgroundStyle, origin: HTMLElement | undefined, swap: () => void): void {
  const root = document.documentElement;
  const animatable =
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animatable) {
    swap();
    return;
  }

  const rect = origin?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.style.setProperty("--bg-vt-x", `${x}px`);
  root.style.setProperty("--bg-vt-y", `${y}px`);
  root.style.setProperty("--bg-vt-r", `${Math.ceil(radius)}px`);

  // Reuses the theme toggle's transition-freeze pattern; the direction class
  // decides which snapshot the circle clips. The token keeps a rapid
  // re-toggle from stripping the classes mid-transition.
  const token = ++transitionToken;
  const direction = next === "default" ? "bg-switching--out" : "bg-switching--in";
  root.classList.add("bg-switching", direction);
  const transition = document.startViewTransition(swap);
  // ready rejects when the browser skips the animation (rapid re-toggle,
  // hidden document); the swap still lands, so just silence the rejection.
  transition.ready.catch(() => undefined);
  transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) {
        root.classList.remove("bg-switching", "bg-switching--in", "bg-switching--out");
        root.style.removeProperty("--bg-vt-x");
        root.style.removeProperty("--bg-vt-y");
        root.style.removeProperty("--bg-vt-r");
      }
    });
}

export function useBackground(): [BackgroundStyle, (style: BackgroundStyle, origin?: HTMLElement) => void] {
  const [style, setStyleState] = useState<BackgroundStyle>(getStoredBackground);

  const update = useCallback((next: BackgroundStyle, origin?: HTMLElement) => {
    if (next === getStoredBackground()) {
      setStoredBackground(next);
      setStyleState(next);
      return;
    }
    swapBackgroundAnimated(next, origin, () => {
      // flushSync: the DOM must reach its final state inside the view
      // transition callback, or the toggle's active chip lands a frame late.
      flushSync(() => {
        setStoredBackground(next);
        setStyleState(next);
      });
    });
  }, []);

  return [style, update];
}
