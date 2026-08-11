import { describe, expect, it } from "vitest";
import { assertUuidish, normalizeDate } from "./validation";

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

describe("assertUuidish", () => {
  it("passes a valid record id through trimmed", () => {
    expect(assertUuidish(" record-1 ")).toBe("record-1");
  });

  it("throws instead of minting a replacement id", () => {
    // A silently generated UUID would write a record the client never asked
    // for and can never address again.
    expect(() => assertUuidish("")).toThrow("Record id is invalid");
    expect(() => assertUuidish(undefined)).toThrow("Record id is invalid");
    expect(() => assertUuidish("x".repeat(129))).toThrow("Record id is invalid");
  });
});
