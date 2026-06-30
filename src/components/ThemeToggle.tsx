import { useTheme, type ThemePreference } from "../lib/theme";

const OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" }
];

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="cal-seg" role="group" aria-label="Theme">
      {OPTIONS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={theme === item.id ? "active" : ""}
          aria-pressed={theme === item.id}
          onClick={() => setTheme(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
