import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { EASE_OUT, morphTo } from "../lib/morph";

export type NavDirection = 1 | -1;

interface RollTextProps {
  text: string;
  /** Which way the last navigation went; the text rolls along it. */
  dir: NavDirection;
  className?: string;
}

interface RollLayer {
  key: number;
  text: string;
  /** Set once a newer text has pushed this one out: the way it leaves. */
  leaving: NavDirection | null;
}

const ROLL_MS = 180;
const ROLL_SHIFT = "0.9em";
/** Leaving texts kept in flight at once; older ones are let go. */
const MAX_LEAVING = 3;

/**
 * Directionally rolling label. When `text` changes, the old value slides out
 * one way while the new one slides in from the other — the direction of the
 * last prev/next press — so the label physically travels with the date.
 *
 * Each text is one element for its whole life, entering and then leaving,
 * on WAAPI tweens that start from where it is drawn: pressed again mid-roll,
 * the half-arrived text leaves from where it got to (instead of snapping
 * back to fully shown first), and the text before it keeps leaving too.
 *
 * The container's width morphs between the old and new text widths on the
 * same clock (measured in px, since auto→auto can't transition), so labels of
 * different lengths reflow the line smoothly instead of snapping it. Inline
 * width clears once settled so the label stays intrinsically sized between
 * rolls.
 */
export function RollText({ text, dir, className }: RollTextProps) {
  const [layers, setLayers] = useState<RollLayer[]>(() => [{ key: 0, text, leaving: null }]);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const layerEls = useRef(new Map<number, HTMLSpanElement>());
  // Layers whose entrance or exit has been started, so a re-render doesn't
  // restart one. The first text is simply there.
  const startedRef = useRef(new Set<string>(["in:0"]));
  // Width the container is actually painted at, captured render-phase BEFORE
  // the new text commits — afterwards the stacked old+new content already
  // reports max(old, new) and the starting width is gone.
  const widthFromRef = useRef<number | null>(null);
  const settleRef = useRef(0);

  const current = layers[layers.length - 1];
  if (current.text !== text) {
    widthFromRef.current = wrapRef.current?.getBoundingClientRect().width ?? null;
    const leaving = layers.map((layer) => (layer.leaving ? layer : { ...layer, leaving: dir }));
    setLayers([...leaving.slice(-MAX_LEAVING), { key: current.key + 1, text, leaving: null }]);
  }

  useLayoutEffect(() => {
    const started = startedRef.current;
    for (const layer of layers) {
      const el = layerEls.current.get(layer.key);
      if (!el) continue;
      if (layer.leaving) {
        if (started.has(`out:${layer.key}`)) continue;
        started.add(`out:${layer.key}`);
        const shift = layer.leaving === 1 ? `-${ROLL_SHIFT}` : ROLL_SHIFT;
        const key = layer.key;
        morphTo(el, { opacity: "0", transform: `translateX(${shift})` }, { duration: ROLL_MS, easing: EASE_OUT, hold: true }).finished.then(
          () => {
            started.delete(`in:${key}`);
            started.delete(`out:${key}`);
            setLayers((all) => all.filter((each) => each.key !== key));
          },
          () => undefined
        );
      } else if (!started.has(`in:${layer.key}`)) {
        started.add(`in:${layer.key}`);
        const shift = dir === 1 ? ROLL_SHIFT : `-${ROLL_SHIFT}`;
        morphTo(el, { opacity: "1", transform: "none" }, { from: { opacity: "0", transform: `translateX(${shift})` }, duration: ROLL_MS, easing: EASE_OUT });
      }
    }
  }, [layers, dir]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const span = layerEls.current.get(current.key);
    if (!wrap || !span) return;
    const from = widthFromRef.current;
    widthFromRef.current = null;
    if (from == null) return;
    // justify-self: start keeps the span at its content width even while the
    // grid column is stretched by a wider leaving text, so this reads the
    // true target; the wrap's own padding is added back (border-box width).
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
  }, [current.key]);

  useLayoutEffect(() => () => window.clearTimeout(settleRef.current), []);

  return (
    <span ref={wrapRef} className={`roll-text${className ? ` ${className}` : ""}`}>
      {layers.map((layer) => (
        <span
          key={layer.key}
          ref={(el) => {
            if (el) layerEls.current.set(layer.key, el);
            else layerEls.current.delete(layer.key);
          }}
          className={layer.leaving ? "roll-text__ghost" : "roll-text__in"}
          aria-hidden={layer.leaving ? "true" : undefined}
        >
          {layer.text}
        </span>
      ))}
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
