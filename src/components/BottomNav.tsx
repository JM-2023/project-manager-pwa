import { Briefcase, CalendarCheck2, Lightbulb, Search, Settings } from "lucide-react";
import type { TabId } from "../state/appStore";

interface BottomNavProps {
  current: TabId;
  onChange: (tab: TabId) => void;
}

const items: Array<{ id: TabId; label: string; Icon: typeof CalendarCheck2 }> = [
  { id: "today", label: "Today", Icon: CalendarCheck2 },
  { id: "projects", label: "Projects", Icon: Briefcase },
  { id: "next", label: "Next", Icon: Lightbulb },
  { id: "search", label: "Search", Icon: Search },
  { id: "settings", label: "Settings", Icon: Settings }
];

export function BottomNav({ current, onChange }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {items.map(({ id, label, Icon }) => (
        <button key={id} type="button" className={current === id ? "active" : ""} onClick={() => onChange(id)}>
          <Icon size={21} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
