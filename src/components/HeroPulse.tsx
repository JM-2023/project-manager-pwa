import { useEffect, useRef } from "react";

interface HeroPulseProps {
  /** Weighted percent 0-100: the water line the dot matrix is emitted from. */
  pct: number;
}

const CELL = 8; // css px per matrix cell (square + gap)
const DOT = 6; // filled square size within a cell
const WAVELENGTH = 380; // px between travelling ripple crests (wide, gentle swells)
const FLOW = 0.5; // ripple crests advanced per second (rightward flow speed)
const SHARP = 1; // crest sharpness: 1 = pure sinusoid, broadest & smoothest band

/** Hermite smoothstep: 0 below a, 1 above b, eased in between. */
function smoothstep(a: number, b: number, x: number) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * The whole weighted-progress hero fill, drawn on one canvas so the solid green
 * and the dot-matrix are a single object rather than two layers meeting at a
 * seam. In one continuous render it draws: (1) a green body gradient: solid at
 * the left, strongest at the water line, fading to transparent by 100%; (2) a
 * dissolving grid of small squares that emerges around the water line, is green
 * (blending into the fill) near it and turns white as it scatters right, lit by a
 * continuous travelling wave of ripple-bands that flow left-to-right out of the
 * water line and fade before 100%; (3) a glass sheen composited source-atop so it
 * only lands on the liquid. A green-to-white gradient runs through the middle, so
 * there is no boundary between "fill" and "particles".
 *
 * On a canvas because the random shimmer, travelling crests and per-pixel
 * dissolve can't be expressed with CSS/tiled backgrounds.
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

    // Eased, displayed percent so the fill grows smoothly when the data changes
    // (replaces the CSS width transition the old fill element used to have).
    let renderPct = Math.min(Math.max(pctRef.current, 0), 100);

    const draw = (tms: number) => {
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

      // 2) Dissolving dot matrix that flows left-to-right like water. A continuous
      //    travelling wave of vertical ripple-bands scrolls rightward out of the
      //    water line so the direction is always legible, while the solid green
      //    disintegrates into pixels that whiten and fade before 100%.
      if (tail > 2) {
        for (let cx = 0; cx < cols; cx += 1) {
          const x = cx * CELL;
          const u = (x - pctX) / tail; // <0 inside the fill, 1 at 100%
          if (u < -0.12 || u > 1) continue;
          const env = u < 0 ? 1 : Math.max(0, 1 - u); // overall fade toward 100%
          const emerge = smoothstep(0, 0.22, u); // ambient bed hidden at the line
          const cov = Math.min(Math.max(1.15 - u * 1.7, 0), 1); // dissolve density
          const white = smoothstep(0.04, 0.5, u); // green near fill -> white out

          // Travelling ripple: subtracting t * FLOW moves the crests in +x over
          // time; SHARP narrows them into distinct bands with gaps so the flow
          // direction reads clearly.
          const phase = (x - pctX) / WAVELENGTH - t * FLOW;
          const band = Math.pow(0.5 + 0.5 * Math.cos(phase * Math.PI * 2), SHARP);
          const bandEmerge = smoothstep(0, 0.1, u); // bands swell in from the line

          for (let cy = 0; cy < rows; cy += 1) {
            const idx = cx * rows + cy;
            const tw = 0.5 + 0.5 * Math.sin(t * speeds[idx] + seeds[idx]);
            const on = bias[idx] < cov ? 1 : 0;
            const ambient = on * (0.4 + 0.6 * tw) * emerge; // faint live bed
            const crest = band * bandEmerge * (0.35 + 0.65 * bias[idx]);
            const level = env * (ambient * 0.32 + crest * 0.6);
            if (level <= 0.03) continue;
            // Whiter toward the right and at the ripple crests.
            const wp = Math.min(white + band * 0.26, 1);
            const r = Math.round(150 + 105 * wp);
            const g = Math.round(232 + 23 * wp);
            const b = Math.round(198 + 57 * wp);
            let a = level * (0.5 + 0.5 * bias[idx]);
            if (a > 1) a = 1;
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
