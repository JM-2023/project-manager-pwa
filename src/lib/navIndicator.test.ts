import { describe, expect, it } from "vitest";
import { buildSlideKeyframes, type Box } from "./navIndicator";

const rail = (index: number): Box => ({ x: 8, y: 16 + index * 68, w: 62, h: 64 });
const dock = (index: number): Box => ({ x: 8 + index * 60, y: 8, w: 56, h: 52 });

describe("nav selection pill spring", () => {
  it("starts on the old tab and lands exactly on the new one", () => {
    const frames = buildSlideKeyframes(rail(0), rail(3));
    expect(frames[0]).toEqual(rail(0));
    expect(frames[frames.length - 1]).toEqual(rail(3));
    expect(frames.length).toBeLessThan(95);
  });

  it("stretches along the rail and thins across it mid-flight", () => {
    const frames = buildSlideKeyframes(rail(0), rail(4));
    const longest = frames.reduce((a, b) => (b.h > a.h ? b : a));
    expect(longest.h).toBeGreaterThan(rail(0).h * 1.5);
    expect(longest.w).toBeLessThan(rail(0).w);
    // Thinning stays centred on the rail's column.
    expect(longest.x + longest.w / 2).toBeCloseTo(rail(0).x + rail(0).w / 2, 5);
  });

  it("overshoots the target before settling (the spring's bounce)", () => {
    const frames = buildSlideKeyframes(rail(0), rail(3));
    const target = rail(3);
    expect(frames.some((f) => f.y + f.h > target.y + target.h + 1)).toBe(true);
  });

  it("travels horizontally on the phone dock, leading with the left edge when moving left", () => {
    const frames = buildSlideKeyframes(dock(4), dock(1));
    expect(frames.every((f) => f.y >= dock(1).y - 8 && f.y <= dock(1).y + 8)).toBe(true);
    // Early on, the left (leading) edge has moved further than the right one.
    const early = frames[6];
    expect(dock(4).x - early.x).toBeGreaterThan(dock(4).x + dock(4).w - (early.x + early.w));
  });
});
