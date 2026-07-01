import { useCallback, useState } from "react";

/**
 * Pixel animation for the Today "加权推进" hero (HeroPulse): "flow" glides the
 * dot field rightward so pixels swim out of the fill; "shimmer" twinkles in
 * place. A device-local display preference stored like the theme, not synced
 * app data.
 */
export type HeroAnimation = "flow" | "shimmer";

const STORAGE_KEY = "pm:heroAnimation";

function isHeroAnimation(value: unknown): value is HeroAnimation {
  return value === "flow" || value === "shimmer";
}

export function getStoredHeroAnimation(): HeroAnimation {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isHeroAnimation(raw) ? raw : "flow";
  } catch {
    return "flow";
  }
}

export function setStoredHeroAnimation(pref: HeroAnimation): void {
  try {
    if (pref === "flow") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    /* storage may be unavailable (private mode); the in-memory state still applies */
  }
}

export function useHeroAnimation(): [HeroAnimation, (pref: HeroAnimation) => void] {
  const [pref, setPrefState] = useState<HeroAnimation>(getStoredHeroAnimation);

  const update = useCallback((next: HeroAnimation) => {
    setStoredHeroAnimation(next);
    setPrefState(next);
  }, []);

  return [pref, update];
}
