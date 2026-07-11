import { afterEach, describe, expect, it, vi } from "vitest";
import { getExportData, orderRestoreTasksParentFirst, restoreData, uploadCloudExcel } from "./api";
import type { Project, Task } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPendingFetch(): ReturnType<typeof vi.fn> {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function task(id: string, parentTaskId: string | null = null): Task {
  return {
    id,
    title: id,
    status: "todo",
    priority: "medium",
    sort_order: 0,
    parent_task_id: parentTaskId,
    source: "app",
    archived: 0,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    deleted_at: null,
    version: 1
  };
}

describe("orderRestoreTasksParentFirst", () => {
  it("orders every in-backup ancestor before descendants before chunking", () => {
    const ordered = orderRestoreTasksParentFirst([
      task("grandchild", "child"),
      task("unrelated"),
      task("child", "parent"),
      task("parent")
    ]);
    const positions = new Map(ordered.map((row, index) => [row.id, index]));

    expect(positions.get("parent")).toBeLessThan(positions.get("child")!);
    expect(positions.get("child")).toBeLessThan(positions.get("grandchild")!);
    expect(ordered.map((row) => row.id)).toContain("unrelated");
  });

  it("allows references to parents outside the backup", () => {
    expect(orderRestoreTasksParentFirst([task("child", "already-in-database")])).toEqual([
      task("child", "already-in-database")
    ]);
  });

  it("rejects duplicate ids and parent cycles before any request is sent", () => {
    expect(() => orderRestoreTasksParentFirst([task("same"), task("same")])).toThrow("duplicate task id same");
    expect(() => orderRestoreTasksParentFirst([task("a", "b"), task("b", "a")])).toThrow(
      "cyclic task parents"
    );
  });
});

describe("Excel request cancellation", () => {
  it("propagates cancellation while loading export data", async () => {
    const fetchMock = stubPendingFetch();
    const controller = new AbortController();
    const request = getExportData(controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("propagates cancellation during the workbook upload", async () => {
    const fetchMock = stubPendingFetch();
    const controller = new AbortController();
    const request = uploadCloudExcel(new Blob(["xlsx"]), "latest.xlsx", 1, "epoch-1", 1, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("keeps caller cancellation attached while the response body is streaming", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const captured: { signal?: AbortSignal } = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.signal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          captured.signal?.addEventListener("abort", () => controller.error(captured.signal?.reason), { once: true });
        }
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    }));
    const controller = new AbortController();
    const request = getExportData(controller.signal);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    expect(captured.signal?.aborted).toBe(true);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not retry a restore after the page cancels it", async () => {
    const fetchMock = stubPendingFetch();
    const controller = new AbortController();
    const project: Project = {
      id: "p1",
      name: "Project",
      sort_order: 0,
      archived: 0,
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:00:00.000Z",
      deleted_at: null,
      version: 1
    };
    const request = restoreData({ projects: [project], tasks: [], nextProjects: [], nextIdeas: [] }, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
