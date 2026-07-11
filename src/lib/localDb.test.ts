import { describe, expect, it } from "vitest";
import { isCachedSessionUsable } from "./localDb";
import type { SessionResponse } from "./types";

function session(offlineExpiresAt?: string): SessionResponse {
  return {
    user: { email: "user@example.com" },
    serverTime: "2026-07-11T00:00:00.000Z",
    schemaVersion: 5,
    features: { r2Backups: false, excelAutosync: false, authMode: "password" },
    offlineExpiresAt
  };
}

describe("isCachedSessionUsable", () => {
  it("requires a valid future offline expiry", () => {
    const now = Date.parse("2026-07-11T00:00:00.000Z");
    expect(isCachedSessionUsable(session("2026-07-11T00:00:01.000Z"), now)).toBe(true);
    expect(isCachedSessionUsable(session("2026-07-10T23:59:59.000Z"), now)).toBe(false);
    expect(isCachedSessionUsable(session(), now)).toBe(false);
    expect(isCachedSessionUsable(session("invalid"), now)).toBe(false);
    expect(isCachedSessionUsable(null, now)).toBe(false);
  });
});
