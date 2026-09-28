import { useEffect, useRef } from "react";
import type { TabId } from "../state/appStore";

/* Canvas-drawn navigation icons. Each icon is painted in a 24-unit grid (the
   same grid lucide uses, so stroke weight matches the rest of the app) and is
   driven by three springs plus a one-shot timeline:

     hover  — eases in while the pointer (or keyboard focus) is on the button
     press  — squeezes the glyph while the button is held down
     active — the selected tab fills its body with ink that grows out from the
              centre; inner details are knocked out of that fill, so a chosen
              tab reads as a solid glyph and every other tab stays an outline
     pulse  — a 0→1 timeline replayed on every hover entry (a check redraws,
              a gear turns, rays flicker out of the bulb…)

   Colour comes from the canvas's computed `color`, so CSS keeps owning the
   palette, theme switches and hover tints. The loop only runs while something
   is moving; a settled icon costs nothing. */

const ICON = 20; // layout size in CSS px (matches the old SVG)
const BLEED = 5; // extra canvas on each side so rays and overshoot never clip
const CANVAS = ICON + BLEED * 2;
const UNIT = ICON / 24;
const LINE = 2;
const PULSE_MS = 620;

interface Spring { x: number; v: number; target: number; k: number; c: number }
interface DrawState { hover: number; press: number; active: number; pulse: number | null }

const spring = (k: number, c: number, x = 0): Spring => ({ x, v: 0, target: x, k, c });

function stepSpring(s: Spring, dt: number, snap: boolean) {
  if (snap) { s.x = s.target; s.v = 0; return false; }
  s.v += (s.k * (s.target - s.x) - s.c * s.v) * dt;
  s.x += s.v * dt;
  if (Math.abs(s.target - s.x) < 0.0005 && Math.abs(s.v) < 0.0005) { s.x = s.target; s.v = 0; return false; }
  return true;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
/** Sub-range of the pulse, eased; 1 when no pulse is running. */
const phase = (pulse: number | null, from: number, to: number) => (pulse === null ? 1 : easeOut((pulse - from) / (to - from)));
/** A bump that rises and falls back to 0 across the pulse. */
const bump = (pulse: number | null) => (pulse === null ? 0 : Math.sin(Math.PI * clamp01(pulse)));

/* ---------- painting helpers ------------------------------------------- */

interface Pen {
  ctx: CanvasRenderingContext2D;
  /** Radius of the active fill, in icon units, centred on (12,12). */
  reveal: number;
  stroke(path: Path2D, width?: number): void;
  /** Outline the body, then fill it inside the reveal circle. */
  body(fill: Path2D, outline?: Path2D): void;
  /** Stroke an inner detail, then punch it out of the filled body. */
  detail(path: Path2D, width?: number): void;
}

function makePen(ctx: CanvasRenderingContext2D, reveal: number): Pen {
  const clipReveal = () => {
    const c = new Path2D();
    c.arc(12, 12, reveal, 0, Math.PI * 2);
    ctx.clip(c);
  };
  return {
    ctx,
    reveal,
    stroke(path, width = LINE) {
      ctx.lineWidth = width;
      ctx.stroke(path);
    },
    body(fill, outline = fill) {
      ctx.lineWidth = LINE;
      ctx.stroke(outline);
      if (reveal <= 0) return;
      ctx.save();
      clipReveal();
      ctx.fill(fill);
      ctx.stroke(outline);
      ctx.restore();
    },
    detail(path, width = LINE) {
      ctx.lineWidth = width;
      ctx.stroke(path);
      if (reveal <= 0) return;
      ctx.save();
      clipReveal();
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = width + 0.15;
      ctx.stroke(path);
      ctx.restore();
    }
  };
}

function withTransform(ctx: CanvasRenderingContext2D, cx: number, cy: number, rotate: number, scale: number, draw: () => void) {
  ctx.save();
  ctx.translate(cx, cy);
  if (rotate) ctx.rotate(rotate);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D();
  p.moveTo(x + r, y);
  p.arcTo(x + w, y, x + w, y + h, r);
  p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r);
  p.arcTo(x, y, x + w, y, r);
  p.closePath();
  return p;
}

function line(x1: number, y1: number, x2: number, y2: number) {
  const p = new Path2D();
  p.moveTo(x1, y1);
  p.lineTo(x2, y2);
  return p;
}

/** Polyline trimmed to `t` of its total length — for strokes that draw in. */
function partial(points: Array<[number, number]>, t: number) {
  const p = new Path2D();
  if (t <= 0) return p;
  const segs = points.slice(1).map((pt, i) => Math.hypot(pt[0] - points[i][0], pt[1] - points[i][1]));
  let left = segs.reduce((a, b) => a + b, 0) * clamp01(t);
  p.moveTo(points[0][0], points[0][1]);
  for (let i = 0; i < segs.length && left > 0; i++) {
    const f = Math.min(1, left / segs[i]);
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    p.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f);
    left -= segs[i];
  }
  return p;
}

/* ---------- the icons -------------------------------------------------- */

function calendarFrame(pen: Pen, ringLift: number) {
  pen.body(roundRect(3, 5, 18, 16, 2.5));
  pen.stroke(line(8, 3 - ringLift, 8, 7 - ringLift));
  pen.stroke(line(16, 3 - ringLift, 16, 7 - ringLift));
  pen.detail(line(3, 10, 21, 10));
}

const painters: Record<TabId, (pen: Pen, s: DrawState) => void> = {
  // Calendar with a check: the rings hop and the check redraws itself.
  today(pen, s) {
    calendarFrame(pen, s.hover * 1.1);
    pen.detail(partial([[8.6, 15.4], [11, 17.8], [15.6, 13.2]], phase(s.pulse, 0.15, 0.85)));
  },

  // Briefcase: picked up — the handle lifts and the case sways once.
  projects(pen, s) {
    const sway = s.pulse === null ? 0 : Math.sin(clamp01(s.pulse) * Math.PI * 3) * (1 - clamp01(s.pulse)) * 0.14;
    withTransform(pen.ctx, 12, 3, sway, 1, () => {
      const lift = s.hover * 1.4;
      const handle = new Path2D();
      handle.moveTo(8.5, 7);
      handle.lineTo(8.5, 4.8 - lift);
      handle.arcTo(8.5, 3 - lift, 10.3, 3 - lift, 1.8);
      handle.lineTo(13.7, 3 - lift);
      handle.arcTo(15.5, 3 - lift, 15.5, 4.8 - lift, 1.8);
      handle.lineTo(15.5, 7);
      pen.stroke(handle);
      pen.body(roundRect(3, 7, 18, 13.5, 2.5));
      pen.detail(line(3, 12.8, 21, 12.8));
      pen.detail(line(12, 11.6, 12, 14));
    });
  },

  // Calendar with a date range: the two range bars sweep in, staggered.
  calendar(pen, s) {
    calendarFrame(pen, 0);
    const a = phase(s.pulse, 0.1, 0.6);
    const b = phase(s.pulse, 0.35, 0.9);
    const dot = phase(s.pulse, 0, 0.3);
    if (dot > 0.05) pen.detail(line(7, 14.5, 7.01, 14.5), LINE * dot);
    if (a > 0) pen.detail(line(11, 14.5, 11 + 6 * a, 14.5));
    if (b > 0) pen.detail(line(7, 18, 7 + 6 * b, 18));
    pen.detail(line(17, 18, 17.01, 18));
  },

  // Lightbulb: glows faintly on hover, and a fan of rays flicks out.
  next(pen, s) {
    const { ctx } = pen;
    const bulb = "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5";
    if (s.hover > 0 && pen.reveal < 17) {
      ctx.save();
      ctx.globalAlpha = 0.16 * clamp01(s.hover);
      ctx.fill(new Path2D(`${bulb}Z`));
      ctx.restore();
    }
    pen.body(new Path2D(`${bulb}Z`), new Path2D(bulb));
    pen.stroke(line(9, 18, 15, 18));
    pen.stroke(line(10, 22, 14, 22));
    pen.detail(line(12, 14, 12, 10));

    const reach = clamp01(s.hover) * 0.9 + bump(s.pulse) * 1.1;
    if (reach > 0.02) {
      ctx.save();
      ctx.globalAlpha = clamp01(reach);
      for (const deg of [-155, -120, -90, -60, -25]) {
        const r = (deg * Math.PI) / 180;
        const inner = 8.2 + bump(s.pulse) * 0.5;
        pen.stroke(line(12 + Math.cos(r) * inner, 8 + Math.sin(r) * inner, 12 + Math.cos(r) * (inner + 1.6 * reach), 8 + Math.sin(r) * (inner + 1.6 * reach)), 1.6);
      }
      ctx.restore();
    }
  },

  // Magnifier: sweeps a small scanning loop, then leans in.
  search(pen, s) {
    const t = s.pulse === null ? 0 : clamp01(s.pulse);
    const loop = Math.sin(Math.PI * t) * 1.5;
    const dx = Math.cos(t * Math.PI * 2 - Math.PI / 2) * loop - s.hover * 0.5;
    const dy = Math.sin(t * Math.PI * 2 - Math.PI / 2) * loop - s.hover * 0.5;
    pen.ctx.save();
    pen.ctx.translate(dx, dy);
    const lens = new Path2D();
    lens.arc(11, 11, 7.5, 0, Math.PI * 2);
    pen.body(lens);
    pen.stroke(line(21, 21, 16.5, 16.5));
    const glint = new Path2D();
    const sweep = s.pulse === null ? 0 : (1 - easeOut(t)) * 0.9;
    glint.arc(11, 11, 4.2, Math.PI * 1.05 + sweep, Math.PI * 1.45 + sweep);
    pen.detail(glint, 1.7);
    pen.ctx.restore();
  },

  // Gear: turns one tooth (45°) with a little spring overshoot.
  settings(pen, s) {
    withTransform(pen.ctx, 12, 12, s.hover * (Math.PI / 4), 1, () => {
      const gear = new Path2D();
      const R = 10, r = 7.6, teeth = 8, tip = 0.17, root = 0.28;
      for (let i = 0; i < teeth; i++) {
        const a = (i * Math.PI * 2) / teeth;
        const pt = (rad: number, ang: number): [number, number] => [12 + Math.cos(ang) * rad, 12 + Math.sin(ang) * rad];
        const [x0, y0] = pt(r, a - root);
        if (i === 0) gear.moveTo(x0, y0); else gear.lineTo(x0, y0);
        gear.lineTo(...pt(R, a - tip));
        gear.lineTo(...pt(R, a + tip));
        gear.lineTo(...pt(r, a + root));
        gear.arc(12, 12, r, a + root, a + (Math.PI * 2) / teeth - root);
      }
      gear.closePath();
      pen.body(gear);
      const hub = new Path2D();
      hub.arc(12, 12, 3, 0, Math.PI * 2);
      pen.detail(hub);
    });
  }
};

/* ---------- component -------------------------------------------------- */

export function NavIcon({ id, active }: { id: TabId; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef<((on: boolean) => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const button = canvas?.closest("button");
    if (!canvas || !ctx || !button) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const hover = spring(260, 19);
    const press = spring(900, 42);
    const fill = spring(210, 29, active ? 1 : 0);
    let pulseStart: number | null = null;
    let keepAliveUntil = 0;
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(CANVAS * dpr);
      if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.setTransform(dpr * UNIT, 0, 0, dpr * UNIT, dpr * BLEED, dpr * BLEED);
      const color = getComputedStyle(canvas).color;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const pulse = pulseStart === null ? null : (now - pulseStart) / PULSE_MS;
      const state: DrawState = { hover: hover.x, press: press.x, active: fill.x, pulse };
      withTransform(ctx, 12, 12, 0, 1 - 0.14 * press.x, () => {
        painters[id](makePen(ctx, Math.max(0, fill.x) * 17.5), state);
      });
    };

    const tick = (now: number) => {
      const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const snap = reduced.matches;
      let moving = stepSpring(hover, dt, snap);
      moving = stepSpring(press, dt, snap) || moving;
      moving = stepSpring(fill, dt, snap) || moving;
      if (pulseStart !== null && now - pulseStart >= PULSE_MS) pulseStart = null;
      draw(now);
      if (moving || pulseStart !== null || now < keepAliveUntil) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
        last = 0;
      }
    };

    // Also follows CSS colour transitions (hover tint, theme swap) for `ms`.
    const kick = (ms = 0) => {
      keepAliveUntil = Math.max(keepAliveUntil, performance.now() + ms);
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const setHover = (on: boolean) => {
      if ((hover.target === 1) === on) return;
      hover.target = on ? 1 : 0;
      if (on && !reduced.matches) pulseStart = performance.now();
      kick(260);
    };
    const setPress = (on: boolean) => { press.target = on ? 1 : 0; kick(); };
    activeRef.current = (on) => { fill.target = on ? 1 : 0; kick(260); };

    const onEnter = (e: PointerEvent) => { if (e.pointerType !== "touch") setHover(true); };
    const onLeave = () => { setHover(false); setPress(false); };
    const onDown = () => setPress(true);
    const onUp = () => setPress(false);
    const onFocus = () => { if (button.matches(":focus-visible")) setHover(true); };
    const onBlur = () => setHover(false);
    const onKeyDown = (e: KeyboardEvent) => { if (!e.repeat && (e.key === " " || e.key === "Enter")) setPress(true); };
    const onKeyUp = () => setPress(false);
    // Settle on the final CSS colour even if the loop stopped mid-transition
    // (the rail transitions the canvas colour, the phone bar the button's).
    const onColorDone = (e: TransitionEvent) => { if (e.propertyName === "color") kick(); };

    button.addEventListener("pointerenter", onEnter);
    button.addEventListener("pointerleave", onLeave);
    button.addEventListener("pointerdown", onDown);
    button.addEventListener("pointerup", onUp);
    button.addEventListener("pointercancel", onUp);
    button.addEventListener("focus", onFocus);
    button.addEventListener("blur", onBlur);
    button.addEventListener("keydown", onKeyDown);
    button.addEventListener("keyup", onKeyUp);
    button.addEventListener("transitionend", onColorDone);

    // Redraw when the palette or pixel density changes underneath us.
    const observer = new MutationObserver(() => kick(600));
    observer.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => kick(600);
    scheme.addEventListener("change", onScheme);
    window.addEventListener("resize", onScheme);

    kick(260);
    return () => {
      cancelAnimationFrame(frame);
      activeRef.current = null;
      observer.disconnect();
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("resize", onScheme);
      button.removeEventListener("pointerenter", onEnter);
      button.removeEventListener("pointerleave", onLeave);
      button.removeEventListener("pointerdown", onDown);
      button.removeEventListener("pointerup", onUp);
      button.removeEventListener("pointercancel", onUp);
      button.removeEventListener("focus", onFocus);
      button.removeEventListener("blur", onBlur);
      button.removeEventListener("keydown", onKeyDown);
      button.removeEventListener("keyup", onKeyUp);
      button.removeEventListener("transitionend", onColorDone);
    };
    // `active` is read once for the initial fill; later changes go through activeRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { activeRef.current?.(active); }, [active]);

  return <canvas ref={canvasRef} className="nav-icon" width={CANVAS} height={CANVAS} aria-hidden="true" />;
}
