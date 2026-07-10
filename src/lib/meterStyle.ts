import { useCallback, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Material for the app's completion meters (Today core bar, project chip
 * meters, calendar bars/series, heatmap tiles). "glass" is the v2 liquid
 * treatment; "flat" the solid de-slop one. A device-local display preference
 * stored like the theme; theme-init.js applies it before first paint and the
 * CSS keys off html[data-meters].
 */
export type MeterStyle = "glass" | "flat";

const STORAGE_KEY = "pm:meterStyle";

function isMeterStyle(value: unknown): value is MeterStyle {
  return value === "glass" || value === "flat";
}

export function getStoredMeterStyle(): MeterStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isMeterStyle(raw) ? raw : "glass";
  } catch {
    return "glass";
  }
}

export function applyMeterStyle(style: MeterStyle): void {
  document.documentElement.setAttribute("data-meters", style);
}

export function setStoredMeterStyle(style: MeterStyle): void {
  try {
    if (style === "glass") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, style);
    }
  } catch {
    /* storage may be unavailable (private mode); the in-memory state still applies */
  }
  applyMeterStyle(style);
}

/** Reconcile the root attribute with the stored value (mirrors theme-init.js). */
export function initMeterStyle(): void {
  applyMeterStyle(getStoredMeterStyle());
}

let transitionToken = 0;

/**
 * Swap the meter material inside a View Transition, exactly like the theme
 * toggle: the change re-skins scattered elements (bars, tiles, chips) at
 * once, so one compositor cross-fade beats dozens of per-element repaints.
 * Falls back to an instant swap without the API or with reduced motion.
 */
function swapMeterAnimated(swap: () => void): void {
  const root = document.documentElement;
  const animatable =
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animatable) {
    swap();
    return;
  }
  const token = ++transitionToken;
  // Reuses the theme toggle's transition-freeze class so per-element
  // transitions don't run underneath the snapshot fade.
  root.classList.add("theme-switching");
  document
    .startViewTransition(swap)
    .finished.catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) root.classList.remove("theme-switching");
    });
}

export function useMeterStyle(): [MeterStyle, (style: MeterStyle) => void] {
  const [style, setStyleState] = useState<MeterStyle>(getStoredMeterStyle);

  const update = useCallback((next: MeterStyle) => {
    if (next === getStoredMeterStyle()) {
      setStoredMeterStyle(next);
      setStyleState(next);
      return;
    }
    swapMeterAnimated(() => {
      flushSync(() => {
        setStoredMeterStyle(next);
        setStyleState(next);
      });
    });
  }, []);

  return [style, update];
}
