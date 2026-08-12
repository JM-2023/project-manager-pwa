/**
 * Browser-chrome colors (the theme-color metas) for every ground × scheme
 * pair. The rendered ground is the combination of two root attributes —
 * [data-theme] (theme.ts) and [data-bg] (background.ts) — so both setters
 * funnel through syncChromeColor() after touching their attribute.
 *
 * Keep the values in sync with the --bg tokens in app.css and with the
 * mirrored table in public/theme-init.js (a plain pre-paint script that
 * cannot import this module).
 */

type Scheme = "light" | "dark";
type Ground = "default" | "gray";

const CHROME_COLORS: Record<Ground, Record<Scheme, string>> = {
  default: { light: "#f5f3ee", dark: "#131211" },
  gray: { light: "#eef0f3", dark: "#17181a" }
};

/**
 * Point the theme-color metas at what the root is actually rendering. A
 * pinned theme overrides both media-scoped metas; "system" gives each meta
 * its own scheme's color so the OS picks.
 */
export function syncChromeColor(): void {
  const root = document.documentElement;
  const pinned = root.getAttribute("data-theme");
  const ground: Ground = root.getAttribute("data-bg") === "gray" ? "gray" : "default";
  const colors = CHROME_COLORS[ground];
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((meta) => {
    if (pinned === "light" || pinned === "dark") {
      meta.content = colors[pinned];
    } else {
      const media = meta.getAttribute("media") ?? "";
      meta.content = media.includes("dark") ? colors.dark : colors.light;
    }
  });
}
