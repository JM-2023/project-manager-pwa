import { useEffect, useRef } from "react";

interface HeroPulseProps {
  /** Weighted percent 0-100: the water line the dot matrix is emitted from. */
  pct: number;
}

const CELL = 8; // css px per matrix cell (square + gap)
const DOT = 6; // filled square size within a cell
const PERIOD = 2.4; // seconds for one pulse crest to cross the track
const BANDS = 2; // concurrent crests, phase-staggered so the pulse never gaps
const SIGMA = 0.12; // crest half-width in u-space (0..1 across the tail)

/** Hermite smoothstep: 0 below a, 1 above b, eased in between. */
function smoothstep(a: number, b: number, x: number) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

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
      cols = Math.ceil(W / CELL) + 3; // +3 covers the 2-cell overlap start
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
        // Smooth green bed: continuous with the fill, fading to transparent by
        // 100%. This is the base the pixels dissolve out of.
        const grad = ctx.createLinearGradient(pctX, 0, W, 0);
        grad.addColorStop(0, "rgba(6, 150, 105, 0.52)");
        grad.addColorStop(0.45, "rgba(16, 185, 129, 0.16)");
        grad.addColorStop(1, "rgba(16, 185, 129, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(pctX, 0, tail, H);

        // Positions (in u-space) of the travelling pulse crests this frame.
        const crests: number[] = [];
        for (let k = 0; k < BANDS; k += 1) {
          const p = t / PERIOD + k / BANDS;
          crests.push(p - Math.floor(p));
        }

        // Start a couple of cells inside the fill so the pixels grow out of the
        // solid green instead of switching on at a hard edge.
        const startX = pctX - 2 * CELL;
        for (let cx = 0; cx < cols; cx += 1) {
          const x = startX + cx * CELL;
          if (x > W) break;
          const u = (x - pctX) / tail; // <0 inside the fill, 1 at 100%
          if (u > 1) continue;
          const env = u < 0 ? 1 : Math.max(0, 1 - u); // overall fade toward 100%
          // Dissolve: fully covered at the water line, scattering to nothing.
          const cov = Math.min(Math.max(1.2 - u * 1.85, 0), 1);
          // Cells are green (blend into the fill) near the edge, turning white
          // as they scatter outward.
          const white = smoothstep(0.05, 0.5, u);

          // Travelling pulse: bright where a crest sits; each crest dims as it
          // advances (1 - p), so the wave fades before it reaches 100%.
          let pulse = 0;
          for (let k = 0; k < BANDS; k += 1) {
            const d = u - crests[k];
            pulse += Math.exp(-(d * d) / (2 * SIGMA * SIGMA)) * (1 - crests[k]);
          }
          if (pulse > 1) pulse = 1;

          for (let cy = 0; cy < rows; cy += 1) {
            const idx = cx * rows + cy;
            const tw = 0.5 + 0.5 * Math.sin(t * speeds[idx] + seeds[idx]);
            const on = bias[idx] < cov ? 1 : 0; // dissolve mask (ambient bed)
            const ambient = on * (0.45 + 0.55 * tw);
            const crestLevel = pulse * (0.5 + 0.5 * tw); // crest lights any cell
            const level = env * (ambient * 0.6 + crestLevel);
            if (level <= 0.03) continue;
            // Whiter toward the right and wherever a crest currently sits.
            const wp = Math.min(white + pulse * 0.55, 1);
            const r = Math.round(150 + 105 * wp);
            const g = Math.round(232 + 23 * wp);
            const b = Math.round(198 + 57 * wp);
            let a = level * (0.55 + 0.45 * bias[idx]);
            if (a > 1) a = 1;
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
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
