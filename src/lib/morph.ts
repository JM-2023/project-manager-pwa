import { useLayoutEffect, useRef, type RefObject } from "react";

/* Short show/hide tweens (a menu, a notice) that can be turned around.
   Asked to go the other way mid-flight, a block continues from wherever it
   is drawn at that moment instead of jumping back to its first frame: a
   menu tapped shut while it is still opening shrinks from its half-open
   size, and one reopened while closing grows back from there.

   CSS keyframes can't do that. A keyframe that names only its end state
   starts from the element's resting style, not its animated one, and
   swapping animation names restarts from frame 0. So the tweens run on
   WAAPI and read their start from the computed (animated) style. */

const running = new WeakMap<Element, Animation>();

export const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const kebab = (prop: string) => prop.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

interface MorphOptions {
  /** Where to start when the block is at rest (not mid-tween). Without it,
   * a resting block starts from its own current style. */
  from?: Keyframe;
  duration: number;
  easing: string;
  /** Keep the end state once landed (a block on its way out stays hidden
   * until it is unmounted). */
  hold?: boolean;
}

/** Tween `el` to `to`, starting from where it is drawn right now. */
export function morphTo(el: HTMLElement, to: Keyframe, { from, duration, easing, hold = false }: MorphOptions): Animation {
  const previous = running.get(el);
  let start: Keyframe;
  if (previous || !from) {
    const style = getComputedStyle(el);
    start = {};
    for (const prop of Object.keys(to)) start[prop] = style.getPropertyValue(kebab(prop));
  } else {
    start = from;
  }
  // Read first, then let the old tween go: it is what put the block there.
  previous?.cancel();
  const animation = el.animate([start, to], { duration: reducedMotion() ? 0 : duration, easing, fill: hold ? "forwards" : "auto" });
  running.set(el, animation);
  // A held end state stays registered, so the next tween replaces it.
  if (!hold) {
    const release = () => {
      if (running.get(el) === animation) running.delete(el);
    };
    animation.finished.then(release, release);
  }
  return animation;
}

export interface PresenceMotion {
  /** How the block looks before it has arrived. */
  hidden: Keyframe;
  /** How it looks once it has gone (often a little less far than `hidden`). */
  gone: Keyframe;
  enterMs: number;
  exitMs: number;
}

const SHOWN: Keyframe = { opacity: "1", scale: "1", translate: "0px 0px" };

/**
 * Drive a usePresence block's entrance and exit, turning around from where
 * it is when `closing` flips mid-flight. The block's resting style must be
 * its shown state (opacity 1, no scale or translate). Call it after any
 * layout effect that places the block, so it measures nothing mid-tween.
 */
export function usePresenceMorph(
  ref: RefObject<HTMLElement>,
  presence: { mounted: boolean; closing: boolean; onExited: () => void },
  motion: PresenceMotion
): void {
  const onExitedRef = useRef(presence.onExited);
  onExitedRef.current = presence.onExited;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const { mounted, closing } = presence;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!mounted || !el) return;
    const { hidden, gone, enterMs, exitMs } = motionRef.current;
    if (!closing) {
      morphTo(el, SHOWN, { from: hidden, duration: enterMs, easing: EASE_OUT });
      return;
    }
    morphTo(el, gone, { duration: exitMs, easing: EASE, hold: true }).finished.then(
      () => onExitedRef.current(),
      () => undefined
    );
  }, [mounted, closing, ref]);
}
