import type { RefObject } from "react";
import { cellRandom, clamp01, smoothstep, useCanvasLoop, type CanvasLoop } from "./canvasLoop";

/* The task meter's motion texture. The track and fill stay CSS (they wear
   the shared --mtr-* material, so the glass/flat switch keeps moving every
   meter together); this canvas adds what CSS can't: while the fill moves,
   its end dissolves into the Today hero's dot matrix, as one object.

   The hand-off is the whole trick. The loop feeds --dither-fade to the
   meter, and the CSS masks the last that-many px of the fill down to
   transparent; over exactly that stretch the canvas lays a mosaic of dots in
   the fill's own tone (and, on glass, under the fill's own sheen), dense
   where the fill has thinned out, then scattering past the edge and paling
   as they go — further the faster it moves. So the solid fill, the mosaic
   and the loose pixels are one continuous ramp with no seam between them.
   As the fill settles the fade shrinks to 0 and the edge is clean again.
   At rest nothing is drawn and the bitmap is released. */

const CELL = 3; // css px per dot cell (dot + gap)
const DOT = 2;
const FADE = 18; // px of the fill's end that dissolves at speed
const REACH = 8; // px the pixels scatter past the edge at a crawl…
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
      const meter = canvas.parentElement;
      let last = valueRef.current ?? 0;
      let energy = 0;

      const setFade = (px: number) => {
        if (!meter) return;
        if (px > 0) {
          meter.classList.add("is-dithering");
          meter.style.setProperty("--dither-fade", `${px}px`);
        } else {
          meter.classList.remove("is-dithering");
          meter.style.removeProperty("--dither-fade");
        }
      };

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
          // Below this the fade is under half a pixel: hand the clean edge back.
          if (energy < 0.03) {
            setFade(0);
            return false;
          }

          const edgeX = clamp01(value / 100) * W;
          // The fade can't be longer than the fill it eats into.
          const fade = Math.min(edgeX, FADE * smoothstep(0, 0.35, energy));
          setFade(fade);

          // Tone from CSS (the row's .tone-* sets --prog-color on the canvas).
          const [tr, tg, tb] = parseRgb(getComputedStyle(canvas).color);
          const reach = REACH + REACH_FAST * energy;
          const rows = Math.max(1, Math.floor((H + CELL - DOT) / CELL));
          const top = (H - (rows * CELL - (CELL - DOT))) / 2;
          const snap = (v: number) => Math.round(v * dpr) / dpr;
          const t = now / 1000;

          const first = Math.max(0, Math.floor((edgeX - fade) / CELL));
          const lastCol = Math.min(Math.ceil(W / CELL), Math.ceil((edgeX + reach) / CELL));
          for (let c = first; c <= lastCol; c += 1) {
            const x = c * CELL;
            const d = x + DOT / 2 - edgeX; // <0 inside the fill's fading end
            const u = Math.max(0, d) / reach; // 0 at the edge, 1 at full reach
            // Coverage: ramps up across the fade as the fill thins out, is a
            // full mosaic at the edge, then scatters away past it.
            const cov = d < 0 ? smoothstep(-fade, -fade * 0.35, d) : clamp01(1 - u * 1.15);
            if (cov <= 0) continue;
            for (let r = 0; r < rows; r += 1) {
              const index = c * rows + r;
              const bias = cellRandom(index, 11);
              const gap = cov - bias * 0.98;
              if (gap <= 0) continue;
              const tw = 0.5 + 0.5 * Math.sin(t * (2 + cellRandom(index, 12) * 4) + cellRandom(index, 13) * Math.PI * 2);
              // Inside the fade the dots stand in for the fill, so they stay
              // near-opaque; the loose ones past the edge fade with speed.
              const a =
                smoothstep(0, 0.12, gap) *
                (d < 0 ? 0.88 + 0.12 * tw : energy * (1 - u * 0.45) * (0.5 + 0.5 * tw * tw));
              if (a <= 0.03) continue;
              // A little per-dot tone spread, whitening as they travel.
              const lift = Math.min(0.6, (1 - bias) * 0.16 + u * 0.4);
              const rr = Math.round(tr + (255 - tr) * lift);
              const gg = Math.round(tg + (255 - tg) * lift);
              const bb = Math.round(tb + (255 - tb) * lift);
              ctx.fillStyle = `rgba(${rr}, ${gg}, ${bb}, ${Math.min(1, a)})`;
              ctx.fillRect(snap(x), snap(top + r * CELL), DOT, DOT);
            }
          }

          // Glass: the dots wear the fill's own sheen (--mtr-fill-img's
          // vertical layer), composited onto the dots only.
          if (document.documentElement.getAttribute("data-meters") !== "flat") {
            ctx.globalCompositeOperation = "source-atop";
            const sheen = ctx.createLinearGradient(0, 0, 0, H);
            sheen.addColorStop(0, "rgba(255, 255, 255, 0.65)");
            sheen.addColorStop(0.45, "rgba(255, 255, 255, 0.15)");
            sheen.addColorStop(0.72, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = sheen;
            ctx.fillRect(0, 0, W, H);
            ctx.globalCompositeOperation = "source-over";
          }
          return true;
        },
        dispose() {
          setFade(0);
        }
      };
    },
    [],
    { releaseWhenIdle: true }
  );
}
