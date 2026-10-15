import { describe, expect, it } from "vitest";
import type { AppContext } from "./api/_utils/types";
import { isSideAddress, onRequest } from "./_middleware";

function contextFor(url: string): { context: AppContext; reached: () => boolean } {
  let reached = false;
  const context = {
    request: new Request(url),
    next: async () => {
      reached = true;
      return new Response("app", { status: 200 });
    }
  } as unknown as AppContext;
  return { context, reached: () => reached };
}

describe("side addresses", () => {
  it("tells the project's own address from deployment and branch aliases", () => {
    expect(isSideAddress("project-manager-pwa.pages.dev")).toBe(false);
    expect(isSideAddress("b082466f.project-manager-pwa.pages.dev")).toBe(true);
    expect(isSideAddress("settle-preview.project-manager-pwa.pages.dev")).toBe(true);
    expect(isSideAddress("localhost")).toBe(false);
    expect(isSideAddress("tasks.example.com")).toBe(false);
  });

  it("answers 404 on a side address without reaching the app", async () => {
    for (const path of ["/", "/api/auth/status", "/api/bootstrap", "/sw.js"]) {
      const { context, reached } = contextFor(`https://b082466f.project-manager-pwa.pages.dev${path}`);
      const response = await onRequest(context);
      expect(response.status).toBe(404);
      expect(reached()).toBe(false);
    }
  });

  it("serves the project's own address with the security headers", async () => {
    const { context, reached } = contextFor("https://project-manager-pwa.pages.dev/");
    const response = await onRequest(context);
    expect(response.status).toBe(200);
    expect(reached()).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
