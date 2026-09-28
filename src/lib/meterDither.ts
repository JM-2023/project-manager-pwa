import type { RefObject } from "react";
import { cellRandom, clamp01, smoothstep, useCanvasLoop, type CanvasLoop } from "./canvasLoop";

/* The task meter's motion texture. The track and fill stay CSS (they wear
   the shared --mtr-* material, so the glass/flat switch keeps moving every
   meter together); this canvas only adds what CSS can't: while the fill is
   moving, its edge breaks into the Today hero's dot matrix — pale pixels
   shimmering in over the last stretch of the fill, tone-coloured ones
   scattering past the edge, further the faster it moves — and the pixels
   dissolve back into a clean edge once it settles. At rest nothing is drawn
   and the bitmap is released, so a long task list costs nothing. */

const CELL = 3; // css px per dot cell (dot + gap)
const DOT = 2;
const OVERLAP = 14; // px the dither reaches back over the fill
const REACH = 8; // px past the edge at a crawl…
const REACH_FAST = 30; // …plus this much at full speed
const FULL_SPEED = 150; // %/s that counts as full energy
const WAKE = 20; // energy rises fast…
const SETTLE = 4; // …and settles slowly, so the pixels linger a beat

function parseRgb(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b];
}

/**
 * Drive the dither canvas from the meter's displayed percent. Call `kick()`
 * on the returned loop whenever that value is repainted.
 */
export function useMeterDither(
  canvasRef: RefObject<HTMLCanvasElement>,
  valueRef: RefObject<number>
): RefObject<CanvasLoop | null> {
  return useCanvasLoop(
    canvasRef,
    (loop, canvas) => {
      let last = valueRef.current ?? 0;
      let energy = 0;
      return {
        draw({ ctx, width: W, height: H, dpr, now, dt }) {
          const value = valueRef.current ?? 0;
          if (dt > 0) {
            const speed = Math.abs(value - last) / dt;
            last = value;
            const target = clamp01(speed / FULL_SPEED);
            energy += (target - energy) * (1 - Math.exp(-(target > energy ? WAKE : SETTLE) * dt));
          }
          if (loop.reducedMotion) energy = 0;
          // Below this no dot clears the alpha floor below, so stop (and release).
          if (energy < 0.03) return false;

          // Tone from CSS (the row's .tone-* sets --prog-color on the canvas).
          const [tr, tg, tb] = parseRgb(getComputedStyle(canvas).color);
          const edgeX = (clamp01(value / 100)) * W;
          const reach = REACH + REACH_FAST * energy;
          const rows = Math.max(1, Math.floor((H + CELL - DOT) / CELL));
          const top = (H - (rows * CELL - (CELL - DOT))) / 2;
          const snap = (v: number) => Math.round(v * dpr) / dpr;
          const t = now / 1000;

          const first = Math.max(0, Math.floor((edgeX - OVERLAP) / CELL));
          const lastCol = Math.min(Math.ceil(W / CELL), Math.ceil((edgeX + reach) / CELL));
          for (let c = first; c <= lastCol; c += 1) {
            const x = c * CELL;
            const d = x + DOT / 2 - edgeX; // <0 over the fill
            const u = d / reach; // 0 at the edge, 1 at full reach
            const cov = smoothstep(-OVERLAP, -1, d) * clamp01(1.1 - Math.max(0, u) * 1.3);
            if (cov <= 0) continue;
            for (let r = 0; r < rows; r += 1) {
              const index = c * rows + r;
              const gap = cov - cellRandom(index, 11);
              if (gap <= 0) continue;
              const tw = 0.5 + 0.5 * Math.sin(t * (2 + cellRandom(index, 12) * 4) + cellRandom(index, 13) * Math.PI * 2);
              let a = energy * smoothstep(0, 0.15, gap) * (0.35 + 0.65 * tw * tw);
              // Over the fill the pixels are pale sparkle; past the edge they
              // carry the tone and thin out toward the reach.
              const lift = d < 0 ? 0.55 : 0;
              if (d >= 0) a *= 1 - u * 0.5;
              if (a <= 0.03) continue;
              const rr = Math.round(tr + (255 - tr) * lift);
              const gg = Math.round(tg + (255 - tg) * lift);
              const bb = Math.round(tb + (255 - tb) * lift);
              ctx.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${Math.min(1, a)})`;
              ctx.fillRect(snap(x), snap(top + r * CELL), DOT, DOT);
            }
          }
          return true;
        }
      };
    },
    [],
    { releaseWhenIdle: true }
  );
}
