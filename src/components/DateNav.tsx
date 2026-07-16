import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

export type NavDirection = 1 | -1;

interface RollTextProps {
  text: string;
  /** Which way the last navigation went; the text rolls along it. */
  dir: NavDirection;
  className?: string;
}

/**
 * Directionally rolling label. When `text` changes, the old value slides out
 * one way while the new one slides in from the other — the direction of the
 * last prev/next press — so the label physically travels with the date.
 *
 * The container's width morphs between the old and new text widths on the
 * same clock (measured in px, since auto→auto can't transition), so labels of
 * different lengths reflow the line smoothly instead of snapping it. The
 * ghost unmounts when its exit finishes; inline width clears once settled so
 * the label stays intrinsically sized between rolls.
 */
export function RollText({ text, dir, className }: RollTextProps) {
  const [ghost, setGhost] = useState<{ text: string; key: number } | null>(null);
  const prevRef = useRef(text);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const inRef = useRef<HTMLSpanElement | null>(null);
  // Width the container is actually painted at, captured render-phase BEFORE
  // the new text commits — afterwards the stacked ghost+new content already
  // reports max(old, new) and the starting width is gone.
  const widthFromRef = useRef<number | null>(null);
  const settleRef = useRef(0);

  if (prevRef.current !== text) {
    widthFromRef.current = wrapRef.current?.getBoundingClientRect().width ?? null;
    setGhost({ text: prevRef.current, key: Date.now() });
    prevRef.current = text;
  }

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const span = inRef.current;
    if (!wrap || !span) return;
    const from = widthFromRef.current;
    widthFromRef.current = null;
    if (from == null) return;
    // justify-self: start keeps the span at its content width even while the
    // grid column is stretched by a wider ghost, so this reads the true
    // target; the wrap's own padding is added back (border-box width).
    const styles = getComputedStyle(wrap);
    const target = span.offsetWidth + parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    window.clearTimeout(settleRef.current);
    if (Math.abs(target - from) < 0.5) {
      wrap.style.width = "";
      return;
    }
    wrap.style.width = `${from}px`;
    void wrap.offsetWidth;
    wrap.style.width = `${target}px`;
    settleRef.current = window.setTimeout(() => {
      wrap.style.width = "";
    }, 240);
  }, [text]);

  useLayoutEffect(() => () => window.clearTimeout(settleRef.current), []);

  const dirClass = dir === 1 ? "roll-fwd" : "roll-back";
  return (
    <span ref={wrapRef} className={`roll-text${className ? ` ${className}` : ""}`}>
      {ghost ? (
        <span
          key={ghost.key}
          className={`roll-text__ghost ${dirClass}`}
          aria-hidden="true"
          onAnimationEnd={() => setGhost(null)}
        >
          {ghost.text}
        </span>
      ) : null}
      {/* The roll class rides only while a ghost is in flight, i.e. the text
          actually changed. Worn permanently, a later dir flip renames the
          animation and replays it on unchanged text — the calendar's fixed
          title rolled on ‹/› reversals and on pressing the title itself.
          Ghost-out and text-in share one 0.18s clock, so the class is only
          removed after the entrance has finished. */}
      <span key={text} ref={inRef} className={`roll-text__in${ghost ? ` ${dirClass}` : ""}`}>
        {text}
      </span>
    </span>
  );
}

interface DateSwitcherProps {
  /** Top line — "Today" / the weekday, or the calendar's fixed title. */
  title: string;
  /** Bottom line — the concrete date / period. */
  sub: string;
  /**
   * Every text the title line can show. An invisible stack of them reserves
   * the widest one's width, so "Today" → "Wednesday" never shifts the arrows.
   */
  titleSizer?: string[];
  dir: NavDirection;
  onPrev: () => void;
  onNext: () => void;
  /** Jump back to today / the current period. */
  onHome: () => void;
  /** True when the view already shows today / the current period. */
  isHome: boolean;
  prevAria: string;
  nextAria: string;
  homeAria: string;
}

/**
 * The v2 date switcher: ‹ ›  arrows flanking a stacked two-line title block —
 * the day name over the concrete date — where the whole block is the
 * "return home" button (flat: hover wash and a press dip, no glass chip).
 * Both lines roll along the travel direction on change; the title line sits
 * on a hidden sizer of every possible label and the sub line width-morphs,
 * so nothing around the block jumps when the text lengths differ.
 */
export function DateSwitcher({
  title,
  sub,
  titleSizer,
  dir,
  onPrev,
  onNext,
  onHome,
  isHome,
  prevAria,
  nextAria,
  homeAria
}: DateSwitcherProps) {
  return (
    <div className="today-date-switcher">
      <button type="button" className="icon-button date-nav-button" onClick={onPrev} aria-label={prevAria}>
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`today-title-button${isHome ? " active" : ""}`}
        onClick={onHome}
        aria-label={homeAria}
        title={isHome ? undefined : homeAria}
        aria-current={isHome ? "date" : undefined}
      >
        <h1 className="dt-title">
          <RollText text={title} dir={dir} />
          {titleSizer && titleSizer.length > 0 ? (
            <span className="dt-sizer" aria-hidden="true">
              {titleSizer.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </span>
          ) : null}
        </h1>
        <span className="dt-sub">
          <RollText text={sub} dir={dir} />
        </span>
      </button>
      <button type="button" className="icon-button date-nav-button" onClick={onNext} aria-label={nextAria}>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
