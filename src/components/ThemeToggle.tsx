import { useI18n } from "../lib/i18n";
import { useTheme, type ThemePreference } from "../lib/theme";

const OPTIONS: ThemePreference[] = ["light", "dark", "system"];

export function ThemeToggle() {
  const { m } = useI18n();
  const [theme, setTheme] = useTheme();
  return (
    <div className="cal-seg" role="group" aria-label={m.theme.label}>
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={theme === option ? "active" : ""}
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
        >
          {m.theme[option]}
        </button>
      ))}
    </div>
  );
}
