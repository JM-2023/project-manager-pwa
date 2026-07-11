import { describe, expect, it } from "vitest";
import { normalizeDate } from "./validation";

describe("normalizeDate", () => {
  it("keeps valid calendar dates and rejects impossible ISO-looking dates", () => {
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeDate("2023-02-29")).toBeNull();
    expect(normalizeDate("2026-13-40")).toBeNull();
  });

  it("normalizes parseable timestamps to their UTC calendar date", () => {
    expect(normalizeDate("2026-07-11T23:30:00-04:00")).toBe("2026-07-12");
  });
});
