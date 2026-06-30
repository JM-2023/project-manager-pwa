import { useCallback, useRef, useState } from "react";
import type { TransitionEvent } from "react";

/**
 * Smoothly collapses-and-fades a list item before it is removed from the data.
 *
 * React unmounts a deleted row synchronously, so a node would otherwise blink
 * out of existence. Instead we keep it mounted, lock its current height, then
 * transition that height to zero while the `is-removing` class fades and shrinks
 * it. Once the height transition lands we call `remove()` so React can drop the
 * now-invisible node — the surrounding rows have already slid up into place.
 *
 * A safety timer fires `remove()` even if `transitionend` never arrives (no
 * node, a zero-height row, or an interrupted transition), so an item can never
 * get stuck half-removed.
 */
export function useRemoveTransition<T extends HTMLElement>(remove: () => void) {
  const ref = useRef<T | null>(null);
  const [removing, setRemoving] = useState(false);
  const done = useRef(false);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    remove();
  }, [remove]);

  const begin = useCallback(() => {
    const el = ref.current;
    if (!el || removing) {
      finish();
      return;
    }
    // Lock the rendered height so the collapse animates from a concrete value
    // (auto height can't be transitioned).
    el.style.height = `${el.offsetHeight}px`;
    // Force a reflow so the locked height is committed before we drop it to 0.
    void el.offsetHeight;
    setRemoving(true);
    requestAnimationFrame(() => {
      if (ref.current) ref.current.style.height = "0px";
    });
    // Fallback in case transitionend never fires (e.g. reduced motion edge cases).
    window.setTimeout(finish, 500);
  }, [finish, removing]);

  const onTransitionEnd = useCallback(
    (event: TransitionEvent<T>) => {
      if (event.target !== ref.current || event.propertyName !== "height") return;
      finish();
    },
    [finish]
  );

  return { ref, removing, begin, onTransitionEnd };
}
