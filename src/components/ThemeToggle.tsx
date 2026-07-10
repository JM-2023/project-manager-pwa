import { useI18n } from "../lib/i18n";
import { useTheme, type ThemePreference } from "../lib/theme";
import { SegControl } from "./SegControl";

const OPTIONS: ThemePreference[] = ["light", "dark", "system"];

export function ThemeToggle() {
  const { m } = useI18n();
  const [theme, setTheme] = useTheme();
  return (
    <SegControl
      ariaLabel={m.theme.label}
      value={theme}
      onChange={setTheme}
      options={OPTIONS.map((option) => ({ id: option, label: m.theme[option] }))}
    />
  );
}
