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
  /** The pressed button rides along for handlers that anchor an effect to it
      (the ground toggle's radial reveal starts from this element). */
  onChange: (id: T, origin?: HTMLButtonElement) => void;
  ariaLabel: string;
}

/* The control most recently pressed. Theme / ground / meter / language
   changes run inside a View Transition, which would otherwise paint this
   control as two frozen snapshots; while one runs, .cal-seg--live lifts the
   pressed control out as a single live layer (app.css, "Theme switch") so its
   thumb keeps sliding. Only one control carries the class, keeping the
   view-transition-name it maps to unique. */
let liveSeg: HTMLElement | null = null;

function markLive(el: HTMLElement | null) {
  if (liveSeg === el) return;
  liveSeg?.classList.remove("cal-seg--live");
  el?.classList.add("cal-seg--live");
  liveSeg = el;
}

/**
 * Segmented control with a real sliding thumb. The thumb is one absolutely
 * positioned element translated to the active column (transform-only, so the
 * crisp in-out motion stays compositor-smooth). It sits above the buttons and
 * carries its own copy of the labels in the selected ink, counter-translated
 * so each sits exactly over its button: the label colour flips precisely at
 * the thumb's edge as it slides, instead of on a separate colour timeline
 * that leaves a light label on the light track (or a muted one on a dark
 * thumb) mid-slide. --seg-count sizes the thumb, --seg-i places it.
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
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          lang={option.lang}
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={(event) => {
            markLive(event.currentTarget.parentElement);
            onChange(option.id, event.currentTarget);
          }}
        >
          {option.label}
        </button>
      ))}
      <span className="cal-seg__thumb" aria-hidden="true">
        <span className="cal-seg__ink">
          {options.map((option) => (
            <span key={option.id} lang={option.lang}>
              {option.label}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}
