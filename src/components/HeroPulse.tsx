import { useEffect, useRef } from "react";
import { useHeroAnimation } from "../lib/heroAnimation";

interface HeroPulseProps {
  /** Weighted percent 0-100: the water line the dot matrix is emitted from. */
  pct: number;
}

const CELL = 8; // css px per matrix cell (square + gap)
const DOT = 6; // filled square size within a cell
const OVERLAP = 72; // px the mosaic dithers in over the solid fill (no seam)
const DRIFT = 20; // px per second the dot field glides rightward in "flow" mode

/** Hermite smoothstep: 0 below a, 1 above b, eased in between. */
function smoothstep(a: number, b: number, x: number) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Deterministic per-cell random in [0,1): the same index always yields the
 * same value, so a resize re-derives the identical field instead of
 * reshuffling every dot (which read as the whole bar strobing). */
function cellRandom(index: number, salt: number) {
  const s = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The whole weighted-progress hero fill, drawn on one canvas so the solid green
 * and the dot-matrix are a single object rather than two layers meeting at a
 * seam. In one continuous render it draws: (1) a green body gradient: solid at
 * the left, strongest at the water line, fading to transparent by 100%; (2) a
 * dense shimmering mosaic of small squares that overlays the last stretch of
 * the fill — mixed lighter/darker green tints there, so the solid fill visibly
 * dissolves into pixels — then scatters, whitens and fades out well before
 * 100%. Each cell breathes in and out at its own random pace — the sparkling
 * dither of the effort-slider effect. In the "flow" animation preference the
 * whole dot field also glides rightward, so pixels visibly swim out of the
 * fill, whiten and dissolve as they travel; in "shimmer" the field twinkles
 * in place; (3) a glass sheen composited source-atop so it only lands
 * on the liquid. A green-to-white gradient runs through the middle, so there
 * is no boundary between "fill" and "particles".
 *
 * On a canvas because the per-cell random shimmer and per-pixel dissolve can't
 * be expressed with CSS/tiled backgrounds.
 */
export function HeroPulse({ pct }: HeroPulseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [anim] = useHeroAnimation();
  // Read the live percent / animation mode inside the animation loop without
  // re-seeding the random field on change.
  const pctRef = useRef(pct);
  pctRef.current = pct;
  const animRef = useRef(anim);
  animRef.current = anim;

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
    // Per-cell random phase / speed / base brightness: the source of the
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
        seeds[i] = cellRandom(i, 1) * Math.PI * 2;
        speeds[i] = 1.5 + cellRandom(i, 2) * 3.5;
        bias[i] = cellRandom(i, 3);
      }
    };

    // Eased, displayed percent so the fill grows smoothly when the data changes
    // (replaces the CSS width transition the old fill element used to have).
    let renderPct = Math.min(Math.max(pctRef.current, 0), 100);

    const render = (tms: number) => {
      const t = tms / 1000;
      const target = Math.min(Math.max(pctRef.current, 0), 100);
      renderPct += (target - renderPct) * (reduce ? 1 : 0.1);
      if (Math.abs(target - renderPct) < 0.05) renderPct = target;

      ctx.clearRect(0, 0, W, H);
      const pctX = (renderPct / 100) * W;
      const tail = W - pctX;

      // 1) One continuous green body across the whole bar: solid at the left,
      //    strongest at the water line, fading to transparent by 100%. Drawing
      //    the fill here (rather than as a separate CSS element) is what makes
      //    the fill and the pixels a single object with a gradient between them.
      const f = Math.min(Math.max(pctX / W, 0.0001), 0.9999);
      const body = ctx.createLinearGradient(0, 0, W, 0);
      body.addColorStop(0, "rgba(16, 180, 120, 0.34)");
      body.addColorStop(f * 0.55, "rgba(11, 168, 116, 0.56)");
      body.addColorStop(f, "rgba(4, 146, 100, 0.72)");
      body.addColorStop(Math.min(1, f + (1 - f) * 0.42), "rgba(16, 185, 129, 0.14)");
      body.addColorStop(1, "rgba(16, 185, 129, 0)");
      ctx.fillStyle = body;
      ctx.fillRect(0, 0, W, H);

      // 2) Shimmering dot mosaic. A dense grid of squares rides over the last
      //    OVERLAP px of the fill — mixed light/dark green tints there, the
      //    dither look — then thins out, whitens and fades before 100%. Each
      //    square breathes at its own random pace, and the whole field glides
      //    rightward at DRIFT px/s: the sub-cell offset `frac` slides the grid
      //    smoothly while `shiftC` re-bases which random column each screen
      //    column samples, so a dot keeps its identity (tone, twinkle phase)
      //    as it swims out of the fill toward 100%.
      if (tail > 2) {
        const drift = animRef.current === "flow" ? t * DRIFT : 0;
        const shiftC = Math.floor(drift / CELL);
        const frac = drift - shiftC * CELL;
        for (let cx = -1; cx < cols; cx += 1) {
          const x = cx * CELL + frac;
          const d = x - pctX; // px past the water line, <0 over the fill
          if (d < -OVERLAP) continue;
          const u = d / tail; // 0 at the water line, 1 at 100%
          if (u > 1) continue;
          const env = u <= 0 ? 1 : 1 - u; // overall fade toward 100%
          // Coverage combines both fronts of the dither: it ramps 0 -> 1 over
          // the fill (sparse dots first, then a full mosaic — the effort-slider
          // ramp) and back down past the line as the pixels dissolve away.
          const covIn = smoothstep(-OVERLAP, -4, d);
          const covOut = Math.min(Math.max(1.15 - u * 1.55, 0), 1);
          const cov = covIn * covOut;
          const white = smoothstep(0.05, 0.55, u); // green near fill -> white out
          if (cov <= 0) continue;
          const fc = (((cx - shiftC) % cols) + cols) % cols; // wrapped field column

          for (let cy = 0; cy < rows; cy += 1) {
            const idx = fc * rows + cy;
            const gap = cov - bias[idx];
            if (gap <= 0) continue; // this cell hasn't emerged / has dissolved
            // Squared sine keeps cells dim most of the time with smooth bright
            // blinks — sparkle rather than uniform throb.
            const tw = 0.5 + 0.5 * Math.sin(t * speeds[idx] + seeds[idx]);
            // Cells near the coverage front ease in instead of popping.
            const edge = smoothstep(0, 0.12, gap);
            const a = env * edge * (0.3 + 0.62 * tw * tw);
            if (a <= 0.03) continue;
            // Cell tone: low-bias cells are the light ones (they also survive
            // the dissolve longest, so the far scattered dots read pale), high
            // bias cells the dark ones; everything whitens toward the right.
            const L = Math.min(0.12 + (1 - bias[idx]) * 0.8 + white, 1);
            const r = Math.round(8 + 244 * L);
            const g = Math.round(120 + 135 * L);
            const b = Math.round(84 + 166 * L);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(x, cy * CELL, DOT, DOT);
          }
        }
      }

      // 3) Glass sheen: composited source-atop so it lands only on the liquid
      //    (green + pixels), following its shape and alpha, so there is no seam.
      ctx.globalCompositeOperation = "source-atop";
      const sheen = ctx.createLinearGradient(0, 0, 0, H);
      sheen.addColorStop(0, "rgba(255, 255, 255, 0.42)");
      sheen.addColorStop(0.45, "rgba(255, 255, 255, 0.05)");
      sheen.addColorStop(0.8, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, W, H);
      const shade = ctx.createLinearGradient(0, H * 0.45, 0, H);
      shade.addColorStop(0, "rgba(3, 60, 40, 0)");
      shade.addColorStop(1, "rgba(3, 60, 40, 0.42)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    };

    const loop = (tms: number) => {
      render(tms);
      raf = requestAnimationFrame(loop);
    };

    resize();
    // Setting canvas.width wipes the bitmap, and in the frame pipeline the
    // ResizeObserver callback runs after this frame's rAF — waiting for the
    // next one would paint a blank frame on every step of a live window
    // drag. Repainting synchronously here keeps the fill continuous.
    const ro = new ResizeObserver(() => {
      resize();
      render(performance.now());
    });
    ro.observe(canvas);
    if (reduce) render(performance.now());
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="summary-hero__matrix" aria-hidden="true" />;
}
