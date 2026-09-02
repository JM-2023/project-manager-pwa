import { beforeEach, describe, expect, it } from "vitest";
import { clearSyncTrace, describeError, formatSyncTrace, readSyncTrace, subscribeSyncTrace, trace } from "./syncTrace";

describe("syncTrace", () => {
  beforeEach(() => {
    clearSyncTrace();
  });

  it("records steps newest last and notifies subscribers with a fresh snapshot", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeSyncTrace(() => seen.push(readSyncTrace().length));
    const before = readSyncTrace();
    trace("cycle start");
    trace("cycle done", "12ms");
    unsubscribe();
    trace("ignored after unsubscribe");

    expect(seen).toEqual([1, 2]);
    expect(readSyncTrace()).not.toBe(before);
    expect(readSyncTrace().map((entry) => entry.step)).toEqual(["cycle start", "cycle done", "ignored after unsubscribe"]);
    expect(readSyncTrace()[1].detail).toBe("12ms");
  });

  it("keeps only the most recent entries", () => {
    for (let index = 0; index < 400; index += 1) trace(`step ${index}`);
    const entries = readSyncTrace();
    expect(entries.length).toBeLessThanOrEqual(160);
    expect(entries.at(-1)?.step).toBe("step 399");
  });

  it("formats entries and errors for a screenshot or clipboard", () => {
    trace("commit failed", describeError(new DOMException("closing", "InvalidStateError")));
    const text = formatSyncTrace(readSyncTrace());
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} commit failed — InvalidStateError: closing$/);
    expect(describeError("plain")).toBe("plain");
    expect(describeError({ name: "QuotaExceededError", message: "full" })).toBe("QuotaExceededError: full");
  });
});
