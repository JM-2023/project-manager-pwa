import { useLayoutEffect, type RefObject } from "react";

/* The navigation's selection pill (visible on the Prussian palette): when the
   tab changes it travels to the new button as a piece of elastic material
   rather than a rigid block. Its two ends ride separate springs — the leading
   edge is stiff and leaves first, the trailing edge is softer and a beat
   late — so the pill stretches toward its target, thins across the travel
   axis while stretched (volume is roughly kept), then the ends overshoot,
   squash and settle.

   The motion is simulated once per change and played as Web Animations
   keyframes, so it does not depend on a live rAF loop and an interrupted
   slide simply restarts from wherever the pill currently is. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edge {
  x: number;
  v: number;
  target: number;
  k: number;
  c: number;
  delay: number;
}

const STEP = 1 / 60;
const MAX_STEPS = 90; // 1.5s hard cap
const LEAD = { k: 620, c: 32 }; // ζ ≈ 0.64: a visible overshoot
const TRAIL = { k: 300, c: 25, delay: 0.035 }; // ζ ≈ 0.72, leaves a beat late
const MAX_THIN = 0.26; // cross-axis shrink at full stretch
const MAX_BULGE = 0.12; // cross-axis swell when squashed

function stepEdge(edge: Edge, t: number): void {
  if (t < edge.delay) return;
  edge.v += (edge.k * (edge.target - edge.x) - edge.c * edge.v) * STEP;
  edge.x += edge.v * STEP;
}

const settled = (edge: Edge) => Math.abs(edge.target - edge.x) < 0.25 && Math.abs(edge.v) < 2;

export interface SlideOptions {
  /** Longest the travelling box may grow past its rest length (px). Long
      jumps otherwise let the lead edge run hundreds of px ahead. */
  maxStretch?: number;
  /** Scales the cross-axis thin/bulge — wide boxes read it much larger. */
  crossScale?: number;
}

/**
 * Keyframes (in px) for the pill travelling from `from` to `to`. The travel
 * axis is whichever the move is mostly along — the rail is vertical on wide
 * screens and the dock horizontal on phones.
 */
export function buildSlideKeyframes(from: Box, to: Box, options: SlideOptions = {}): Box[] {
  const { maxStretch = Infinity, crossScale = 1 } = options;
  const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
  const pos = vertical ? "y" : "x";
  const size = vertical ? "h" : "w";
  const crossPos = vertical ? "x" : "y";
  const crossSize = vertical ? "w" : "h";

  const forward = to[pos] >= from[pos];
  const startEdge = (b: Box) => b[pos];
  const endEdge = (b: Box) => b[pos] + b[size];
  const leadOf = forward ? endEdge : startEdge;
  const trailOf = forward ? startEdge : endEdge;

  const lead: Edge = { x: leadOf(from), v: 0, target: leadOf(to), ...LEAD, delay: 0 };
  const trail: Edge = { x: trailOf(from), v: 0, target: trailOf(to), ...TRAIL };

  const frames: Box[] = [{ ...from }];
  for (let i = 1; i <= MAX_STEPS; i++) {
    const t = i * STEP;
    stepEdge(lead, t);
    stepEdge(trail, t);

    // Rest length eases from the old box's to the new one's with progress.
    const travel = Math.abs(leadOf(to) - leadOf(from)) || 1;
    const progress = Math.min(1, Math.max(0, 1 - Math.abs(lead.target - lead.x) / travel));
    const restLength = from[size] + (to[size] - from[size]) * progress;
    const restCross = from[crossSize] + (to[crossSize] - from[crossSize]) * progress;
    const restCrossPos = from[crossPos] + (to[crossPos] - from[crossPos]) * progress;

    // Past the cap the trailing edge is towed by the lead instead of lagging.
    const maxLength = restLength + maxStretch;
    if (Math.abs(lead.x - trail.x) > maxLength) {
      trail.x = lead.x + (forward ? -maxLength : maxLength);
      trail.v = lead.v;
    }

    const lo = Math.min(lead.x, trail.x);
    const hi = Math.max(lead.x, trail.x);
    const length = hi - lo;

    const ratio = length / Math.max(1, restLength);
    const cross =
      ratio >= 1
        ? restCross * (1 - Math.min(MAX_THIN, (ratio - 1) * 0.3) * crossScale)
        : restCross * (1 + Math.min(MAX_BULGE, (1 - ratio) * 0.6) * crossScale);

    const frame = { ...to };
    frame[pos] = lo;
    frame[size] = length;
    frame[crossSize] = cross;
    frame[crossPos] = restCrossPos + (restCross - cross) / 2;
    frames.push(frame);

    if (settled(lead) && settled(trail)) break;
  }
  frames.push({ ...to });
  return frames;
}

export const SLIDE_FRAME_MS = STEP * 1000;

export function boxOf(el: HTMLElement): Box {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

/** Where the element is drawn right now — mid-animation included. */
export function currentBox(el: HTMLElement): Box {
  const style = getComputedStyle(el);
  return {
    x: parseFloat(style.left) || 0,
    y: parseFloat(style.top) || 0,
    w: parseFloat(style.width) || 0,
    h: parseFloat(style.height) || 0
  };
}

export function place(el: HTMLElement, box: Box): void {
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
}

export const px =(box: Box) => ({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });

/**
 * Keep `indicatorRef` sitting on the container's `[aria-current="page"]`
 * child, springing over on every `activeKey` change. Layout changes (the
 * rail ↔ dock breakpoint, safe-area or font changes) re-seat it instantly.
 */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement>,
  indicatorRef: RefObject<HTMLElement>,
  activeKey: string
): void {
  // Seat on mount and follow layout changes without animating.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const seat = () => {
      const active = container.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      indicator.getAnimations().forEach((animation) => animation.cancel());
      place(indicator, boxOf(active));
    };
    seat();
    const observer = new ResizeObserver(seat);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, indicatorRef]);

  // Spring to the new tab.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const active = container.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const to = boxOf(active);
    // Mid-flight, start from where the pill is drawn right now.
    const from = currentBox(indicator);
    indicator.getAnimations().forEach((animation) => animation.cancel());
    place(indicator, to);

    const moved = Math.abs(from.x - to.x) > 0.5 || Math.abs(from.y - to.y) > 0.5;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!moved || reduced || typeof indicator.animate !== "function") return;

    const frames = buildSlideKeyframes(from, to);
    indicator.animate(frames.map(px), { duration: (frames.length - 1) * SLIDE_FRAME_MS, easing: "linear" });
  }, [containerRef, indicatorRef, activeKey]);
}
