import { describe, expect, it } from "vitest";
import { landingScroll, springAt, springLanded, type SpringLeg } from "./disclosure";

const FRAME = 1000 / 60;

/** Frame-by-frame positions of a leg until it lands (clamped like a paint). */
function run(leg: SpringLeg, frames = 120): number[] {
  const xs: number[] = [];
  for (let i = 1; i <= frames; i++) {
    const now = leg.start + i * FRAME;
    const { x, v } = springAt(leg, now);
    if (springLanded(leg, x, v)) {
      xs.push(leg.to);
      break;
    }
    xs.push(Math.max(0, Math.min(1, x)));
  }
  return xs;
}

describe("springAt", () => {
  it("opens from rest without passing its target, and lands in about 300ms", () => {
    const xs = run({ start: 0, from: 0, velocity: 0, to: 1 });
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(xs[xs.length - 1]).toBe(1);
    expect(xs.length * FRAME).toBeLessThan(320);
    // The last step before landing is a sliver, not a stop from speed.
    expect(1 - xs[xs.length - 2]).toBeLessThan(0.003);
  });

  it("reports the velocity of its own path", () => {
    const leg = { start: 0, from: 0, velocity: 0, to: 1 };
    for (const t of [10, 60, 120, 200]) {
      const ahead = springAt(leg, t + 0.01).x;
      const behind = springAt(leg, t - 0.01).x;
      expect(springAt(leg, t).v).toBeCloseTo((ahead - behind) / 0.00002, 2);
    }
  });

  it("turns around mid-flight from where it is and how fast it is going", () => {
    const open = { start: 0, from: 0, velocity: 0, to: 1 };
    const at = springAt(open, 120);
    const close = { start: 120, from: at.x, velocity: at.v, to: 0 };
    const now = springAt(close, 120);
    expect(now.x).toBeCloseTo(at.x, 10);
    expect(now.v).toBeCloseTo(at.v, 10);

    // It keeps drifting open for a frame, slows and comes back: the step
    // from frame to frame changes no faster than a start from rest ramps
    // up, where a fresh tween would flip from opening to closing at once.
    const previous = springAt(open, 120 - FRAME).x;
    const xs = [previous, at.x, ...run(close)];
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(steps[1]).toBeGreaterThan(0);
    const changes = steps.slice(1).map((step, i) => Math.abs(step - steps[i]));
    expect(Math.max(...changes)).toBeLessThan(0.09);
    expect(xs[xs.length - 1]).toBe(0);
  });
});

describe("landingScroll", () => {
  const band = { top: 12, bottom: 560 };

  it("leaves the page alone when the block lands inside the band", () => {
    expect(landingScroll({ top: 100, height: 300 }, band, 300, 2000)).toBe(300);
  });

  it("carries the page up with a block opening near the bottom", () => {
    expect(landingScroll({ top: 400, height: 300 }, band, 300, 2000)).toBe(440);
  });

  it("never scrolls past the block's own top", () => {
    expect(landingScroll({ top: 400, height: 1000 }, band, 300, 2000)).toBe(300 + 400 - 12);
  });

  it("brings back a block whose top has scrolled out of view", () => {
    expect(landingScroll({ top: -300, height: 200 }, band, 900, 2000)).toBe(900 - 312);
  });

  it("stays within what the page can scroll once it lands", () => {
    expect(landingScroll({ top: 400, height: 300 }, band, 300, 400)).toBe(400);
    expect(landingScroll({ top: 20, height: 100 }, band, 900, 500)).toBe(500);
  });
});
