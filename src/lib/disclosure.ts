import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type TransitionEvent } from "react";
import { scrollParent } from "./listMotion";

/* A block that opens and closes in place: its panel mounts only while it is
   open (or on its way shut), and the page follows so the block stays in
   view. Two engines live here:

   - useSpringDisclosure (task cards): one spring drives the whole gesture —
     panel height, the line that folds away, the fields, the chevron and the
     page scroll all run on its clock. See the section at the bottom.
   - useDisclosure + keepInView (idea groups on the Next page): the panel's
     own `grid-template-rows` transition on `.is-open`, at --t-slow, with
     the page easing after it each frame. */

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

/* ---------- one clock: the spring (task cards) ------------------------- */

/* A task card opens and closes on a single clock. One spring drives its
   progress p from 0 (shut) to 1 (open), and every part of the gesture is a
   function of p: the panel's height, the summary line folding away, the
   page's scroll, and — through the block's `--disclose` property, so the
   look stays in CSS — the fields' fade and settle and the chevron. They
   start on the same frame and land on the same frame. (The page used to
   chase the card on its own clock and drift on for ~150ms after the card
   had stopped.)

   Heights are written explicitly each frame. This is a layout animation:
   the rows below and the page's own height have to move with it. A
   transform-only FLIP was tried and rejected — a close snapped the page
   height when it landed, which jumped the scroll near the bottom.

   A tap mid-flight retargets the spring from where it is AND how fast it is
   going, so the card turns around instead of starting a fresh tween, and
   the page, being a function of the same p, turns around with it. */

// The spring: the period it would swing at if undamped, and its damping
// ratio. Just under critical, so it arrives briskly; the ~0.15% overshoot
// that leaves is never drawn, as a leg lands the first time it gets there.
const RESPONSE_S = 0.3;
const DAMPING = 0.9;
const OMEGA = (2 * Math.PI) / RESPONSE_S;
const OMEGA_D = OMEGA * Math.sqrt(1 - DAMPING * DAMPING);
// Closer than this (progress, and progress per second) counts as landed,
// for a leg that creeps up on its target without crossing it.
const REST_X = 1e-4;
const REST_V = 1e-3;
// A leg that hasn't landed by now is landed anyway.
const MAX_LEG_MS = 1500;
// A touch that travels this far is a scroll, and the page is the user's
// again. A tap — the one that turns a card around mid-flight — is not.
const TOUCH_SLOP = 6;
// A press on a shut card mounts its panel ahead of the click, so the
// click's frame only has to start the motion. If the press ends and no
// click has opened it this long after, the panel goes again.
const WARM_MS = 400;
// Reduced motion: height and scroll change at once; what appears fades in.
const FADE_MS = 150;

/** One leg of the spring: let go at `start` (ms) from `from` with
 * `velocity` (progress per second), heading for `to`. */
export interface SpringLeg {
  start: number;
  from: number;
  velocity: number;
  to: number;
}

/** Where a leg is at `now`, and how fast it is going (per second). Closed
 * form, so it doesn't depend on the frame rate, and a retarget can pick up
 * the exact velocity. */
export function springAt(leg: SpringLeg, now: number): { x: number; v: number } {
  const t = Math.max(0, (now - leg.start) / 1000);
  const a = leg.from - leg.to;
  const b = (leg.velocity + DAMPING * OMEGA * a) / OMEGA_D;
  const decay = Math.exp(-DAMPING * OMEGA * t);
  const cos = Math.cos(OMEGA_D * t);
  const sin = Math.sin(OMEGA_D * t);
  return {
    x: leg.to + decay * (a * cos + b * sin),
    v: decay * ((b * OMEGA_D - DAMPING * OMEGA * a) * cos - (a * OMEGA_D + DAMPING * OMEGA * b) * sin)
  };
}

/** A leg lands the first time it reaches its target, so its overshoot is
 * never drawn, or once it is at rest there. */
export function springLanded(leg: SpringLeg, x: number, v: number): boolean {
  const gap = x - leg.to;
  return gap * (leg.from - leg.to) <= 0 || (Math.abs(gap) < REST_X && Math.abs(v) < REST_V);
}

/**
 * Where the page should be once a block has landed. An opening block near
 * the bottom carries the page up with it, never past its own top; a block
 * whose top has scrolled out of view brings the page back to it. `grow` is
 * how much taller the block will be by then (negative: shorter), `band` the
 * part of the view it should sit in, and `max` the furthest the page can
 * scroll after landing.
 */
export function landingScroll(
  block: { top: number; height: number },
  grow: number,
  band: { top: number; bottom: number },
  scrollTop: number,
  max: number
): number {
  const bottom = block.top + block.height + grow;
  let shift = 0;
  if (block.top < band.top) shift = block.top - band.top;
  else if (bottom > band.bottom) shift = Math.min(bottom - band.bottom, block.top - band.top);
  return Math.max(0, Math.min(max, scrollTop + shift));
}

export interface DisclosureParts {
  /** What stays in view. Carries `--disclose` (0 shut, 1 open) while moving. */
  block: RefObject<HTMLElement>;
  /** Grows from nothing to its (single) child's height. */
  panel: RefObject<HTMLElement>;
  /** A line that gives way as the panel opens, from its (single) child's
   * height to nothing. */
  fold?: RefObject<HTMLElement>;
}

/** What one flight (take-off to landing, through any turnarounds) holds. */
interface Flight {
  // The heights the panel and fold travel through, measured at take-off.
  panel: number;
  fold: number;
  // The page's scroll as a line in progress: scrollTop = base + slope · p.
  // Keeping one line for the whole flight is what lets a turnaround carry
  // the scroll's velocity too, and retrace it back to where it began.
  scroller: Element | null;
  base: number;
  slope: number;
  // Cleared when the user takes the page (touch-drag, wheel, any scroll
  // we didn't write); the scroll is then left alone until the next tap.
  following: boolean;
  written: number;
  touch: { x: number; y: number } | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Height of a part's one child: its natural height whatever the part's own
 * height is at the moment. */
function contentHeight(node: HTMLElement | null | undefined): number {
  const child = node?.firstElementChild;
  return child instanceof HTMLElement ? child.offsetHeight : 0;
}

class DisclosureMotion {
  progress: number;
  private leg: SpringLeg | null = null;
  private flight: Flight | null = null;
  private frame = 0;

  constructor(
    private readonly parts: DisclosureParts,
    open: boolean,
    private readonly onShut: () => void
  ) {
    this.progress = open ? 1 : 0;
  }

  get moving(): boolean {
    return this.leg !== null;
  }

  to(target: 0 | 1): void {
    if (!this.parts.block.current || !this.parts.panel.current) return;
    if (this.leg ? this.leg.to === target : this.progress === target) return;
    const now = performance.now();
    const { x, v } = this.leg ? springAt(this.leg, now) : { x: this.progress, v: 0 };
    const p = clamp01(x);

    if (!this.flight) {
      // Taking off from rest. The commit has already given the block its
      // new resting state; pin it back where the motion stands before
      // anything lays the page out, or a close near the bottom would let
      // the page clamp its scroll to the shorter page before the first frame.
      this.pin(p);
      this.flight = {
        panel: contentHeight(this.parts.panel.current),
        fold: contentHeight(this.parts.fold?.current),
        scroller: null,
        base: 0,
        slope: 0,
        following: false,
        written: 0,
        touch: null
      };
      this.plan(p, target);
    } else if (!this.flight.following) {
      this.plan(p, target);
    }

    if (reducedMotion()) {
      this.instant(target);
      return;
    }

    this.leg = { start: now, from: x, velocity: v, to: target };
    this.progress = p;
    this.paint(p);
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.leg = null;
    this.flight = null;
    this.unlisten();
  }

  private tick = (now: number) => {
    this.frame = 0;
    const leg = this.leg;
    if (!leg || !this.parts.panel.current) {
      this.land();
      return;
    }
    // Read before this frame's writes: a page the user (or anything else)
    // has scrolled since our last write is theirs now.
    this.checkScroll();
    const { x, v } = springAt(leg, now);
    const landed = springLanded(leg, x, v) || now - leg.start > MAX_LEG_MS;
    const p = landed ? leg.to : clamp01(x);
    this.progress = p;
    this.paint(p);
    this.follow(p);
    if (landed) this.land();
    else this.frame = requestAnimationFrame(this.tick);
  };

  /** Hold a resting state (0 or 1) without measuring anything. */
  private pin(p: number): void {
    const block = this.parts.block.current;
    const panel = this.parts.panel.current;
    const fold = this.parts.fold?.current;
    if (!block || !panel) return;
    block.style.setProperty("--disclose", String(p));
    panel.style.height = p ? "auto" : "0px";
    panel.style.overflow = "hidden";
    panel.style.visibility = "visible";
    if (fold) fold.style.height = p ? "0px" : "auto";
  }

  /** Draw progress `p`: the heights here, the rest in CSS from --disclose. */
  private paint(p: number): void {
    const flight = this.flight;
    const block = this.parts.block.current;
    const panel = this.parts.panel.current;
    const fold = this.parts.fold?.current;
    if (!flight || !block || !panel) return;
    block.style.setProperty("--disclose", p.toFixed(4));
    panel.style.height = `${flight.panel * p}px`;
    panel.style.overflow = "hidden";
    panel.style.visibility = "visible";
    if (fold) fold.style.height = `${flight.fold * (1 - p)}px`;
  }

  /** Lay the scroll's line for the rest of the flight, from where the block
   * is now (at progress `p`) to where it should be when it lands. */
  private plan(p: number, target: 0 | 1): void {
    const flight = this.flight!;
    const block = this.parts.block.current!;
    flight.slope = 0;
    flight.following = false;
    this.unlisten();
    const scroller = scrollParent(block);
    if (!scroller) return;
    const band = visibleBand(scroller);
    const rect = block.getBoundingClientRect();
    const grow = (flight.panel - flight.fold) * (target - p);
    const view = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight;
    const from = scroller.scrollTop;
    const end = landingScroll(
      { top: rect.top, height: rect.height },
      grow,
      { top: band.top + VIEW_MARGIN, bottom: band.bottom - VIEW_MARGIN },
      from,
      Math.max(0, scroller.scrollHeight + grow - view)
    );
    flight.scroller = scroller;
    flight.written = from;
    if (Math.abs(end - from) < 1) {
      flight.base = from;
      return;
    }
    flight.slope = (end - from) / (target - p);
    flight.base = from - flight.slope * p;
    flight.following = true;
    window.addEventListener("touchstart", this.onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", this.onTouchMove, { capture: true, passive: true });
    window.addEventListener("wheel", this.release, { capture: true, passive: true });
  }

  private follow(p: number): void {
    const flight = this.flight;
    if (!flight?.following || !flight.scroller) return;
    flight.scroller.scrollTop = Math.round(flight.base + flight.slope * p);
    flight.written = flight.scroller.scrollTop;
  }

  private checkScroll(): void {
    const flight = this.flight;
    if (flight?.following && flight.scroller && Math.abs(flight.scroller.scrollTop - flight.written) > 1) this.release();
  }

  private onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (this.flight && touch) this.flight.touch = { x: touch.clientX, y: touch.clientY };
  };

  private onTouchMove = (event: TouchEvent) => {
    const start = this.flight?.touch;
    const touch = event.touches[0];
    if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TOUCH_SLOP) this.release();
  };

  private release = () => {
    if (this.flight) this.flight.following = false;
    this.unlisten();
  };

  private unlisten(): void {
    window.removeEventListener("touchstart", this.onTouchStart, true);
    window.removeEventListener("touchmove", this.onTouchMove, true);
    window.removeEventListener("wheel", this.release, true);
  }

  /** Reduced motion: straight to the end, page included; what appears fades. */
  private instant(target: 0 | 1): void {
    const flight = this.flight!;
    const end = flight.following ? Math.round(flight.base + flight.slope * target) : null;
    const scroller = flight.scroller;
    this.leg = { start: 0, from: target, velocity: 0, to: target };
    this.progress = target;
    this.land();
    if (scroller && end !== null) scroller.scrollTop = end;
    const appearing = target === 1 ? this.parts.panel.current : this.parts.fold?.current;
    const content = appearing?.firstElementChild;
    if (content instanceof HTMLElement) content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
  }

  /** Hand back to the CSS resting state, which is exactly the last frame. */
  private land(): void {
    const target = this.leg?.to ?? this.progress;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.leg = null;
    this.flight = null;
    this.unlisten();
    this.parts.block.current?.style.removeProperty("--disclose");
    const panel = this.parts.panel.current;
    if (panel) {
      panel.style.height = "";
      panel.style.overflow = "";
      panel.style.visibility = "";
    }
    const fold = this.parts.fold?.current;
    if (fold) fold.style.height = "";
    if (target === 0) this.onShut();
  }
}

/**
 * A panel that opens and closes on one spring (see above). Render the panel
 * while `mounted`. Its resting states are CSS keyed off the block's open
 * class: shut is `height: 0; visibility: hidden`, open is `height: auto`,
 * and `--disclose` is 0 or 1; the motion writes over them only while it
 * runs. A block that starts out expanded mounts open, without motion.
 * `warm` (pointerdown on the toggle) mounts the panel shut ahead of the
 * click; `cool` (pointercancel, or the press turning into something else)
 * lets it go again.
 */
export function useSpringDisclosure(expanded: boolean, parts: DisclosureParts) {
  // Mounted though not expanded: on its way shut, or warmed for a tap.
  const [held, setHeld] = useState(false);
  // Closing keeps the panel through the motion. Decided during render, so
  // the commit that closes the block never drops the panel for a frame.
  const [wasExpanded, setWasExpanded] = useState(expanded);
  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    if (!expanded) setHeld(true);
  }
  const mounted = expanded || held;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const motionRef = useRef<DisclosureMotion | null>(null);
  if (!motionRef.current) {
    motionRef.current = new DisclosureMotion(parts, expanded, () => {
      if (!expandedRef.current) setHeld(false);
    });
  }
  const motion = motionRef.current;
  // A warmed panel waits for the press to end, then gives the click a
  // moment to arrive.
  const warmthRef = useRef<{ timer: number; release: (() => void) | null }>({ timer: 0, release: null });

  useLayoutEffect(() => {
    if (mounted) motion.to(expanded ? 1 : 0);
  }, [expanded, mounted, motion]);

  const disarm = useCallback(() => {
    const warmth = warmthRef.current;
    window.clearTimeout(warmth.timer);
    if (warmth.release) {
      window.removeEventListener("pointerup", warmth.release, true);
      window.removeEventListener("pointercancel", warmth.release, true);
      warmth.release = null;
    }
  }, []);

  useLayoutEffect(
    () => () => {
      motion.stop();
      disarm();
    },
    [motion, disarm]
  );

  const cool = useCallback(() => {
    disarm();
    if (!expandedRef.current && !motion.moving && motion.progress === 0) setHeld(false);
  }, [disarm, motion]);

  // The press ends wherever the pointer is let go, so listen on the window.
  // Arming the timer only then means a long press or drag is never cut
  // short under the user's finger.
  const warm = useCallback(() => {
    if (expandedRef.current) return;
    disarm();
    setHeld(true);
    const release = () => {
      disarm();
      warmthRef.current.timer = window.setTimeout(cool, WARM_MS);
    };
    warmthRef.current.release = release;
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }, [cool, disarm]);

  return { mounted, warm, cool };
}
