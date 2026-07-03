import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Theme preference. "system" follows prefers-color-scheme (no [data-theme] on
 * the root, so the media-query tokens win); "light"/"dark" pin the root via a
 * [data-theme] attribute, which the CSS layers on top of prefers-color-scheme.
 */
export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "pm:theme";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function getStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

// Browser-chrome colors for the theme-color metas; keep in sync with the --bg
// tokens in app.css and with public/theme-init.js.
const THEME_COLORS: Record<"light" | "dark", string> = { light: "#f3f4f7", dark: "#0c0e13" };

/**
 * Point the theme-color metas at the rendered theme. A pinned theme overrides
 * both media-scoped metas; "system" restores their per-scheme defaults.
 */
function applyThemeColorMeta(pref: ThemePreference): void {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((meta) => {
    if (pref === "system") {
      const media = meta.getAttribute("media") ?? "";
      meta.content = media.includes("dark") ? THEME_COLORS.dark : THEME_COLORS.light;
    } else {
      meta.content = THEME_COLORS[pref];
    }
  });
}

/** Apply a preference to the document root. Mirrors the boot script. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
  applyThemeColorMeta(pref);
}

export function setStoredTheme(pref: ThemePreference): void {
  try {
    if (pref === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    /* storage may be unavailable (private mode); the in-memory state still applies */
  }
  applyTheme(pref);
}

/** What a preference renders as ("system" defers to the OS). */
function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The preference currently pinned on the root — i.e. what is on screen now. */
function rootPreference(): ThemePreference {
  const pinned = document.documentElement.getAttribute("data-theme");
  return pinned === "light" || pinned === "dark" ? pinned : "system";
}

let transitionToken = 0;

/**
 * Run a theme swap inside a View Transition: the browser captures the old
 * frame once and cross-fades it into the new one as a compositor-only opacity
 * animation (tuned in app.css) — one snapshot instead of per-frame colour
 * transitions on every element, so the fade holds the display's full frame
 * rate. Gradient tokens (--glass-fill etc.) can't interpolate via CSS
 * transitions anyway; the snapshot fade covers them too. Falls back to an
 * instant swap when the API is missing, reduced motion is on, or the resolved
 * theme doesn't visually change (e.g. light -> system on a light OS).
 */
function swapThemeAnimated(pref: ThemePreference, swap: () => void): void {
  const root = document.documentElement;
  const animatable =
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    resolveTheme(pref) !== resolveTheme(rootPreference());
  if (!animatable) {
    swap();
    return;
  }
  // .theme-switching freezes per-element transitions so the page beneath the
  // cross-fade jumps straight to its final state (see app.css). The token
  // keeps a rapid re-toggle from stripping the class mid-transition.
  const token = ++transitionToken;
  root.classList.add("theme-switching");
  document
    .startViewTransition(swap)
    .finished.catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) root.classList.remove("theme-switching");
    });
}

export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [theme, setThemeState] = useState<ThemePreference>(getStoredTheme);

  // Reconcile the root attribute with React state on mount, in case the boot
  // script and stored value drifted.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const update = useCallback((pref: ThemePreference) => {
    swapThemeAnimated(pref, () => {
      // flushSync: the DOM must reach its final state inside the view
      // transition callback, or the toggle's active chip lands a frame late.
      flushSync(() => {
        setStoredTheme(pref);
        setThemeState(pref);
      });
    });
  }, []);

  return [theme, update];
}
