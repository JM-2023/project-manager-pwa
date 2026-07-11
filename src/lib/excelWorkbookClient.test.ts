import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkbookBlobInWorker } from "./excelWorkbookClient";
import type { ExportDataResponse } from "./types";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function exportData(): ExportDataResponse {
  return {
    serverTime: "2026-07-11T00:00:00.000Z",
    exportedAt: "2026-07-11T00:00:00.000Z",
    syncEpoch: "epoch-1",
    syncCursor: 1,
    full: true,
    projects: [],
    tasks: [],
    nextProjects: [],
    nextIdeas: [],
    settings: {}
  };
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildWorkbookBlobInWorker", () => {
  it("does not create a worker when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(buildWorkbookBlobInWorker(exportData(), controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("terminates an active worker when the caller aborts", async () => {
    const controller = new AbortController();
    const build = buildWorkbookBlobInWorker(exportData(), controller.signal);
    const worker = FakeWorker.instances[0];

    expect(worker.posted).toHaveLength(1);
    controller.abort();

    await expect(build).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });
});
