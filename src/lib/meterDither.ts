import type { RefObject } from "react";
import { cellRandom, clamp01, smoothstep, useCanvasLoop, type CanvasLoop } from "./canvasLoop";

/* The task meter's pixel particles. The track and fill stay CSS (they wear
   the shared --mtr-* material, so the glass/flat switch keeps moving every
   meter together); this canvas takes over the fill's end while it moves.

   The grid: square cells, three to the meter's height, fixed to the track
   and snapped to device pixels. The loop cuts the CSS fill off hard on a
   grid line (--dither-cut, masked in app.css) and draws everything past it
   as cells in exactly the fill's material — tone, and on glass its vertical
   sheen, its sideways sheen at the same point along the bar and its lit top
   lip — so where cells tile they are indistinguishable from the fill.

   Dragging ("live"): the stretch behind the value turns porous, and pixels
   break off it and fly right, slowing to a drift, shrinking and paling as
   they go — more of them, and faster, the faster the drag.

   Released ("settle"): the fill must end at the detent it snapped to. Every
   empty grid slot between the cut and that point gets a particle, the
   nearest first, so they stream back left to right and land one by one;
   extra particles fade out where they drift, and if the slots outnumber
   them, new ones glide in from just past the target. When the last lands
   the cut is lifted and the clean CSS edge takes over — the same pixels,
   so nothing jumps. Keyboard steps and external updates settle the same
   way. At rest nothing is drawn and the bitmap is released. */

const BEHIND = 16; // px behind the value that turns porous at full speed
const FULL_SPEED = 150; // %/s that counts as full energy
const WAKE = 20; // energy rises fast…
const SETTLE = 4; // …and falls slowly
const EMIT = 130; // particles per second at full energy
const MAX_PARTICLES = 70;
// Launch speed on top of the edge's own rightward speed, so particles
// always leave the edge ahead of it instead of being overrun by the fill.
const LAUNCH = 45; // px/s every particle leaves with…
const LAUNCH_FAST = 170; // …plus up to this at full energy
const DRAG = 2; // velocity damping, 1/s
const DRIFT = 5; // px/s a resting particle still creeps right
const STAGGER = 0.022; // s between successive departures home…
const STAGGER_SPAN = 0.5; // …squeezed so the last one leaves within this
const FLY_MIN = 0.38; // s, shortest flight home…
const FLY_PER_PX = 0.004; // …plus this per px of distance…
const FLY_MAX = 0.9; // …up to this
const FADE_OUT = 0.4; // s for a particle to dissolve (crowding, bar's end)

interface Flight {
  key: number;
  delay: number;
  t: number;
  dur: number;
  from: { x: number; y: number; size: number; lift: number; alpha: number } | null;
  tx: number;
  ty: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  lift: number;
  alpha: number;
  age: number;
  /** Seconds of fade left once dissolving; null while alive. */
  fade: number | null;
  /** Holds still until its flight departs (a pixel waiting inside the fill). */
  anchored: boolean;
  flight: Flight | null;
}

export interface MeterDitherRefs {
  /** Displayed percent (what the CSS fill is painted at). */
  value: RefObject<number>;
  /** Percent the fill is settling to (the snapped detent). */
  target: RefObject<number>;
  /** True while a pointer drag is in progress. */
  dragging: RefObject<boolean>;
}

function parseRgb(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b];
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Drive the particle canvas from the meter's refs. Call `kick()` on the
 * returned loop whenever the displayed value is repainted.
 */
export function useMeterDither(canvasRef: RefObject<HTMLCanvasElement>, refs: MeterDitherRefs): RefObject<CanvasLoop | null> {
  return useCanvasLoop(
    canvasRef,
    (loop, canvas) => {
      const meter = canvas.parentElement;
      const fill = meter?.querySelector<HTMLElement>(".progress-meter__fill") ?? null;
      let lastValue = refs.value.current ?? 0;
      let energy = 0;
      let edgeSpeed = 0; // px/s the displayed edge is moving (signed)
      let mode: "idle" | "live" | "settle" = "idle";
      let cutCol = 0; // the CSS fill ends at cutCol * cell
      let plannedTarget = -1;
      let emitDebt = 0;
      let particles: Particle[] = [];
      // Settle: grid cells (col * 3 + row) past the cut that are solid.
      let landed = new Set<number>();
      // Live: the cells drawn this frame, kept so a release can start from them.
      let attached = new Set<number>();

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

      const reset = () => {
        mode = "idle";
        particles = [];
        landed = new Set();
        attached = new Set();
        plannedTarget = -1;
        emitDebt = 0;
        setCut(null);
      };

      const spawn = (x: number, y: number, size: number, vx: number, vy: number): Particle => {
        const p: Particle = { x, y, vx, vy, size, lift: 0, alpha: 1, age: 0, fade: null, flight: null, anchored: false };
        particles.push(p);
        return p;
      };

      /** Knock a grid cell loose as a particle heading right. */
      const loosen = (key: number, cell: number) => {
        const col = Math.floor(key / 3);
        spawn(col * cell, (key % 3) * cell, cell, 20 + Math.random() * 60, (Math.random() - 0.5) * 16);
      };

      /** Send particles home to fill every empty slot up to `targetX`. */
      const plan = (targetX: number, cell: number) => {
        plannedTarget = targetX;
        // The last slot column is the one the target ends in (if it reaches
        // into it by more than a hairline).
        const lastCol = Math.ceil(targetX / cell - 0.15) - 1;
        const targetCol = Math.max(0, Math.min(cutCol, lastCol + 1));
        // Shrinking past the cut: the solid stretch beyond the target breaks
        // off, the rest of it becomes landed cells behind the new cut.
        if (targetCol < cutCol) {
          for (let col = targetCol; col < cutCol; col += 1) {
            for (let row = 0; row < 3; row += 1) {
              if (col <= lastCol) landed.add(col * 3 + row);
              else loosen(col * 3 + row, cell);
            }
          }
          cutCol = targetCol;
        }
        for (const key of [...landed]) {
          if (Math.floor(key / 3) > lastCol) {
            landed.delete(key);
            loosen(key, cell);
          }
        }

        const slots: number[] = [];
        for (let col = cutCol; col <= lastCol; col += 1) {
          for (let row = 0; row < 3; row += 1) if (!landed.has(col * 3 + row)) slots.push(col * 3 + row);
        }
        // Everything in the air comes home, nearest first. The first ones
        // fill the empty slots; the rest follow into the fill's end and
        // merge there (a cell of the same material, so they just vanish
        // into it). If the slots outnumber them, the fill grows the rest
        // itself: pixels leave its end one after another and fly forward
        // into the far slots, so it advances pixel by pixel.
        const free = particles.filter((p) => p.fade === null).sort((a, b) => a.x - b.x);
        const count = Math.max(slots.length, free.length);
        const stagger = Math.min(STAGGER, STAGGER_SPAN / Math.max(1, count));
        // Where spares merge: the last two slot columns, or the solid just
        // behind the cut when nothing needs filling.
        const mergeInto = slots.length > 0 ? slots.filter((key) => Math.floor(key / 3) >= lastCol - 1) : [0, 1, 2].map((row) => Math.max(0, cutCol - 1) * 3 + row);
        for (let i = 0; i < count; i += 1) {
          const key = i < slots.length ? slots[i] : mergeInto[Math.floor(Math.random() * mergeInto.length)];
          const col = Math.floor(key / 3);
          let p = free[i];
          if (!p) {
            // Waits inside the fill's end (same material: invisible) until
            // its turn, then flies out to its slot.
            p = spawn(Math.max(0, cutCol - 1) * cell, (key % 3) * cell, cell, 0, 0);
            p.anchored = true;
          }
          const dist = Math.hypot(p.x - col * cell, p.y - (key % 3) * cell);
          p.flight = {
            key,
            delay: i * stagger,
            t: 0,
            dur: Math.min(FLY_MAX, FLY_MIN + dist * FLY_PER_PX),
            from: null,
            tx: col * cell,
            ty: (key % 3) * cell
          };
        }
      };

      const stepFree = (p: Particle, dt: number, H: number, cell: number) => {
        const damp = 1 - Math.exp(-DRAG * dt);
        p.vx += (DRIFT - p.vx) * damp;
        p.vy -= p.vy * damp;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y < 0 || p.y > H - p.size) {
          p.y = Math.min(Math.max(p.y, 0), H - p.size);
          p.vy *= -0.4;
        }
        p.age += dt;
        p.size = cell * (1 - 0.35 * smoothstep(0, 0.8, p.age));
        p.lift = 0.4 * smoothstep(0, 1, p.age);
        p.alpha = 1 - 0.3 * smoothstep(0, 1, p.age);
      };

      return {
        draw({ ctx, width: W, height: H, dpr, now, dt }) {
          const valuePct = refs.value.current ?? 0;
          if (dt > 0) {
            const speed = Math.abs(valuePct - lastValue) / dt;
            edgeSpeed = ((valuePct - lastValue) / 100) * W / dt;
            lastValue = valuePct;
            const target = clamp01(speed / FULL_SPEED);
            energy += (target - energy) * (1 - Math.exp(-(target > energy ? WAKE : SETTLE) * dt));
          }
          if (loop.reducedMotion || W === 0 || H === 0) {
            reset();
            return false;
          }

          const cell = H / 3;
          const snap = (v: number) => Math.round(v * dpr) / dpr;
          const V = clamp01(valuePct / 100) * W;
          const T = clamp01((refs.target.current ?? valuePct) / 100) * W;
          const dragging = refs.dragging.current === true;

          /* ---- mode ---- */
          if (dragging) {
            if (mode === "settle") {
              // Grabbed again mid-settle: whatever was landed past the value
              // breaks loose; the rest is redrawn by the live pattern.
              for (const key of landed) if (Math.floor(key / 3) * cell >= V) loosen(key, cell);
              particles.forEach((p) => (p.flight = null));
            }
            mode = "live";
          } else if (mode === "live") {
            mode = "settle";
            landed = new Set(attached);
            plan(T, cell);
          } else if (mode === "settle") {
            if (Math.abs(T - plannedTarget) > 0.01) plan(T, cell);
          } else if (Math.abs(V - T) > 0.5) {
            // A keyboard step or a synced value: settle from the clean edge.
            mode = "settle";
            cutCol = Math.floor(V / cell);
            landed = new Set();
            if (V - cutCol * cell > 0.5) for (let row = 0; row < 3; row += 1) landed.add(cutCol * 3 + row);
            plan(T, cell);
          }
          if (mode === "idle") {
            setCut(null);
            return false;
          }

          /* ---- live: porous end + emission ---- */
          const t = now / 1000;
          if (mode === "live") {
            const k = smoothstep(0.03, 0.35, energy);
            cutCol = Math.max(0, Math.floor((V - Math.min(V, BEHIND * k)) / cell));
            const cutX = cutCol * cell;
            const span = Math.max(cell, V - cutX);
            attached = new Set();
            for (let col = cutCol; col * cell < V; col += 1) {
              const s = clamp01((col * cell + cell / 2 - cutX) / span);
              for (let row = 0; row < 3; row += 1) {
                const key = col * 3 + row;
                const cov = col === cutCol ? 1 : Math.pow(1 - s, 1.3);
                const threshold = cellRandom(key + 3000, 11) + 0.12 * Math.sin(t * (1.5 + cellRandom(key, 12) * 3) + cellRandom(key, 13) * 6.28);
                if (cov > threshold) attached.add(key);
              }
            }
            emitDebt += EMIT * energy * dt;
            while (emitDebt >= 1) {
              emitDebt -= 1;
              const col = Math.max(cutCol, Math.floor((V - Math.random() * cell * 1.5) / cell));
              const row = Math.floor(Math.random() * 3);
              const launch = Math.max(0, edgeSpeed) + LAUNCH + LAUNCH_FAST * energy * Math.random();
              spawn(col * cell, row * cell, cell, launch, (Math.random() - 0.5) * 24);
            }
            // Too many in the air: the oldest dissolve.
            const alive = particles.filter((p) => p.fade === null);
            for (let i = 0; i < alive.length - MAX_PARTICLES; i += 1) alive[i].fade = FADE_OUT;
          }

          /* ---- particles ---- */
          for (const p of particles) {
            const f = p.flight;
            if (f && dt > 0) {
              f.t += dt;
              if (f.t < f.delay) {
                if (!p.anchored) stepFree(p, dt, H, cell);
                continue;
              }
              f.from ??= { x: p.x, y: p.y, size: p.size, lift: p.lift, alpha: p.alpha };
              const e = easeInOut(clamp01((f.t - f.delay) / f.dur));
              p.x = lerp(f.from.x, f.tx, e);
              p.y = lerp(f.from.y, f.ty, e);
              p.size = lerp(f.from.size, cell, e);
              p.lift = lerp(f.from.lift, 0, e);
              p.alpha = lerp(f.from.alpha, 1, e);
              if (f.t - f.delay >= f.dur) {
                landed.add(f.key);
                p.fade = -1; // landed: removed below
              }
            } else if (dt > 0) {
              stepFree(p, dt, H, cell);
              if (p.fade !== null) p.fade -= dt;
              else if (p.x > W - p.size) p.fade = FADE_OUT;
              // Overrun by the fill: it rejoins the solid (same material).
              else if (mode === "live" && p.x + p.size <= cutCol * cell) p.fade = 0;
            }
          }
          particles = particles.filter((p) => p.fade === null || p.fade > 0);

          /* ---- paint ---- */
          setCut(snap(cutCol * cell));
          // The fill's live colour: it cross-fades when the tone band
          // changes, and the pixels must cross-fade with it.
          const [tr, tg, tb] = parseRgb(getComputedStyle(fill ?? canvas)[fill ? "backgroundColor" : "color"]);
          const ink = (lift: number, alpha: number) =>
            `rgba(${Math.round(tr + (255 - tr) * lift)}, ${Math.round(tg + (255 - tg) * lift)}, ${Math.round(tb + (255 - tb) * lift)}, ${alpha})`;

          // Grid cells continuing the fill. The first column reaches one device
          // pixel back over the fill: a hard mask stop may still antialias
          // its last pixel, and the cell (same material) covers that hairline.
          const edge = mode === "live" ? V : T;
          ctx.fillStyle = ink(0, 1);
          for (const key of mode === "live" ? attached : landed) {
            const col = Math.floor(key / 3);
            const row = key % 3;
            const x0 = snap(col * cell) - (col === cutCol ? 1 / dpr : 0);
            const x1 = Math.min(snap((col + 1) * cell), snap(edge));
            if (x1 <= x0) continue;
            ctx.fillRect(x0, snap(row * cell), x1 - x0, snap((row + 1) * cell) - snap(row * cell));
          }

          for (const p of particles) {
            const alpha = p.alpha * (p.fade !== null && p.fade > 0 ? Math.min(1, p.fade / FADE_OUT) : 1);
            if (alpha <= 0.02) continue;
            const size = Math.max(1 / dpr, snap(p.size));
            ctx.fillStyle = ink(p.lift, alpha);
            ctx.fillRect(snap(p.x), snap(p.y), size, size);
          }

          // Glass: lay the fill's own --mtr-fill-img and lip over everything
          // drawn (source-atop), in the fill's coordinates — the sideways
          // sheen runs 0 → the displayed value, exactly like the CSS fill.
          if (document.documentElement.getAttribute("data-meters") !== "flat") {
            ctx.globalCompositeOperation = "source-atop";
            const vertical = ctx.createLinearGradient(0, 0, 0, H);
            vertical.addColorStop(0, "rgba(255, 255, 255, 0.65)");
            vertical.addColorStop(0.45, "rgba(255, 255, 255, 0.15)");
            vertical.addColorStop(0.72, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = vertical;
            ctx.fillRect(0, 0, W, H);
            if (V > 0) {
              const sideways = ctx.createLinearGradient(0, 0, V, 0);
              sideways.addColorStop(0, "rgba(255, 255, 255, 0.34)");
              sideways.addColorStop(1, "rgba(255, 255, 255, 0)");
              ctx.fillStyle = sideways;
              ctx.fillRect(0, 0, V, H);
            }
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            ctx.fillRect(0, 0, W, 1);
            ctx.globalCompositeOperation = "source-over";
          }

          /* ---- done? ---- */
          if (mode === "settle" && particles.length === 0 && Math.abs(V - T) < 0.05) {
            // Every slot is filled and the CSS fill sits at the target: the
            // same pixels either way, so hand the clean edge back.
            reset();
            return false;
          }
          if (mode === "live" && particles.length === 0 && energy < 0.03) {
            // Held still with nothing in the air: the end is solid again.
            reset();
            return false;
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
