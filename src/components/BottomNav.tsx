import { useI18n, type Messages } from "../lib/i18n";
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
  return (
    <nav className="bottom-nav" aria-label={m.nav.label}>
      {items.map(({ id, label }) => (
        <button key={id} type="button" className={current === id ? "active" : ""} onClick={() => onChange(id)}>
          <NavIcon id={id} />
          <span>{m.nav[label]}</span>
        </button>
      ))}
    </nav>
  );
}
