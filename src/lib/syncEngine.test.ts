import { describe, expect, it, vi } from "vitest";
import { SyncEngine, type SyncIO } from "./syncEngine";
import type { AppState } from "../state/appStore";
import type { BootstrapResponse, ClientMutation, MutationsResponse, Task } from "./types";

function task(id: string, updatedAt: string, version = 1): Task {
  return {
    id,
    title: id,
    status: "todo",
    priority: "medium",
    sort_order: 0,
    source: "app",
    archived: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
    deleted_at: null,
    version
  };
}

function bootstrapResponse(tasks: Task[]): BootstrapResponse {
  return {
    serverTime: "2026-06-30T12:00:00.000Z",
    projects: [],
    tasks,
    tags: [],
    taskTags: [],
    nextProjects: [],
    nextIdeas: [],
    settings: {}
  };
}

// A SyncIO built entirely from fakes — the whole point of the extraction: the
// state machine can be exercised with no browser, network, or IndexedDB.
function makeIO(overrides: Partial<SyncIO> = {}): SyncIO {
  return {
    getSession: vi.fn(),
    bootstrap: vi.fn(async () => bootstrapResponse([])),
    sendMutations: vi.fn(async (): Promise<MutationsResponse> => ({ ok: true, serverTime: "t", applied: [], conflicts: [] })),
    getExportData: vi.fn(),
    uploadCloudExcel: vi.fn(),
    workbookBlob: vi.fn(),
    queueMutation: vi.fn(async () => undefined),
    getPendingMutations: vi.fn(async () => []),
    removePendingMutations: vi.fn(async () => undefined),
    saveBootstrapSnapshot: vi.fn(async () => undefined),
    saveEntity: vi.fn(async () => undefined),
    resetLocalData: vi.fn(async () => undefined),
    isOnline: () => true,
    now: () => "2026-06-30T00:00:00.000Z",
    ...overrides
  };
}

function makeState(tasks: Task[]): AppState {
  return {
    session: { features: { excelAutosync: false } },
    lastSync: null,
    projects: [],
    tasks,
    tags: [],
    taskTags: [],
    nextProjects: [],
    nextIdeas: [],
    settings: {}
  } as unknown as AppState;
}

describe("SyncEngine.syncNow", () => {
  it("drains a queued mutation, applies the server result, and replaces from bootstrap", async () => {
    const pending: ClientMutation = {
      id: "m1",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: { id: "t1" },
      createdAt: "2026-06-30T00:00:00.000Z"
    };
    const serverTasks = [task("t1", "2026-06-30T11:59:59.000Z", 2)];
    const io = makeIO({
      getPendingMutations: vi.fn(async () => [pending]),
      sendMutations: vi.fn(
        async (): Promise<MutationsResponse> => ({
          ok: true,
          serverTime: "2026-06-30T11:59:59.000Z",
          applied: [{ id: "m1", entity: "task", recordId: "t1", version: 2, updated_at: "2026-06-30T11:59:59.000Z" }],
          conflicts: []
        })
      ),
      bootstrap: vi.fn(async () => bootstrapResponse(serverTasks))
    });
    const stateRef = { current: makeState([task("t1", "2026-06-30T10:00:00.000Z", 1)]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });
    engine.hydratePending([pending]);

    await engine.syncNow();

    expect(io.sendMutations).toHaveBeenCalledOnce();
    expect(io.removePendingMutations).toHaveBeenCalledWith(["m1"]);
    expect(io.bootstrap).toHaveBeenCalledWith(null); // first sync is a full replace
    expect(io.saveBootstrapSnapshot).toHaveBeenCalledOnce();
    expect(stateRef.current.tasks.map((row) => row.id)).toEqual(["t1"]);
    expect(dispatch).toHaveBeenCalledWith({ type: "replaceBootstrap", payload: expect.objectContaining({ serverTime: "2026-06-30T12:00:00.000Z" }) });
    expect(dispatch).toHaveBeenCalledWith({ type: "setSyncStatus", payload: "idle" });
  });

  it("reports offline without touching the network", async () => {
    const io = makeIO({ isOnline: () => false });
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    await engine.syncNow();

    expect(io.bootstrap).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "setSyncStatus", payload: "offline" });
  });
});

describe("SyncEngine.persistMutation", () => {
  it("queues to local storage and tracks the pending mutation", async () => {
    const io = makeIO({ isOnline: () => false }); // offline => no debounce timer scheduled
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    engine.persistMutation({ id: "m9", entity: "task", operation: "upsert", baseVersion: null, data: { id: "t9" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(io.queueMutation).toHaveBeenCalledOnce();
    expect(engine.pendingMutations().map((m) => m.id)).toContain("m9");
    expect(dispatch).toHaveBeenCalledWith({ type: "setPendingCount", payload: 1 });
  });
});
