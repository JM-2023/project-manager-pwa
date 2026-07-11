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
  /**
   * Unique view-transition-name for the thumb. Controls whose change runs
   * inside a View Transition (theme / meter / language) freeze per-element
   * transitions under the snapshot, which would swallow the thumb slide —
   * naming the thumb lifts it into its own VT group so the browser morphs it
   * from the old cell to the new one and the slide stays visible.
   */
  vtName?: string;
}

/**
 * Segmented control with a real sliding thumb. The thumb is one absolutely
 * positioned element translated to the active column (transform-only, so the
 * damped spring stays compositor-smooth); buttons above it stay transparent
 * and only swap text colour. --seg-count sizes the thumb, --seg-i places it.
 */
export function SegControl<T extends string>({ options, value, onChange, ariaLabel, vtName }: SegControlProps<T>) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  return (
    <div
      className="cal-seg"
      role="group"
      aria-label={ariaLabel}
      style={{ "--seg-count": options.length, "--seg-i": index } as CSSProperties}
    >
      <span
        className="cal-seg__thumb"
        aria-hidden="true"
        style={vtName ? ({ viewTransitionName: vtName } as CSSProperties) : undefined}
      />
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          lang={option.lang}
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          /* Named too, so each label is captured as its own (static) VT group
             painted after the thumb's — otherwise the thumb group renders on
             top of the root snapshot and covers the text until the morph
             finishes. */
          style={vtName ? ({ viewTransitionName: `${vtName}-o${index}` } as CSSProperties) : undefined}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
