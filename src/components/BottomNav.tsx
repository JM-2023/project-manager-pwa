import { Briefcase, CalendarCheck2, CalendarRange, Lightbulb, Search, Settings } from "lucide-react";
import { useI18n, type Messages } from "../lib/i18n";
import type { TabId } from "../state/appStore";

interface BottomNavProps {
  current: TabId;
  onChange: (tab: TabId) => void;
}

const items: Array<{ id: TabId; label: keyof Messages["nav"]; Icon: typeof CalendarCheck2 }> = [
  { id: "today", label: "today", Icon: CalendarCheck2 },
  { id: "projects", label: "projects", Icon: Briefcase },
  { id: "calendar", label: "calendar", Icon: CalendarRange },
  { id: "next", label: "next", Icon: Lightbulb },
  { id: "search", label: "search", Icon: Search },
  { id: "settings", label: "settings", Icon: Settings }
];

export function BottomNav({ current, onChange }: BottomNavProps) {
  const { m } = useI18n();
  return (
    <nav className="bottom-nav" aria-label={m.nav.label}>
      {items.map(({ id, label, Icon }) => (
        <button key={id} type="button" className={current === id ? "active" : ""} onClick={() => onChange(id)}>
          <Icon size={21} aria-hidden="true" />
          <span>{m.nav[label]}</span>
        </button>
      ))}
    </nav>
  );
}
