import { useEffect, useRef } from "react";

interface HeroPulseProps {
  /** Weighted percent 0-100: the water line the dot matrix is emitted from. */
  pct: number;
}

const CELL = 8; // css px per matrix cell (square + gap)
const DOT = 6; // filled square size within a cell
const PERIOD = 2.4; // seconds for one pulse crest to cross the track
const BANDS = 2; // concurrent crests, phase-staggered so the pulse never gaps
const SIGMA = 0.11; // crest half-width in u-space (0..1 across the tail)

/**
 * Dot-matrix pulse over the hero's unfilled track: a green/white take on the
 * ultra "thinking" particles. The green liquid flows continuously past the fill
 * edge (the tail starts at the fill's end-green and fades to transparent by
 * 100%) so the two layers read as one body of water. Over it a grid of small
 * white squares does two things at once: a dim, random per-cell twinkle for a
 * live shimmer, and layered on top, bright Gaussian crests that emit from the
 * water line, sweep rightward, and dim as they travel (a visible left-to-right
 * pulse). A soft glow at the water line hides the fill/tail seam.
 *
 * Rendered on a canvas because a genuinely random shimmer plus travelling crests
 * can't be expressed with tiled CSS backgrounds.
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
        // Continuous green tail starts at the fill's end-green and fades to
        // transparent by 100%, so the fill and this layer merge into one body.
        const grad = ctx.createLinearGradient(pctX, 0, W, 0);
        grad.addColorStop(0, "rgba(6, 150, 105, 0.5)");
        grad.addColorStop(0.5, "rgba(16, 185, 129, 0.14)");
        grad.addColorStop(1, "rgba(16, 185, 129, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(pctX, 0, tail, H);

        // Soft glow straddling the water line, hiding the fill/tail seam.
        const glow = ctx.createLinearGradient(pctX - 12, 0, pctX + 26, 0);
        glow.addColorStop(0, "rgba(214, 255, 235, 0)");
        glow.addColorStop(0.4, "rgba(214, 255, 235, 0.45)");
        glow.addColorStop(1, "rgba(214, 255, 235, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(pctX - 12, 0, 38, H);

        // Positions (in u-space) of the travelling pulse crests this frame.
        const crests: number[] = [];
        for (let k = 0; k < BANDS; k += 1) {
          const p = t / PERIOD + k / BANDS;
          crests.push(p - Math.floor(p));
        }

        for (let cx = 0; cx < cols; cx += 1) {
          const x = cx * CELL;
          if (x < pctX - CELL || x > W) continue;
          const u = (x - pctX) / tail; // 0 at the water line, 1 at 100%
          if (u > 1) continue;
          const env = Math.max(0, 1 - u); // fades everything out toward the end

          // Travelling pulse: bright where a crest currently sits; each crest
          // dims as it advances (1 - p), so the wave fades before reaching 100%.
          let pulse = 0;
          for (let k = 0; k < BANDS; k += 1) {
            const d = u - crests[k];
            pulse += Math.exp(-(d * d) / (2 * SIGMA * SIGMA)) * (1 - crests[k]);
          }
          if (pulse > 1) pulse = 1;

          for (let cy = 0; cy < rows; cy += 1) {
            const idx = cx * rows + cy;
            const tw = 0.5 + 0.5 * Math.sin(t * speeds[idx] + seeds[idx]);
            // Dim ambient shimmer + the bright pulse crest, both kept pixelated
            // by the per-cell random bias so the wave front scatters.
            const ambient = 0.2 * (0.4 + 0.6 * bias[idx]) * tw;
            const crest = pulse * (0.35 + 0.65 * bias[idx]) * (0.55 + 0.45 * tw);
            const a = env * (ambient + 0.95 * crest);
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
