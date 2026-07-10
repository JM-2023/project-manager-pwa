import type { CSSProperties, ReactNode } from "react";

export interface SegOption<T extends string> {
  id: T;
  label: ReactNode;
  /** Optional BCP-47 tag when the label is a proper noun in its own language. */
  lang?: string;
}

interface SegControlProps<T extends string> {
  options: Array<SegOption<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}

/**
 * Segmented control with a real sliding thumb. The thumb is one absolutely
 * positioned element translated to the active column (transform-only, so the
 * damped spring stays compositor-smooth); buttons above it stay transparent
 * and only swap text colour. --seg-count sizes the thumb, --seg-i places it.
 */
export function SegControl<T extends string>({ options, value, onChange, ariaLabel }: SegControlProps<T>) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  return (
    <div
      className="cal-seg"
      role="group"
      aria-label={ariaLabel}
      style={{ "--seg-count": options.length, "--seg-i": index } as CSSProperties}
    >
      <span className="cal-seg__thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          lang={option.lang}
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
