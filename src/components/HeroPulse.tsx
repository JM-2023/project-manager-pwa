import { useEffect, useRef } from "react";

interface HeroPulseProps {
  /** Weighted percent 0-100: the water line the dot matrix is emitted from. */
  pct: number;
}

const CELL = 8; // css px per matrix cell (square + gap)
const DOT = 6; // filled square size within a cell

/**
 * Dot-matrix pulse over the hero's unfilled track. From the fill's right edge
 * (the water line) a faint green gradient runs to 100%, fading out; over it a
 * grid of small white squares twinkles continuously and at random, brightest at
 * the edge and dissolving before it reaches the end, like a pixelated wake.
 *
 * Rendered on a canvas because a genuinely random, non-repeating per-cell
 * shimmer can't be expressed with tiled CSS backgrounds.
 */
export function HeroPulse({ pct }: HeroPulseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read the live percent inside the animation loop without re-seeding on change.
  const pctRef = useRef(pct);
  pctRef.current = pct;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let W = 0;
    let H = 0;
    let cols = 0;
    let rows = 0;
    // Per-cell random phase / speed / base brightness — the source of the
    // irregular, continuous (non-marching) twinkle.
    let seeds = new Float32Array(0);
    let speeds = new Float32Array(0);
    let bias = new Float32Array(0);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / CELL) + 1;
      rows = Math.ceil(H / CELL) + 1;
      const n = cols * rows;
      seeds = new Float32Array(n);
      speeds = new Float32Array(n);
      bias = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        seeds[i] = Math.random() * Math.PI * 2;
        speeds[i] = 1.2 + Math.random() * 2.8;
        bias[i] = Math.random();
      }
    };

    const draw = (tms: number) => {
      const t = tms / 1000;
      ctx.clearRect(0, 0, W, H);
      const pctX = (Math.min(Math.max(pctRef.current, 0), 100) / 100) * W;
      const tail = W - pctX;
      if (tail > 2) {
        // Green gradient tail: green at the water line, transparent at 100%.
        const grad = ctx.createLinearGradient(pctX, 0, W, 0);
        grad.addColorStop(0, "rgba(16, 185, 129, 0.30)");
        grad.addColorStop(1, "rgba(16, 185, 129, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(pctX, 0, tail, H);

        for (let cx = 0; cx < cols; cx += 1) {
          const x = cx * CELL;
          if (x < pctX - CELL || x > W) continue;
          const u = (x - pctX) / tail; // 0 at the water line, 1 at 100%
          if (u > 1) continue;
          const env = Math.max(0, 1 - u); // fades the pulse out toward the end
          for (let cy = 0; cy < rows; cy += 1) {
            const idx = cx * rows + cy;
            // Random per-cell twinkle; the -u*7 phase term makes crests drift
            // rightward, so the shimmer reads as travelling from the edge.
            const tw = 0.5 + 0.5 * Math.sin(t * speeds[idx] + seeds[idx] - u * 7);
            const a = env * (0.1 + 0.9 * tw) * (0.35 + 0.65 * bias[idx]);
            if (a < 0.035) continue;
            ctx.fillStyle = `rgba(255, 255, 255, ${a > 1 ? 1 : a})`;
            ctx.fillRect(x, cy * CELL, DOT, DOT);
          }
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(canvas);
    if (reduce) draw(0);
    else raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="summary-hero__matrix" aria-hidden="true" />;
}
