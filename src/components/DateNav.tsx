import { ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { usePresence } from "../lib/usePresence";

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
 * Transform/opacity only; the ghost unmounts when its exit finishes.
 */
export function RollText({ text, dir, className }: RollTextProps) {
  const [ghost, setGhost] = useState<{ text: string; key: number } | null>(null);
  const prevRef = useRef(text);
  if (prevRef.current !== text) {
    setGhost({ text: prevRef.current, key: Date.now() });
    prevRef.current = text;
  }
  const dirClass = dir === 1 ? "roll-fwd" : "roll-back";
  return (
    <span className={`roll-text${className ? ` ${className}` : ""}`}>
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
      <span key={text} className={`roll-text__in ${dirClass}`}>
        {text}
      </span>
    </span>
  );
}

interface DateNavProps {
  /** The current date / period, rendered inside the capsule. */
  label: string;
  dir: NavDirection;
  onPrev: () => void;
  onNext: () => void;
  /** Jump back to today / the current period. */
  onHome: () => void;
  /** True when the view already shows today / the current period. */
  isHome: boolean;
  /** Text on the return chip that appears while away from home. */
  homeLabel: string;
  prevAria: string;
  nextAria: string;
  homeAria: string;
  children?: ReactNode;
}

/**
 * The date navigator: one solid capsule of [‹ | label | ›] where the label
 * itself is the "return home" control, plus a tinted return chip that springs
 * in beside it whenever the view leaves today / the current period (and
 * animates back out when it returns).
 */
export function DateNav({
  label,
  dir,
  onPrev,
  onNext,
  onHome,
  isHome,
  homeLabel,
  prevAria,
  nextAria,
  homeAria
}: DateNavProps) {
  const pill = usePresence(!isHome, 360);
  return (
    <div className="date-nav">
      <div className="date-nav__group">
        <button type="button" className="date-nav__arrow" onClick={onPrev} aria-label={prevAria}>
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="date-nav__label"
          onClick={onHome}
          aria-label={homeAria}
          aria-current={isHome ? "date" : undefined}
        >
          <RollText text={label} dir={dir} />
        </button>
        <button type="button" className="date-nav__arrow" onClick={onNext} aria-label={nextAria}>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
      {pill.mounted ? (
        <button
          type="button"
          className={`date-nav__home${pill.closing ? " is-leaving" : ""}`}
          onClick={onHome}
          onAnimationEnd={pill.onExited}
        >
          <LocateFixed size={14} aria-hidden="true" />
          <span>{homeLabel}</span>
        </button>
      ) : null}
    </div>
  );
}
