import { useEffect, useRef, type DependencyList, type RefObject } from "react";

/* Shared plumbing for the app's canvas-drawn surfaces (nav icons, the Today
   hero, the year heatmap, the task meter's dither). Each surface only says
   how to paint a frame; this module owns everything they used to repeat:

     - bitmap sizing at the device pixel ratio, following the canvas's CSS
       box (ResizeObserver) or a fixed size, and re-allocating on DPR change
     - an on-demand rAF loop: it runs while the painter reports motion (or a
       kick's keep-alive window is open) and stops when everything settles
     - pausing while the canvas is off screen or the tab is hidden, and
       resuming (or catching up on a missed repaint) when it comes back
     - repainting synchronously when the theme, ground or meter material
       changes, so a View Transition snapshot already carries the new colours

   The document-level observers are shared singletons, so thirty meters cost
   one MutationObserver, one IntersectionObserver and one ResizeObserver. */

export interface CanvasFrame {
  ctx: CanvasRenderingContext2D;
  /** Canvas size in CSS px. The context is pre-scaled, so draw in CSS px. */
  width: number;
  height: number;
  dpr: number;
  /** Timestamp in ms on the performance.now() clock. */
  now: number;
  /** Seconds since the previous frame of this run (≤ 1/30); 0 for out-of-band repaints. */
  dt: number;
}

export interface CanvasPainter {
  /** Paint one frame on a cleared canvas. Return true to request another. */
  draw(frame: CanvasFrame): boolean;
  /** The CSS box changed size; the next draw gets the new dimensions. */
  resize?(width: number, height: number): void;
  /** Theme, ground, meter material or colour scheme changed: re-read colours. */
  palette?(): void;
  dispose?(): void;
}

export interface CanvasLoop {
  /** Run at least one frame, and keep running for `ms` even when the painter is idle. */
  kick(ms?: number): void;
  /** Repaint right now (dt 0), then keep going if the painter asks to. */
  paint(): void;
  /** Live prefers-reduced-motion. */
  readonly reducedMotion: boolean;
}

export interface CanvasLoopOptions {
  /** Fixed CSS size. Omit to follow the canvas's CSS box. */
  size?: { width: number; height: number };
  /** Cap on the backing-store density (large canvases don't need 3x). */
  maxDpr?: number;
  /** After a palette change, keep drawing this long so CSS colour transitions are followed. */
  followPaletteMs?: number;
  /**
   * Drop the bitmap (width 0) whenever the loop goes idle, and skip idle
   * repaints. For CSS-sized overlays that are blank at rest — a list of them
   * would otherwise hold a full-size bitmap per row for nothing.
   */
  releaseWhenIdle?: boolean;
}

/* ---------- shared document observers --------------------------------- */

type Listener = () => void;

const paletteListeners = new Set<Listener>();
let paletteObserver: MutationObserver | null = null;
let schemeQuery: MediaQueryList | null = null;
const firePalette = () => paletteListeners.forEach((listener) => listener());

function onPalette(listener: Listener): () => void {
  if (paletteListeners.size === 0) {
    // data-* carry the theme / ground / meter material; class and style carry
    // the transition-freeze classes and the ground switch's circle variables.
    paletteObserver = new MutationObserver(firePalette);
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-bg", "data-meters", "class", "style"]
    });
    schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    schemeQuery.addEventListener("change", firePalette);
  }
  paletteListeners.add(listener);
  return () => {
    paletteListeners.delete(listener);
    if (paletteListeners.size === 0) {
      paletteObserver?.disconnect();
      schemeQuery?.removeEventListener("change", firePalette);
      paletteObserver = null;
      schemeQuery = null;
    }
  };
}

function sharedObserver<T extends ResizeObserverEntry | IntersectionObserverEntry>(
  create: (callback: (entries: T[]) => void) => { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void }
) {
  const callbacks = new Map<Element, (entry: T) => void>();
  let observer: ReturnType<typeof create> | null = null;
  return (el: Element, callback: (entry: T) => void) => {
    if (!observer) observer = create((entries) => entries.forEach((entry) => callbacks.get(entry.target)?.(entry)));
    callbacks.set(el, callback);
    observer.observe(el);
    return () => {
      callbacks.delete(el);
      observer?.unobserve(el);
      if (callbacks.size === 0) {
        observer?.disconnect();
        observer = null;
      }
    };
  };
}

const observeSize = sharedObserver<ResizeObserverEntry>((cb) => new ResizeObserver(cb));
// A small margin wakes a surface just before it scrolls in, so its first
// visible frame is already a live one.
const observeVisibility = sharedObserver<IntersectionObserverEntry>(
  (cb) => new IntersectionObserver(cb, { rootMargin: "96px" })
);

let reducedQuery: MediaQueryList | null = null;
const prefersReducedMotion = () => {
  reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedQuery.matches;
};

/* ---------- the loop -------------------------------------------------- */

export function startCanvasLoop(
  canvas: HTMLCanvasElement,
  setup: (loop: CanvasLoop, canvas: HTMLCanvasElement) => CanvasPainter,
  options: CanvasLoopOptions = {}
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => undefined;

  const idleRelease = options.releaseWhenIdle === true;
  let width = options.size?.width ?? 0;
  let height = options.size?.height ?? 0;
  let dpr = 1;
  let allocated = false;
  let frame = 0;
  let last = 0;
  let keepAliveUntil = 0;
  let wantsFrames = false; // the loop was running (or was asked to) when last left
  let dirty = false; // something changed while we were paused
  let onScreen = true; // corrected by the first IntersectionObserver callback
  let pageVisible = document.visibilityState !== "hidden";
  const visible = () => onScreen && pageVisible;

  if (!options.size) {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  }

  const allocate = () => {
    dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr ?? 3);
    const pw = Math.max(0, Math.round(width * dpr));
    const ph = Math.max(0, Math.round(height * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    allocated = true;
  };

  const release = () => {
    if (canvas.width !== 0) canvas.width = 0;
    if (canvas.height !== 0) canvas.height = 0;
    allocated = false;
  };

  const render = (now: number, dt: number) => {
    if (!allocated) allocate();
    if (canvas.width === 0 || canvas.height === 0) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    const more = painter.draw({ ctx, width, height, dpr, now, dt });
    ctx.restore();
    dirty = false;
    return more;
  };

  const tick = (now: number) => {
    frame = 0;
    const dt = last ? Math.min(1 / 30, (now - last) / 1000) : 1 / 60;
    last = now;
    if (render(now, dt) || now < keepAliveUntil) {
      wantsFrames = true;
      frame = requestAnimationFrame(tick);
    } else {
      wantsFrames = false;
      last = 0;
      if (idleRelease) release();
    }
  };

  const schedule = () => {
    if (!frame && visible()) frame = requestAnimationFrame(tick);
  };

  const pause = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  };

  const loop: CanvasLoop = {
    kick(ms = 0) {
      keepAliveUntil = Math.max(keepAliveUntil, performance.now() + ms);
      wantsFrames = true;
      if (visible()) schedule();
      else dirty = true;
    },
    paint() {
      if (idleRelease && !wantsFrames) return;
      if (!visible()) {
        dirty = true;
        return;
      }
      if (render(performance.now(), 0)) loop.kick();
    },
    get reducedMotion() {
      return prefersReducedMotion();
    }
  };

  // setup may kick, but must not paint synchronously: the painter doesn't exist yet.
  const painter = setup(loop, canvas);

  const resume = () => {
    if (wantsFrames) schedule();
    else if (dirty) loop.paint();
  };

  const stopSize = options.size
    ? () => undefined
    : observeSize(canvas, (entry) => {
        const { width: w, height: h } = entry.contentRect;
        if (w === width && h === height) return;
        width = w;
        height = h;
        allocated = false;
        painter.resize?.(w, h);
        // Re-allocating wipes the bitmap, and this callback runs after the
        // frame's rAF — waiting a frame would flash a blank canvas on every
        // step of a live window drag. Repaint synchronously instead.
        loop.paint();
      });

  const stopVisibility = observeVisibility(canvas, (entry) => {
    const was = visible();
    onScreen = entry.isIntersecting;
    if (was && !visible()) pause();
    else if (!was && visible()) resume();
  });

  const onPageVisibility = () => {
    const was = visible();
    pageVisible = document.visibilityState !== "hidden";
    if (was && !visible()) pause();
    else if (!was && visible()) resume();
  };
  document.addEventListener("visibilitychange", onPageVisibility);

  const stopPalette = onPalette(() => {
    painter.palette?.();
    loop.paint();
    if (options.followPaletteMs && !(idleRelease && !wantsFrames)) loop.kick(options.followPaletteMs);
  });

  // Pixel density changes (zoom, moving to another display) don't resize the box.
  const onWindowResize = () => {
    if (Math.min(window.devicePixelRatio || 1, options.maxDpr ?? 3) === dpr) return;
    allocated = false;
    loop.paint();
  };
  window.addEventListener("resize", onWindowResize);

  if (idleRelease) release();
  else loop.paint();

  return () => {
    pause();
    stopSize();
    stopVisibility();
    stopPalette();
    document.removeEventListener("visibilitychange", onPageVisibility);
    window.removeEventListener("resize", onWindowResize);
    painter.dispose?.();
  };
}

/**
 * React binding for startCanvasLoop. `setup` runs once per `deps` change and
 * returns the painter; keep per-canvas state in its closure and read live
 * props through refs. The returned ref exposes the loop for outside kicks.
 */
export function useCanvasLoop(
  ref: RefObject<HTMLCanvasElement>,
  setup: (loop: CanvasLoop, canvas: HTMLCanvasElement) => CanvasPainter,
  deps: DependencyList,
  options?: CanvasLoopOptions
): RefObject<CanvasLoop | null> {
  const loopRef = useRef<CanvasLoop | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const stop = startCanvasLoop(
      canvas,
      (loop, el) => {
        loopRef.current = loop;
        return setup(loop, el);
      },
      options
    );
    return () => {
      stop();
      loopRef.current = null;
    };
    // `setup` and `options` are read once per deps change by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return loopRef;
}

/* ---------- colour + shape helpers ------------------------------------ */

export type RGBA = [number, number, number, number];

let parser: CanvasRenderingContext2D | null = null;

/**
 * Resolve CSS colour expressions (custom properties, color-mix, anything the
 * cascade accepts) to RGBA, as seen from `scope`. A probe element takes each
 * value as its `color`, and a 1x1 canvas turns the computed colour into
 * bytes, so every serialisation the browser might produce is covered.
 */
export function resolveColors<K extends string>(scope: Element, exprs: Record<K, string>): Record<K, RGBA> {
  parser ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  scope.appendChild(probe);
  const out = {} as Record<K, RGBA>;
  for (const key of Object.keys(exprs) as K[]) {
    probe.style.color = "";
    probe.style.color = exprs[key];
    const computed = getComputedStyle(probe).color;
    let rgba: RGBA = [0, 0, 0, 0];
    if (parser) {
      parser.clearRect(0, 0, 1, 1);
      parser.fillStyle = "#000";
      parser.fillStyle = computed;
      parser.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = parser.getImageData(0, 0, 1, 1).data;
      rgba = [r, g, b, a / 255];
    }
    out[key] = rgba;
  }
  probe.remove();
  return out;
}

/** `color-mix(in srgb, a p, b)` — premultiplied, as CSS does it. */
export function mixColor(a: RGBA, b: RGBA, p: number): RGBA {
  const alpha = a[3] * p + b[3] * (1 - p);
  if (alpha <= 0) return [0, 0, 0, 0];
  const channel = (i: number) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

export const rgba = (c: RGBA, alpha = 1) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${c[3] * alpha})`;

export function roundRectPath(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D();
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
  return p;
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

/** Hermite smoothstep: 0 below a, 1 above b, eased in between. */
export function smoothstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Deterministic per-index random in [0,1): the same index always yields the same value. */
export function cellRandom(index: number, salt: number) {
  const s = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
