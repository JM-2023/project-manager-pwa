import { useEffect, useLayoutEffect, useRef } from "react";
import type { ProgressTone } from "../../lib/progress";
import {
  cellRandom,
  clamp01,
  easeOut,
  mixColor,
  resolveColors,
  rgba,
  roundRectPath,
  useCanvasLoop,
  type RGBA
} from "../../lib/canvasLoop";

export interface HeatCell {
  date: string;
  tone: ProgressTone | "empty";
  /** 0-100: how much of the tone the tile carries (7% floor). */
  heat: number;
  /** Spoken for the keyboard cursor. */
  label: string;
  /** Shown in the hover tip. */
  title: string;
}

interface YearHeatmapProps {
  /** Week columns of 7 days; null marks a day outside the year (not drawn). */
  columns: Array<Array<HeatCell | null>>;
  today: string;
  ariaLabel: string;
  onOpenDay: (date: string) => void;
}

const ROWS = 7;
const GAP = 4;
const MIN_CELL = 11;
const MAX_CELL = 17;
// Room around the grid for the today ring and the keyboard cursor, which sit
// outside their tile. The card's padding gives this back (app.css), so the
// grid lands exactly where the DOM tiles did.
const BLEED = 3;
// Re-ink: a changed tile blooms its new colour out from the centre. The
// sweep crosses the year left to right, and a little per-tile jitter breaks
// the column edge so it reads as ink soaking in rather than a wipe.
const SWEEP_MS = 3;
const JITTER_MS = 40;
const INK_MS = 260;

interface Tile {
  key: string;
  target: RGBA | null;
  from: RGBA | null;
  start: number;
}

type Palette = ReturnType<typeof readPalette>;

function readPalette(scope: Element) {
  const colors = resolveColors(scope, {
    none: "var(--prog-none)",
    low: "var(--prog-low)",
    mid: "var(--prog-mid)",
    high: "var(--prog-high)",
    done: "var(--prog-done)",
    empty: "var(--line-strong)",
    ground: "var(--surface-2)",
    line: "var(--line)",
    lineStrong: "var(--line-strong)",
    primary: "var(--primary)",
    todayRing: "var(--primary-tint-strong)",
    sheen: "var(--meter-sheen)",
    sheenSoft: "var(--meter-sheen-soft)",
    shadeLip: "rgba(var(--shade), 0.05)"
  });
  const radius = parseFloat(getComputedStyle(scope).getPropertyValue("--r-xs")) || 4;
  const glass = document.documentElement.getAttribute("data-meters") !== "flat";
  return { ...colors, radius, glass };
}

/** The tile's ink: `color-mix(in srgb, tone max(7%, heat%), surface-2)`, as the CSS tiles had it. */
function inkFor(cell: HeatCell, palette: Palette): RGBA {
  const tone = palette[cell.tone];
  return mixColor(tone, palette.ground, Math.max(7, cell.heat) / 100);
}

const tileKey = (cell: HeatCell | null) => (cell ? `${cell.tone}:${cell.heat}` : "");

/** Cell size for a content width, mirroring the old flex columns (13px basis, 11–17px). */
function cellSize(contentWidth: number, cols: number) {
  const fit = (contentWidth - BLEED * 2 - GAP * (cols - 1)) / cols;
  return Math.min(MAX_CELL, Math.max(MIN_CELL, fit));
}

/**
 * The year heatmap, painted on one canvas: 371 tiles were 371 buttons, each
 * with its own transitions, and the re-ink on a year or metric switch was a
 * uniform colour fade. Here a changed tile blooms its new ink from the centre,
 * swept across the year; everything else holds perfectly still.
 *
 * Interaction the buttons used to give for free is rebuilt on top: pointer
 * hit-testing (click/tap opens the day), a hover tip in place of `title`, and
 * a keyboard cursor — the canvas is one tab stop, arrows walk the days,
 * Enter opens one, and a live region speaks the cursor's day.
 */
export function YearHeatmap({ columns, today, ariaLabel, onOpenDay }: YearHeatmapProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const todayRef = useRef(today);
  todayRef.current = today;
  const openRef = useRef(onOpenDay);
  openRef.current = onOpenDay;
  const syncRef = useRef<((animate: boolean) => void) | null>(null);

  const cols = columns.length;

  // Size the canvas from the card's content width before the loop measures it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const canvas = canvasRef.current;
    if (!scroller || !canvas) return;
    const fit = () => {
      const style = getComputedStyle(scroller);
      const content = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const cell = cellSize(content, cols);
      canvas.style.width = `${cell * cols + GAP * (cols - 1) + BLEED * 2}px`;
      canvas.style.height = `${cell * ROWS + GAP * (ROWS - 1) + BLEED * 2}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [cols]);

  useCanvasLoop(
    canvasRef,
    (loop, canvas) => {
      let palette = readPalette(canvas);
      const tiles = new Map<number, Tile>();
      let hovered = -1;
      let cursor = -1;
      let focusVisible = false;

      const at = (index: number) => columnsRef.current[Math.floor(index / ROWS)]?.[index % ROWS] ?? null;

      const shown = (tile: Tile, now: number): RGBA | null => {
        if (!tile.target || !tile.from) return tile.target;
        return mixColor(tile.target, tile.from, easeOut((now - tile.start) / INK_MS));
      };

      // Reconcile tiles with the latest cells. Tiles are positional, so a
      // year flip re-inks the same grid instead of replacing it.
      const sync = (animate: boolean) => {
        const now = performance.now();
        const grid = columnsRef.current;
        const count = grid.length * ROWS;
        for (const index of tiles.keys()) if (index >= count) tiles.delete(index);
        for (let index = 0; index < count; index += 1) {
          const cell = at(index);
          const key = tileKey(cell);
          const tile = tiles.get(index);
          if (tile && tile.key === key) continue;
          const target = cell ? inkFor(cell, palette) : null;
          const before = tile ? shown(tile, now) : null;
          const inking = animate && !loop.reducedMotion && target !== null;
          tiles.set(index, {
            key,
            target,
            // A tile that was empty space inks in from nothing.
            from: inking ? (before ?? [target[0], target[1], target[2], 0]) : null,
            start: now + Math.floor(index / ROWS) * SWEEP_MS + cellRandom(index, 7) * JITTER_MS
          });
        }
        loop.kick();
      };
      syncRef.current = sync;
      sync(false);

      /* ---- geometry + hit testing ---- */

      const cellOf = (width: number) => (width - BLEED * 2 - GAP * (columnsRef.current.length - 1)) / columnsRef.current.length;

      const hit = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        const size = cellOf(rect.width);
        const x = clientX - rect.left - BLEED;
        const y = clientY - rect.top - BLEED;
        const c = Math.floor(x / (size + GAP));
        const r = Math.floor(y / (size + GAP));
        if (c < 0 || r < 0 || r >= ROWS || c >= columnsRef.current.length) return -1;
        // The gutters between tiles aren't part of any day.
        if (x - c * (size + GAP) > size || y - r * (size + GAP) > size) return -1;
        return at(c * ROWS + r) ? c * ROWS + r : -1;
      };

      /* ---- tip + cursor ---- */

      const showTip = (index: number) => {
        const tip = tipRef.current;
        const cell = index >= 0 ? at(index) : null;
        if (!tip) return;
        if (!cell) {
          tip.classList.remove("is-visible");
          return;
        }
        const wrap = tip.parentElement!.getBoundingClientRect();
        const rect = canvas.getBoundingClientRect();
        const size = cellOf(rect.width);
        const c = Math.floor(index / ROWS);
        const r = index % ROWS;
        tip.textContent = cell.title;
        const half = tip.offsetWidth / 2;
        const centre = rect.left - wrap.left + BLEED + c * (size + GAP) + size / 2;
        tip.style.left = `${Math.min(Math.max(centre, half + 4), wrap.width - half - 4)}px`;
        tip.style.top = `${rect.top - wrap.top + BLEED + r * (size + GAP) - 6}px`;
        tip.classList.add("is-visible");
      };

      const setHover = (index: number) => {
        if (index === hovered) return;
        hovered = index;
        canvas.style.cursor = index >= 0 ? "pointer" : "";
        showTip(index >= 0 ? index : focusVisible ? cursor : -1);
        loop.paint();
      };

      const moveCursor = (index: number) => {
        cursor = index;
        const cell = at(index);
        if (liveRef.current) liveRef.current.textContent = cell ? cell.label : "";
        // Keep the cursor's week in view on narrow screens.
        const scroller = canvas.parentElement;
        if (scroller && scroller.scrollWidth > scroller.clientWidth) {
          const size = cellOf(canvas.getBoundingClientRect().width);
          const left = canvas.offsetLeft + BLEED + Math.floor(index / ROWS) * (size + GAP);
          if (left < scroller.scrollLeft + 8) scroller.scrollLeft = left - 8;
          else if (left + size > scroller.scrollLeft + scroller.clientWidth - 8) scroller.scrollLeft = left + size - scroller.clientWidth + 8;
        }
        showTip(index);
        loop.paint();
      };

      // In-year indices in date order: the grid is column-major, so the
      // index order already is the calendar order.
      const inYear = () => {
        const out: number[] = [];
        const count = columnsRef.current.length * ROWS;
        for (let index = 0; index < count; index += 1) if (at(index)) out.push(index);
        return out;
      };

      const onPointerMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        setHover(hit(e.clientX, e.clientY));
      };
      const onPointerLeave = () => setHover(-1);
      const onClick = (e: MouseEvent) => {
        const index = hit(e.clientX, e.clientY);
        const cell = index >= 0 ? at(index) : null;
        if (cell) openRef.current(cell.date);
      };
      // The cursor starts on today (or the year's first day) and keeps its
      // place across blur/refocus while that day is still on the map.
      const ensureCursor = () => {
        if (at(cursor)) return;
        const days = inYear();
        cursor = days.find((index) => at(index)?.date === todayRef.current) ?? days[0] ?? -1;
      };
      const onFocus = () => {
        focusVisible = canvas.matches(":focus-visible");
        ensureCursor();
        if (focusVisible) moveCursor(cursor);
      };
      const onBlur = () => {
        focusVisible = false;
        showTip(hovered);
        loop.paint();
      };
      const onKeyDown = (e: KeyboardEvent) => {
        const days = inYear();
        if (days.length === 0) return;
        ensureCursor();
        const position = Math.max(0, days.indexOf(cursor));
        let next = -1;
        if (e.key === "ArrowUp") next = days[Math.max(0, position - 1)];
        else if (e.key === "ArrowDown") next = days[Math.min(days.length - 1, position + 1)];
        else if (e.key === "ArrowLeft") next = days[Math.max(0, position - 7)];
        else if (e.key === "ArrowRight") next = days[Math.min(days.length - 1, position + 7)];
        else if (e.key === "Home") next = days[0];
        else if (e.key === "End") next = days[days.length - 1];
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const cell = at(cursor);
          if (cell) openRef.current(cell.date);
          return;
        } else return;
        e.preventDefault();
        focusVisible = true;
        moveCursor(next);
      };

      // The tip is positioned against the card, so a scroll strands it.
      const scroller = canvas.parentElement;
      const onScroll = () => {
        hovered = -1;
        showTip(focusVisible ? cursor : -1);
      };

      scroller?.addEventListener("scroll", onScroll, { passive: true });
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("click", onClick);
      canvas.addEventListener("focus", onFocus);
      canvas.addEventListener("blur", onBlur);
      canvas.addEventListener("keydown", onKeyDown);

      return {
        palette() {
          palette = readPalette(canvas);
          // A theme or material swap re-skins at once (the CSS froze its
          // transitions for it too); only data changes re-ink.
          for (const [index, tile] of tiles) {
            const cell = at(index);
            tiles.set(index, { key: tile.key, target: cell ? inkFor(cell, palette) : null, from: null, start: 0 });
          }
        },
        draw({ ctx, width, dpr, now }) {
          const grid = columnsRef.current;
          const size = cellOf(width);
          const snap = (v: number) => Math.round(v * dpr) / dpr;
          const radius = Math.min(palette.radius, size / 3);
          let inking = false;

          // One sheen gradient per row: it only depends on the tile's y.
          const sheens: CanvasGradient[] = [];
          if (palette.glass) {
            for (let r = 0; r < ROWS; r += 1) {
              const y0 = snap(BLEED + r * (size + GAP));
              const y1 = snap(BLEED + r * (size + GAP) + size);
              const g = ctx.createLinearGradient(0, y0, 0, y1);
              g.addColorStop(0, rgba(palette.sheen));
              g.addColorStop(0.6, rgba(palette.sheenSoft));
              g.addColorStop(1, rgba(palette.sheenSoft));
              sheens.push(g);
            }
          }

          const rings: Array<{ index: number; x: number; y: number; w: number; h: number }> = [];
          ctx.lineWidth = 1;

          for (let c = 0; c < grid.length; c += 1) {
            for (let r = 0; r < ROWS; r += 1) {
              const index = c * ROWS + r;
              const tile = tiles.get(index);
              const cell = at(index);
              if (!tile?.target || !cell) continue;
              const x = snap(BLEED + c * (size + GAP));
              const y = snap(BLEED + r * (size + GAP));
              const w = snap(BLEED + c * (size + GAP) + size) - x;
              const h = snap(BLEED + r * (size + GAP) + size) - y;
              const body = roundRectPath(x, y, w, h, radius);

              // Ink: the old colour, with the new one blooming out of the centre.
              const p = tile.from ? clamp01((now - tile.start) / INK_MS) : 1;
              if (p >= 1) {
                if (tile.from) tile.from = null;
                ctx.fillStyle = rgba(tile.target);
                ctx.fill(body);
              } else {
                inking = true;
                if (tile.from![3] > 0) {
                  ctx.fillStyle = rgba(tile.from!);
                  ctx.fill(body);
                }
                if (p > 0) {
                  const e = easeOut(p);
                  const s = 0.3 + 0.7 * e;
                  const bw = w * s;
                  const bh = h * s;
                  ctx.globalAlpha = Math.min(1, e * 1.6);
                  ctx.fillStyle = rgba(tile.target);
                  ctx.fill(roundRectPath(x + (w - bw) / 2, y + (h - bh) / 2, bw, bh, radius * s));
                  ctx.globalAlpha = 1;
                }
              }

              // Glass: the meters' sheen and lit top lip over the ink.
              if (palette.glass) {
                ctx.fillStyle = sheens[r];
                ctx.fill(body);
                ctx.fillStyle = rgba(palette.sheen);
                ctx.fillRect(x + radius * 0.6, y + 1, w - radius * 1.2, 1);
                ctx.fillStyle = rgba(palette.shadeLip);
                ctx.fillRect(x + radius * 0.6, y + h - 2, w - radius * 1.2, 1);
              }

              const isToday = cell.date === todayRef.current;
              ctx.strokeStyle = rgba(isToday ? palette.primary : index === hovered ? palette.lineStrong : palette.line);
              ctx.stroke(roundRectPath(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, radius - 0.5)));
              if (isToday || (focusVisible && index === cursor)) rings.push({ index, x, y, w, h });
            }
          }

          // Rings sit outside their tile, over the gutter: drawn last so no
          // neighbour's fill can cover them.
          ctx.lineWidth = 2;
          for (const ring of rings) {
            const isCursor = focusVisible && ring.index === cursor;
            const out = isCursor ? 2 : 1;
            ctx.strokeStyle = rgba(isCursor ? palette.primary : palette.todayRing);
            ctx.stroke(roundRectPath(ring.x - out, ring.y - out, ring.w + out * 2, ring.h + out * 2, radius + out));
          }

          return inking;
        },
        dispose() {
          syncRef.current = null;
          scroller?.removeEventListener("scroll", onScroll);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerleave", onPointerLeave);
          canvas.removeEventListener("click", onClick);
          canvas.removeEventListener("focus", onFocus);
          canvas.removeEventListener("blur", onBlur);
          canvas.removeEventListener("keydown", onKeyDown);
        }
      };
    },
    []
  );

  // New period, metric or data: re-ink whatever changed.
  useEffect(() => {
    syncRef.current?.(true);
  }, [columns, today]);

  return (
    <div className="cal-heatmap-wrap">
      <div ref={scrollerRef} className="cal-heatmap">
        <canvas ref={canvasRef} className="cal-heatmap__canvas" tabIndex={0} role="group" aria-label={ariaLabel} />
      </div>
      <div ref={tipRef} className="cal-heatmap__tip" aria-hidden="true" />
      <span ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  );
}
