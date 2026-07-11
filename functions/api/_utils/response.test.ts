import { describe, expect, it } from "vitest";
import { readJson, RequestBodyTooLargeError, requireSameOrigin } from "./response";

describe("bounded request parsing", () => {
  it("rejects an oversized body even without Content-Length", async () => {
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(128) })
    });
    expect(request.headers.has("Content-Length")).toBe(false);
    await expect(readJson(request, 32)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("parses a body below the streaming limit", async () => {
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true })
    });
    await expect(readJson<{ ok: boolean }>(request, 128)).resolves.toEqual({ ok: true });
  });
});

describe("same-origin mutation guard", () => {
  it("rejects requests that omit Origin", () => {
    const response = requireSameOrigin(new Request("https://app.example.com/api/test", { method: "POST" }));
    expect(response?.status).toBe(403);
  });

  it("accepts an exact same-origin request", () => {
    const request = new Request("https://app.example.com/api/test", {
      method: "POST",
      headers: { Origin: "https://app.example.com" }
    });
    expect(requireSameOrigin(request)).toBeNull();
  });
});
