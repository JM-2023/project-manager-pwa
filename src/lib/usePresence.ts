import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Exit-animation presence for conditionally rendered elements. `open` is the
 * logical state; render while `mounted` and add a closing class while
 * `closing`, wired to the element's exit animation. Call `onExited` from
 * onAnimationEnd/onTransitionEnd to unmount when the exit finishes; a safety
 * timeout unmounts anyway if the event never arrives (reduced motion,
 * interrupted animations).
 */
export function usePresence(open: boolean, timeoutMs = 400): {
  mounted: boolean;
  closing: boolean;
  onExited: () => void;
} {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (open) {
      window.clearTimeout(timer.current);
      setMounted(true);
      return;
    }
    timer.current = window.setTimeout(() => setMounted(false), timeoutMs);
    return () => window.clearTimeout(timer.current);
  }, [open, timeoutMs]);

  const onExited = useCallback(() => {
    if (!open) {
      window.clearTimeout(timer.current);
      setMounted(false);
    }
  }, [open]);

  return { mounted, closing: mounted && !open, onExited };
}
