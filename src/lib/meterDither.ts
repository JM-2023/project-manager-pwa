import type { RefObject } from "react";
import { cellRandom, clamp01, smoothstep, useCanvasLoop, type CanvasLoop } from "./canvasLoop";

/* The task meter's motion texture. The track and fill stay CSS (they wear
   the shared --mtr-* material, so the glass/flat switch keeps moving every
   meter together); this canvas adds what CSS can't: while the fill moves,
   its end breaks up into pixels — the fill itself, not a layer beside it.

   How the two become one object:
     - A pixel grid is fixed to the track: square cells, three to the
       meter's height, snapped to device pixels.
     - The loop cuts the CSS fill off hard on a grid line (--dither-cut,
       masked in app.css) some way behind the value.
     - From that line on, the canvas continues the fill as cells in exactly
       the fill's material — its tone, and on glass its vertical sheen,
       its sideways sheen at the same point along the bar, and its lit top
       lip — tiling with no gaps, so the join is invisible.
     - Further along the cells drop out at random, shrink apart and pale as
       they scatter past the value, further the faster it moves; the ones
       near the thinning threshold flicker, so the break-up lives.
   As the fill settles the broken stretch shrinks back into the edge, the
   cut returns to the value and the clean CSS edge takes over again. At rest
   nothing is drawn and the bitmap is released. */

const BEHIND = 16; // px of the fill behind the value that breaks up at speed
const REACH = 8; // px the pixels scatter past the value at a crawl…
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

      const setCut = (px: number | null) => {
        if (!meter) return;
        if (px === null) {
          meter.classList.remove("is-dithering");
          meter.style.removeProperty("--dither-cut");
        } else {
          meter.classList.add("is-dithering");
          meter.style.setProperty("--dither-cut", `${px}px`);
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
          // How broken up the end is; the whole zone scales with it.
          const k = smoothstep(0.03, 0.35, energy);
          const edgeX = clamp01(value / 100) * W;
          const cell = H / 3;
          const snap = (v: number) => Math.round(v * dpr) / dpr;
          const behind = Math.min(edgeX, BEHIND * k);
          const reach = (REACH + REACH_FAST * energy) * k;
          // Once the zone is under one cell there is nothing left to break
          // up: hand the clean edge back.
          if (behind + reach < cell) {
            setCut(null);
            return energy >= 0.03;
          }

          const cutCol = Math.floor((edgeX - behind) / cell);
          const cutX = snap(cutCol * cell);
          setCut(cutX);

          const [tr, tg, tb] = parseRgb(getComputedStyle(canvas).color);
          const zoneEnd = edgeX + reach;
          const span = Math.max(cell, zoneEnd - cutX);
          const t = now / 1000;
          const lastCol = Math.min(Math.ceil(W / cell), Math.ceil(zoneEnd / cell));

          for (let c = cutCol; c <= lastCol; c += 1) {
            // The first column reaches one device pixel back over the fill:
            // a hard mask stop may still antialias its last pixel, and the
            // cell (same material) covers that hairline.
            const x0 = snap(c * cell) - (c === cutCol ? 1 / dpr : 0);
            const x1 = snap((c + 1) * cell);
            // 0 at the cut, 1 at the far end of the scatter.
            const s = clamp01((c * cell + cell / 2 - cutX) / span);
            for (let r = 0; r < 3; r += 1) {
              const index = (c + 1000) * 3 + r;
              // The first column always continues the fill unbroken; past it
              // cells thin out, and the ones near their threshold flicker.
              const cov = c === cutCol ? 1 : Math.pow(1 - s, 1.5);
              const threshold = cellRandom(index, 11) + 0.12 * Math.sin(t * (1.5 + cellRandom(index, 12) * 3) + cellRandom(index, 13) * 6.28);
              if (cov <= threshold) continue;
              // Cells shrink apart and pale as they travel.
              const shrink = smoothstep(0.15, 1, s) * 0.55;
              const y0 = snap(r * cell);
              const y1 = snap((r + 1) * cell);
              // Whole device pixels, so a shrunken cell stays a crisp square.
              const inset = snap(((x1 - x0) * shrink) / 2);
              const insetY = snap(((y1 - y0) * shrink) / 2);
              const lift = smoothstep(0.2, 1, s) * 0.45;
              const alpha = 1 - smoothstep(0.3, 1, s) * 0.55;
              ctx.fillStyle = `rgba(${Math.round(tr + (255 - tr) * lift)}, ${Math.round(tg + (255 - tg) * lift)}, ${Math.round(tb + (255 - tb) * lift)}, ${alpha})`;
              ctx.fillRect(x0 + inset, y0 + insetY, x1 - x0 - inset * 2, y1 - y0 - insetY * 2);
            }
          }

          // Glass: lay the fill's own --mtr-fill-img and lip over the cells
          // (source-atop, so only the cells take it), measured in the fill's
          // coordinates — the sideways sheen runs 0 → the value, like the
          // CSS gradient across the fill's width.
          if (document.documentElement.getAttribute("data-meters") !== "flat") {
            ctx.globalCompositeOperation = "source-atop";
            const vertical = ctx.createLinearGradient(0, 0, 0, H);
            vertical.addColorStop(0, "rgba(255, 255, 255, 0.65)");
            vertical.addColorStop(0.45, "rgba(255, 255, 255, 0.15)");
            vertical.addColorStop(0.72, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = vertical;
            ctx.fillRect(0, 0, W, H);
            if (edgeX > 0) {
              const sideways = ctx.createLinearGradient(0, 0, edgeX, 0);
              sideways.addColorStop(0, "rgba(255, 255, 255, 0.34)");
              sideways.addColorStop(1, "rgba(255, 255, 255, 0)");
              ctx.fillStyle = sideways;
              ctx.fillRect(0, 0, edgeX, H);
            }
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            ctx.fillRect(0, 0, W, 1);
            ctx.globalCompositeOperation = "source-over";
          }
          return true;
        },
        dispose() {
          setCut(null);
        }
      };
    },
    [],
    { releaseWhenIdle: true }
  );
}
