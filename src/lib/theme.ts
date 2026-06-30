import { useCallback, useEffect, useState } from "react";

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

/** Apply a preference to the document root. Mirrors the inline boot script. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
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

export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [theme, setThemeState] = useState<ThemePreference>(getStoredTheme);

  // Reconcile the root attribute with React state on mount, in case the boot
  // script and stored value drifted.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const update = useCallback((pref: ThemePreference) => {
    setStoredTheme(pref);
    setThemeState(pref);
  }, []);

  return [theme, update];
}
