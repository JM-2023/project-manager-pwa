import { useRef } from "react";
import { useI18n, type Messages } from "../lib/i18n";
import { useSlidingIndicator } from "../lib/navIndicator";
import type { TabId } from "../state/appStore";
import { NavIcon } from "./NavIcon";

interface BottomNavProps {
  current: TabId;
  onChange: (tab: TabId) => void;
}

const items: Array<{ id: TabId; label: keyof Messages["nav"] }> = [
  { id: "today", label: "today" },
  { id: "projects", label: "projects" },
  { id: "calendar", label: "calendar" },
  { id: "next", label: "next" },
  { id: "search", label: "search" },
  { id: "settings", label: "settings" }
];

export function BottomNav({ current, onChange }: BottomNavProps) {
  const { m } = useI18n();
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  useSlidingIndicator(navRef, indicatorRef, current);
  return (
    <nav ref={navRef} className="bottom-nav" aria-label={m.nav.label}>
      {/* Selection pill: only painted by palettes that give the active tab a
          block of colour (app.css, Prussian ground); it springs between tabs. */}
      <span ref={indicatorRef} className="bottom-nav__indicator" aria-hidden="true" />
      {items.map(({ id, label }) => (
        <button key={id} type="button" data-nav={id} aria-current={current === id ? "page" : undefined} className={current === id ? "active" : ""} onClick={() => onChange(id)}>
          <NavIcon id={id} active={current === id} />
          <span>{m.nav[label]}</span>
        </button>
      ))}
    </nav>
  );
}
