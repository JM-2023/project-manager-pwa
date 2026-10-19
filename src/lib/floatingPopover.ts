import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { usePresenceMorph, type PresenceMotion } from "./morph";
import { usePresence } from "./usePresence";

/* Floating popovers (task actions, the card's project picker, the Search
   filter chips): portaled to <body> so no clipped card or table can cut
   them off. */

export type Placement = (anchor: DOMRect, popover: HTMLElement) => { left: number; top: number; up?: boolean };

const VIEW_EDGE = 8;
const clampLeft = (left: number, width: number) => Math.max(VIEW_EDGE, Math.min(left, window.innerWidth - width - VIEW_EDGE));
const clampTop = (top: number, height: number) => Math.max(VIEW_EDGE, Math.min(top, window.innerHeight - height - VIEW_EDGE));

/** Over the trigger, grown out of its bottom-right corner. */
export const coverTrigger: Placement = (anchor, popover) => ({
  left: clampLeft(anchor.right - popover.offsetWidth, popover.offsetWidth),
  top: clampTop(anchor.bottom - popover.offsetHeight, popover.offsetHeight)
});

/** Dropped below the trigger, left edges aligned; above it when the view
 * has no room underneath. */
export const dropFromTrigger: Placement = (anchor, popover) => {
  const height = popover.offsetHeight;
  const below = anchor.bottom + 6;
  const up = below + height > window.innerHeight - VIEW_EDGE && anchor.top - 6 - height >= VIEW_EDGE;
  return {
    left: clampLeft(anchor.left, popover.offsetWidth),
    top: clampTop(up ? anchor.top - 6 - height : below, height),
    up
  };
};

/** The action menu grows out of the trigger's corner and shrinks back to it. */
export const MORPH_MOTION: PresenceMotion = {
  hidden: { opacity: "0", scale: "0.92", translate: "3px 5px" },
  gone: { opacity: "0", scale: "0.94", translate: "2px 4px" },
  enterMs: 240,
  exitMs: 180
};

/** A menu dropped from a field opens in place. */
export const DROP_MOTION: PresenceMotion = {
  hidden: { opacity: "0", scale: "0.96", translate: "0px 0px" },
  gone: { opacity: "0", scale: "0.97", translate: "0px 0px" },
  enterMs: 200,
  exitMs: 160
};

interface FloatingPopoverOptions {
  open: boolean;
  close: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
  popoverRef: RefObject<HTMLDivElement>;
  place: Placement;
  motion: PresenceMotion;
}

/**
 * Mounted through its exit, closed by an outside press or Escape, and kept
 * placed against its trigger as the page scrolls or resizes. It closes if
 * the trigger scrolls out of view. On open, focus lands on the checked item,
 * or the first. Opening and closing turn around mid-flight (lib/morph).
 */
export function useFloatingPopover({ open, close, triggerRef, popoverRef, place, motion }: FloatingPopoverOptions) {
  const presence = usePresence(open, 300);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown: a press that cancels its compatibility
    // mouse events (the table's meter does) must still close the popover.
    function closeOnOutsidePress(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) closeRef.current();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      closeRef.current();
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, triggerRef, popoverRef]);

  useLayoutEffect(() => {
    if (!presence.mounted || presence.closing) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    function position() {
      if (!trigger || !popover) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        closeRef.current();
        return;
      }
      const { left, top, up } = place(rect, popover);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      // An attribute, not a class: React rewrites className on the closing render.
      popover.dataset.side = up ? "up" : "down";
      popover.style.visibility = "visible";
    }
    position();
    (popover.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? popover.querySelector<HTMLButtonElement>("button"))?.focus({
      preventScroll: true
    });
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    observer.observe(trigger);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
    // `place` is a module-level constant per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence.mounted, presence.closing, triggerRef, popoverRef]);

  usePresenceMorph(popoverRef, presence, motion);

  return presence;
}
