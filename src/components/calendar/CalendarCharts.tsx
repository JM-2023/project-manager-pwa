import type { CSSProperties } from "react";
import { progressTone } from "../../lib/progress";

interface CompletionBarProps {
  value: number;
  label?: string;
}

/** Slim liquid-fill bar reusing the app's `.mini-bar` treatment. */
export function CompletionBar({ value, label }: CompletionBarProps) {
  return (
    <span
      className={`mini-bar tone-${progressTone(value)}`}
      style={{ "--pct": `${value}%` } as CSSProperties}
      role="img"
      aria-label={label ?? `${Math.round(value)}%`}
    />
  );
}

interface MiniBarSeriesProps {
  data: Array<{ key: string; value: number; label: string; active?: boolean; hint?: string }>;
  onSelect?: (key: string) => void;
}

/** A row of vertical bars; each bar's height + tone encodes its completion value. */
export function MiniBarSeries({ data, onSelect }: MiniBarSeriesProps) {
  return (
    <div className="cal-series" role="group">
      {data.map((item, index) => {
        const Tag = onSelect ? "button" : "div";
        return (
          <Tag
            key={item.key}
            type={onSelect ? "button" : undefined}
            className={`cal-series__col${item.active ? " active" : ""}`}
            style={{ "--i": index } as CSSProperties}
            onClick={onSelect ? () => onSelect(item.key) : undefined}
            title={`${item.hint ?? item.label}: ${Math.round(item.value)}%`}
          >
            <span className="cal-series__track" aria-hidden="true">
              <span
                className={`cal-series__fill tone-${progressTone(item.value)}`}
                style={{ "--pct": `${item.value}%` } as CSSProperties}
              />
            </span>
            <span className="cal-series__label">{item.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}
