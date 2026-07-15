import type { TabId } from "../state/appStore";

/**
 * Custom nav glyphs. Each icon draws a calm resting outline (matching the
 * lucide line-art it replaces) plus an "active" accent that is always present
 * in the DOM but hidden until the button carries `.active` — the reveal is a
 * pure CSS transition (see the "Custom nav glyphs" block in app.css):
 *
 *   next     — the bulb lights up: rays burst outward from its centre
 *   today    — a check writes itself onto the calendar
 *   projects — the briefcase latch draws across
 *   calendar — a ring pops around the selected day
 *   search   — a scan ring pulses out from the lens
 *   settings — the gear turns as it engages
 *
 * Shared attributes mirror lucide (24-unit viewBox, 2px round strokes) so the
 * resting icons sit flush with the rest of the app's iconography.
 */
const SHARED = {
  width: 21,
  height: 21,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true
};

function TodayIcon() {
  return (
    <svg {...SHARED} className="ni ni-today">
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      {/* accent: the check writes itself on */}
      <path className="ni-draw" pathLength={1} d="M8 15.5l2.5 2.5 5-6" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg {...SHARED} className="ni ni-projects">
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect x="2" y="6" width="20" height="14" rx="2" />
      {/* accent: the lid latch draws across */}
      <path className="ni-draw" pathLength={1} d="M7 12h10" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...SHARED} className="ni ni-calendar">
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      {/* day marks */}
      <path d="M8 16h.01" />
      <path d="M16 16h.01" />
      {/* accent: a ring pops around the selected day */}
      <circle className="ni-accent ni-pop" cx="12" cy="16" r="2.6" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg {...SHARED} className="ni ni-next">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      {/* accent: light rays burst outward from the bulb */}
      <g className="ni-accent ni-rays">
        <path d="M5 8H3" />
        <path d="M7 3 5.6 1.6" />
        <path d="M17 3l1.4-1.4" />
        <path d="M19 8h2" />
      </g>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...SHARED} className="ni ni-search">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      {/* accent: a scan ring pulses out from the lens centre */}
      <circle className="ni-accent ni-pop" cx="11" cy="11" r="3.6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...SHARED} className="ni ni-settings">
      {/* the whole gear turns as it engages */}
      <g className="ni-gear">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    </svg>
  );
}

const ICONS: Record<TabId, () => JSX.Element> = {
  today: TodayIcon,
  projects: ProjectsIcon,
  calendar: CalendarIcon,
  next: NextIcon,
  search: SearchIcon,
  settings: SettingsIcon
};

export function NavIcon({ id }: { id: TabId }) {
  const Icon = ICONS[id];
  return <Icon />;
}
