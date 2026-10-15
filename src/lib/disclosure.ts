import { useCallback, useEffect, useLayoutEffect, useState, type RefObject, type TransitionEvent } from "react";
import { scrollParent } from "./listMotion";

/* A block that opens and closes in place (a task card's editor, an idea
   group's body): its panel mounts only while open, eases its grid track
   from 0fr to 1fr and back, and the page follows so the block stays in
   view. The CSS side is the panel's own `grid-template-rows` transition on
   `.is-open`, at --t-slow. */

// Matches --t-slow, the panel's open/close transition.
const DISCLOSE_MS = 300;
// Room kept between a block being opened or closed and the edges of the view.
const VIEW_MARGIN = 12;
const FOLLOW_K = 14;
const FOLLOW_SETTLE_MS = 450;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The part of a scroller the user can see; on a phone the fixed Dock
 * covers the bottom of the window. */
function visibleBand(scroller: Element): { top: number; bottom: number } {
  if (scroller !== document.scrollingElement) {
    const rect = scroller.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }
  const dock = document.querySelector(".bottom-nav")?.getBoundingClientRect();
  return { top: 0, bottom: dock && dock.top > window.innerHeight / 2 ? dock.top : window.innerHeight };
}

/**
 * While a block opens or closes, ease the page so it stays in view: an
 * opening block near the bottom carries the page up with it (never past its
 * own top), and a closing block whose top has scrolled away brings the page
 * back to it. Each frame closes part of the remaining gap, so the scroll
 * rides the size transition instead of jumping ahead of it. Stops as soon
 * as the user touches or wheels. Returns a function that stops it early.
 */
export function keepInView(node: HTMLElement): () => void {
  const scroller = scrollParent(node);
  if (!scroller) return () => undefined;
  const instant = reducedMotion();
  let raf = 0;
  let last = performance.now();
  const until = last + DISCLOSE_MS;
  const stop = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("touchstart", stop, true);
    window.removeEventListener("wheel", stop, true);
  };
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const band = visibleBand(scroller);
    const rect = node.getBoundingClientRect();
    const top = band.top + VIEW_MARGIN;
    const bottom = band.bottom - VIEW_MARGIN;
    const gap = rect.top < top ? rect.top - top : rect.bottom > bottom ? Math.min(rect.bottom - bottom, rect.top - top) : 0;
    if (Math.abs(gap) >= 1) {
      const step = instant ? gap : gap * (1 - Math.exp(-FOLLOW_K * dt));
      // Scroll offsets round to whole pixels; never step by less than one.
      scroller.scrollTop += Math.sign(gap) * Math.max(1, Math.round(Math.abs(step)));
    }
    if (instant || now > until + FOLLOW_SETTLE_MS || (now > until && Math.abs(gap) < 1)) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  window.addEventListener("touchstart", stop, { capture: true, passive: true });
  window.addEventListener("wheel", stop, { capture: true, passive: true });
  return stop;
}

/**
 * Presence for a disclosed panel. Opening mounts it shut and eases it open;
 * closing eases it shut, then unmounts. Render the panel while `mounted`,
 * with `.is-open` while `open`, and pass `onTransitionEnd` to it. A block
 * that starts out expanded mounts already open, without a transition.
 */
export function useDisclosure(expanded: boolean, panelRef: RefObject<HTMLElement>) {
  const [mounted, setMounted] = useState(expanded);
  const [open, setOpen] = useState(expanded);

  useLayoutEffect(() => {
    if (!expanded) {
      setOpen(false);
      return;
    }
    if (!mounted) {
      setMounted(true);
      return;
    }
    if (!open) {
      // Commit the shut layout before opening, so the grid track transitions
      // from 0fr instead of the panel appearing already open.
      void panelRef.current?.offsetHeight;
      setOpen(true);
    }
  }, [expanded, mounted, open, panelRef]);

  // Unmount once the close lands; the timer covers a transition that never
  // reports (reduced motion, an interrupted close).
  useEffect(() => {
    if (expanded || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), DISCLOSE_MS + 150);
    return () => window.clearTimeout(timer);
  }, [expanded, mounted]);

  const onTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (event.target === panelRef.current && event.propertyName === "grid-template-rows" && !expanded) {
        setMounted(false);
      }
    },
    [expanded, panelRef]
  );

  return { mounted, open, onTransitionEnd };
}
