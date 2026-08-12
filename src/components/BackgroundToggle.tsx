import { useBackground, type BackgroundStyle } from "../lib/background";
import { useI18n } from "../lib/i18n";
import { SegControl } from "./SegControl";

const OPTIONS: BackgroundStyle[] = ["default", "gray"];

export function BackgroundToggle() {
  const { m } = useI18n();
  const [background, setBackground] = useBackground();
  const labels: Record<BackgroundStyle, string> = {
    default: m.settings.bgDefault,
    gray: m.settings.bgGray
  };
  return (
    <SegControl
      ariaLabel={m.settings.background}
      value={background}
      onChange={setBackground}
      vtName="seg-bg"
      options={OPTIONS.map((option) => ({ id: option, label: labels[option] }))}
    />
  );
}
