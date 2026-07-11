import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError, AuthRequiredError } from "./api";
import { WorkbookWorkerBuildError, WorkbookWorkerTimeoutError } from "./excelWorkbookClient";
import { SyncEngine, type SyncIO } from "./syncEngine";
import type { AppState } from "../state/appStore";
import type { BootstrapResponse, ClientMutation, ExportDataResponse, MutationsResponse, Task } from "./types";
import type { LocalMutationCommit, LocalSnapshot } from "./localDb";

afterEach(() => {
  vi.useRealTimers();
});

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
    syncEpoch: "epoch-1",
    syncCursor: 2,
    full: true,
    projects: [],
    tasks,
    nextProjects: [],
    nextIdeas: [],
    settings: {}
  };
}

function localSnapshot(tasks: Task[] = [], pendingMutations: ClientMutation[] = []): LocalSnapshot {
  return {
    projects: [],
    tasks,
    nextProjects: [],
    nextIdeas: [],
    settings: {},
    pendingMutations,
    lastSync: null,
    syncEpoch: null,
    syncCursor: null,
    session: null
  };
}

function exportData(tasks: Task[] = []): ExportDataResponse {
  return {
    ...bootstrapResponse(tasks),
    exportedAt: "2026-06-30T12:00:00.000Z"
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
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
    commitLocalMutation: vi.fn(async () => undefined),
    loadLocalSnapshot: vi.fn(async () => ({
      projects: [],
      tasks: [],
      nextProjects: [],
      nextIdeas: [],
      settings: {},
      pendingMutations: [],
      lastSync: null,
      syncEpoch: null,
      syncCursor: null,
      session: null
    })),
    getPendingMutations: vi.fn(async () => []),
    removePendingMutations: vi.fn(async () => undefined),
    saveBootstrapSnapshot: vi.fn(async () => undefined),
    saveLocalSession: vi.fn(async () => undefined),
    saveLastSync: vi.fn(async () => undefined),
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
    nextProjects: [],
    nextIdeas: [],
    settings: {},
    syncEpoch: null,
    syncCursor: null
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
    let outbox = [pending];
    const io = makeIO({
      getPendingMutations: vi.fn(async () => outbox),
      removePendingMutations: vi.fn(async (ids: string[]) => {
        const removed = new Set(ids);
        outbox = outbox.filter((mutation) => !removed.has(mutation.id));
      }),
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
    expect(io.bootstrap).toHaveBeenCalledWith(null, null);
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

  it("atomically rebases a version conflict over the server record and keeps it pending", async () => {
    vi.useFakeTimers();
    const first: ClientMutation = {
      id: "m1",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: { ...task("t1", "2026-06-30T10:00:00.000Z", 2), title: "local title" },
      patch: { title: "local title" },
      createdAt: "2026-06-30T10:00:00.000Z"
    };
    const second: ClientMutation = {
      id: "m2",
      entity: "task",
      operation: "upsert",
      baseVersion: 2,
      data: { ...task("t1", "2026-06-30T10:01:00.000Z", 3), title: "local title", due_date: "2026-07-01" },
      patch: { due_date: "2026-07-01" },
      createdAt: "2026-06-30T10:01:00.000Z"
    };
    let outbox = [first, second];
    const commitLocalMutation = vi.fn(async (mutation: ClientMutation, commit: LocalMutationCommit = {}) => {
      const removed = new Set(commit.removePendingIds ?? []);
      outbox = outbox.filter((item) => !removed.has(item.id));
      outbox.push(mutation);
    });
    const serverRecord = { ...task("t1", "2026-06-30T11:00:00.000Z", 7), title: "server title", notes: "server note" };
    const io = makeIO({
      getPendingMutations: vi.fn(async () => outbox),
      commitLocalMutation,
      sendMutations: vi.fn(async (): Promise<MutationsResponse> => ({
        ok: true,
        serverTime: "2026-06-30T11:00:00.000Z",
        applied: [],
        conflicts: [{ id: "m2", entity: "task", recordId: "t1", reason: "Version conflict", permanent: false, serverRecord }]
      }))
    });
    const stateRef = { current: makeState([first.data as Task]) };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });
    engine.hydratePending(outbox);

    await engine.syncNow();

    const rebased = outbox[0];
    expect(outbox).toHaveLength(1);
    expect(rebased.id).toBe("m2");
    expect(rebased.baseVersion).toBe(7);
    expect(rebased.patch).toEqual({ title: "local title", due_date: "2026-07-01" });
    expect(rebased.data).toEqual(expect.objectContaining({ title: "local title", due_date: "2026-07-01", notes: "server note", version: 8 }));
    expect(commitLocalMutation).toHaveBeenCalledWith(expect.objectContaining({ id: "m2", baseVersion: 7 }), expect.objectContaining({ removePendingIds: ["m1", "m2"] }));
    expect(stateRef.current.tasks[0]).toEqual(expect.objectContaining({ title: "local title", notes: "server note", version: 8 }));
    engine.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("removes a permanent conflict in the same local transaction that restores the full snapshot", async () => {
    const pending: ClientMutation = {
      id: "stale-delete",
      entity: "task",
      operation: "delete",
      baseVersion: 1,
      data: { id: "t1" },
      createdAt: "2026-06-30T10:00:00.000Z"
    };
    const serverTask = { ...task("t1", "2026-06-30T11:00:00.000Z", 3), title: "newer server edit" };
    let outbox = [pending];
    const saveBootstrapSnapshot = vi.fn(async (_snapshot: BootstrapResponse, _replace: boolean, removeIds: string[] = []) => {
      const removed = new Set(removeIds);
      outbox = outbox.filter((mutation) => !removed.has(mutation.id));
    });
    const io = makeIO({
      getPendingMutations: vi.fn(async () => outbox),
      sendMutations: vi.fn(async (): Promise<MutationsResponse> => ({
        ok: true,
        serverTime: "2026-06-30T11:00:00.000Z",
        applied: [],
        conflicts: [{ id: pending.id, entity: "task", recordId: "t1", reason: "Record changed before deletion", permanent: true, serverRecord: serverTask }]
      })),
      bootstrap: vi.fn(async () => bootstrapResponse([serverTask])),
      saveBootstrapSnapshot
    });
    const stateRef = { current: makeState([]) };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });
    engine.hydratePending(outbox);

    await engine.syncNow();

    expect(io.bootstrap).toHaveBeenCalledWith(null, null);
    expect(saveBootstrapSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tasks: [serverTask] }), true, ["stale-delete"]);
    expect(outbox).toEqual([]);
    expect(stateRef.current.tasks).toEqual([serverTask]);
  });

  it("persists only lastSync for a truly empty cursor delta and preserves entity references", async () => {
    const rows = [task("unchanged", "2026-06-30T10:00:00.000Z", 2)];
    const response: BootstrapResponse = {
      ...bootstrapResponse([]),
      serverTime: "2026-06-30T12:05:00.000Z",
      syncEpoch: "epoch-1",
      syncCursor: 9,
      full: false
    };
    const io = makeIO({ bootstrap: vi.fn(async () => response) });
    const stateRef = { current: { ...makeState(rows), syncEpoch: "epoch-1", syncCursor: 9 } };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    await engine.syncNow();

    expect(stateRef.current.tasks).toBe(rows);
    expect(io.saveLastSync).toHaveBeenCalledWith(response.serverTime);
    expect(io.saveBootstrapSnapshot).not.toHaveBeenCalled();
  });

  it("contains a shared in-flight rejection for every concurrent caller", async () => {
    let rejectBootstrap!: (reason: unknown) => void;
    const bootstrapPromise = new Promise<BootstrapResponse>((_resolve, reject) => {
      rejectBootstrap = reject;
    });
    const io = makeIO({ bootstrap: vi.fn(() => bootstrapPromise) });
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    const first = engine.syncNow();
    await flushMicrotasks();
    const second = engine.syncNow();
    rejectBootstrap(new AuthRequiredError());

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(stateRef.current.session).toBeNull();
    expect(io.saveLocalSession).toHaveBeenCalledWith(null);
    expect(dispatch).toHaveBeenCalledWith({ type: "setAuthRequired", payload: true });
  });

  it("keeps a conflict visible while a later independent batch succeeds, then clears it on a quiet poll", async () => {
    vi.useFakeTimers();
    const allPending = Array.from({ length: 11 }, (_, index): ClientMutation => ({
      id: `m${index}`,
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: { ...task(`t${index}`, `2026-06-30T10:00:${String(index).padStart(2, "0")}.000Z`, 2), title: `edit ${index}` },
      patch: { title: `edit ${index}` },
      createdAt: `2026-06-30T10:00:${String(index).padStart(2, "0")}.000Z`
    }));
    let outbox = [...allPending];
    const conflict = {
      id: "m0",
      entity: "task" as const,
      recordId: "t0",
      reason: "Server rejected the first record",
      permanent: true
    };
    let mutationCall = 0;
    let bootstrapCall = 0;
    const io = makeIO({
      getPendingMutations: vi.fn(async () => outbox),
      removePendingMutations: vi.fn(async (ids: string[]) => {
        const removed = new Set(ids);
        outbox = outbox.filter((mutation) => !removed.has(mutation.id));
      }),
      saveBootstrapSnapshot: vi.fn(async (_snapshot, _replace, removeIds = []) => {
        const removed = new Set(removeIds);
        outbox = outbox.filter((mutation) => !removed.has(mutation.id));
      }),
      sendMutations: vi.fn(async (_clientId: string, mutations: ClientMutation[]): Promise<MutationsResponse> => {
        mutationCall += 1;
        if (mutationCall === 1) {
          return {
            ok: true,
            serverTime: "first",
            applied: mutations.slice(1).map((mutation) => ({
              id: mutation.id,
              entity: mutation.entity,
              recordId: String((mutation.data as { id: string }).id)
            })),
            conflicts: [conflict]
          };
        }
        return {
          ok: true,
          serverTime: "second",
          applied: mutations.map((mutation) => ({
            id: mutation.id,
            entity: mutation.entity,
            recordId: String((mutation.data as { id: string }).id)
          })),
          conflicts: []
        };
      }),
      bootstrap: vi.fn(async (): Promise<BootstrapResponse> => {
        bootstrapCall += 1;
        return {
          ...bootstrapResponse([]),
          syncCursor: bootstrapCall + 1,
          full: bootstrapCall === 1
        };
      })
    });
    const stateRef = { current: { ...makeState([]), conflicts: [] } };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });
    engine.hydratePending(outbox);

    await engine.syncNow();
    expect(stateRef.current.conflicts).toEqual([conflict]);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks(20);

    expect(io.sendMutations).toHaveBeenCalledTimes(2);
    expect(stateRef.current.conflicts).toEqual([conflict]);

    await engine.syncNow();
    expect(stateRef.current.conflicts).toEqual([]);
    engine.dispose();
  });
});

describe("SyncEngine.persistMutation", () => {
  it("shows a mutation as pending only after the atomic local commit succeeds", async () => {
    let resolveCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    const io = makeIO({ commitLocalMutation: vi.fn(() => committed), isOnline: () => false });
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    engine.persistMutation({ id: "m9", entity: "task", operation: "upsert", baseVersion: null, data: { id: "t9" } });
    await Promise.resolve();
    expect(engine.pendingMutations()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "setPendingCount", payload: 1 });

    resolveCommit();
    await Promise.resolve();
    await Promise.resolve();

    expect(io.commitLocalMutation).toHaveBeenCalledOnce();
    expect(engine.pendingMutations().map((m) => m.id)).toContain("m9");
    expect(dispatch).toHaveBeenCalledWith({ type: "setPendingCount", payload: 1 });
  });

  it("restores the durable snapshot and shows an error when the atomic commit fails offline", async () => {
    const durable = { ...task("t1", "2026-06-30T10:00:00.000Z", 1), title: "durable title" };
    const optimistic = { ...durable, title: "optimistic title", version: 2 };
    const io = makeIO({
      commitLocalMutation: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
      loadLocalSnapshot: vi.fn(async () => localSnapshot([durable])),
      isOnline: () => false
    });
    const stateRef = { current: makeState([optimistic]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    engine.persistMutation({
      id: "failed",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: optimistic,
      patch: { title: optimistic.title }
    });
    await flushMicrotasks(20);

    expect(stateRef.current.tasks).toEqual([durable]);
    expect(engine.pendingMutations()).toEqual([]);
    expect(dispatch).toHaveBeenCalledWith({ type: "setError", payload: "Local save failed: quota exceeded" });
    expect(dispatch).toHaveBeenCalledWith({ type: "setSyncStatus", payload: "error" });
  });

  it("replays a successful sibling commit after another concurrent commit rolls the UI back", async () => {
    let rejectFailed!: (reason: unknown) => void;
    let resolveSuccessful!: (mutation: ClientMutation) => void;
    let resolveRestore!: (snapshot: LocalSnapshot) => void;
    const failedCommit = new Promise<ClientMutation>((_resolve, reject) => {
      rejectFailed = reject;
    });
    const successfulCommit = new Promise<ClientMutation>((resolve) => {
      resolveSuccessful = resolve;
    });
    const restore = new Promise<LocalSnapshot>((resolve) => {
      resolveRestore = resolve;
    });
    const successfulTask = { ...task("kept", "2026-06-30T10:01:00.000Z", 2), title: "kept edit" };
    const failedTask = { ...task("rolled-back", "2026-06-30T10:00:00.000Z", 2), title: "lost edit" };
    const successfulMutation: ClientMutation = {
      id: "successful",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: successfulTask,
      patch: { title: successfulTask.title }
    };
    const io = makeIO({
      commitLocalMutation: vi.fn((mutation) => (mutation.id === "failed" ? failedCommit : successfulCommit)),
      loadLocalSnapshot: vi.fn(() => restore),
      isOnline: () => false
    });
    const stateRef = { current: makeState([failedTask, successfulTask]) };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.persistMutation({
      id: "failed",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: failedTask,
      patch: { title: failedTask.title }
    });
    engine.persistMutation(successfulMutation);
    rejectFailed(new Error("write failed"));
    await flushMicrotasks();
    resolveSuccessful(successfulMutation);
    await flushMicrotasks();
    resolveRestore(localSnapshot());
    await flushMicrotasks(24);

    expect(stateRef.current.tasks).toEqual([successfulTask]);
    expect(engine.pendingMutations().map((mutation) => mutation.id)).toEqual(["successful"]);
  });

  it("waits for an in-flight local commit before suspend returns the durable outbox", async () => {
    let resolveCommit!: (mutation: ClientMutation) => void;
    const outbox: ClientMutation[] = [];
    const committed = new Promise<ClientMutation>((resolve) => {
      resolveCommit = resolve;
    });
    const io = makeIO({
      commitLocalMutation: vi.fn(() => committed),
      getPendingMutations: vi.fn(async () => outbox),
      isOnline: () => false
    });
    const stateRef = { current: makeState([]) };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });
    const mutation: ClientMutation = {
      id: "pending-at-logout",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: task("pending", "2026-06-30T10:00:00.000Z", 1)
    };

    engine.persistMutation(mutation);
    let suspended = false;
    const suspension = engine.suspend().then((pending) => {
      suspended = true;
      return pending;
    });
    await flushMicrotasks();
    expect(suspended).toBe(false);

    outbox.push(mutation);
    resolveCommit(mutation);
    await expect(suspension).resolves.toEqual([mutation]);
  });
});

describe("SyncEngine cloud Excel scheduling", () => {
  it("schedules from the merged current settings even when the bootstrap delta is empty", async () => {
    vi.useFakeTimers();
    const getExportData = vi.fn(async () => exportData());
    const uploadCloudExcel = vi.fn(async () => ({
      ok: true as const,
      key: "latest.xlsx",
      archiveKey: "archive.xlsx",
      etag: "etag",
      updatedAt: "2026-06-30T12:01:00.000Z"
    }));
    const io = makeIO({
      bootstrap: vi.fn(async () => ({
        ...bootstrapResponse([]),
        full: false,
        syncEpoch: "epoch-1",
        syncCursor: 7,
        settings: {}
      })),
      getExportData,
      workbookBlob: vi.fn(async () => new Blob(["xlsx"])),
      uploadCloudExcel
    });
    const stateRef: { current: AppState } = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } },
        settings: { excel_dirty_at: "dirty-1" },
        syncEpoch: "epoch-1",
        syncCursor: 7
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    await engine.syncNow();
    expect(getExportData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(getExportData).toHaveBeenCalledOnce();
    expect(uploadCloudExcel).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it("blocks repeated retries for a permanent HTTP failure until the dirty token changes", async () => {
    vi.useFakeTimers();
    const uploadCloudExcel = vi.fn(async () => {
      throw new ApiResponseError("payload too large", 413);
    });
    const io = makeIO({
      getExportData: vi.fn(async () => exportData()),
      workbookBlob: vi.fn(async () => new Blob(["xlsx"])),
      uploadCloudExcel
    });
    const stateRef = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } },
        settings: { excel_dirty_at: "dirty-1" }
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-1");
    await vi.runAllTimersAsync();
    engine.scheduleCloudExcelUpload(0, "dirty-1");
    await vi.runAllTimersAsync();
    expect(uploadCloudExcel).toHaveBeenCalledTimes(1);

    engine.scheduleCloudExcelUpload(0, "dirty-2");
    await vi.runAllTimersAsync();
    expect(uploadCloudExcel).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("retries a transient HTTP failure and stops on authentication failure", async () => {
    vi.useFakeTimers();
    const uploadCloudExcel = vi
      .fn()
      .mockRejectedValueOnce(new ApiResponseError("temporary", 503))
      .mockResolvedValueOnce({
        ok: true,
        key: "latest.xlsx",
        archiveKey: "archive.xlsx",
        etag: "etag",
        updatedAt: "2026-06-30T12:01:00.000Z"
      });
    const io = makeIO({
      getExportData: vi.fn(async () => exportData()),
      workbookBlob: vi.fn(async () => new Blob(["xlsx"])),
      uploadCloudExcel
    });
    const stateRef = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } },
        settings: { excel_dirty_at: "dirty-transient" }
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-transient");
    await vi.runAllTimersAsync();
    expect(uploadCloudExcel).toHaveBeenCalledTimes(2);

    uploadCloudExcel.mockRejectedValueOnce(new AuthRequiredError());
    stateRef.current.settings = { excel_dirty_at: "dirty-auth" };
    engine.scheduleCloudExcelUpload(0, "dirty-auth");
    await vi.runAllTimersAsync();
    expect(uploadCloudExcel).toHaveBeenCalledTimes(3);
    expect(stateRef.current.session).toBeNull();
    expect(io.saveLocalSession).toHaveBeenCalledWith(null);

    engine.scheduleCloudExcelUpload(0, "dirty-auth");
    await vi.runAllTimersAsync();
    expect(uploadCloudExcel).toHaveBeenCalledTimes(3);
    engine.dispose();
  });

  it("aborts and waits for an in-flight Excel build before suspension completes", async () => {
    vi.useFakeTimers();
    let exportSignal: AbortSignal | undefined;
    const getExportData = vi.fn((signal?: AbortSignal) => {
      exportSignal = signal;
      return new Promise<ExportDataResponse>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const uploadCloudExcel = vi.fn();
    const io = makeIO({ getExportData, uploadCloudExcel });
    const stateRef = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } }
      }
    };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-in-flight");
    await vi.advanceTimersByTimeAsync(0);
    expect(getExportData).toHaveBeenCalledOnce();
    expect(exportSignal?.aborted).toBe(false);

    let suspensionFinished = false;
    const suspension = engine.suspend().then(() => {
      suspensionFinished = true;
    });
    expect(exportSignal?.aborted).toBe(true);
    expect(suspensionFinished).toBe(false);
    await suspension;

    expect(uploadCloudExcel).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setError", payload: expect.stringContaining("Cloud Excel sync failed") })
    );
  });

  it("preserves a newer dirty-token timer when an older upload fails", async () => {
    vi.useFakeTimers();
    let rejectOldUpload!: (error: Error) => void;
    const oldUpload = new Promise<never>((_resolve, reject) => {
      rejectOldUpload = reject;
    });
    const uploadCloudExcel = vi
      .fn()
      .mockImplementationOnce(() => oldUpload)
      .mockResolvedValueOnce({
        ok: true,
        key: "latest.xlsx",
        archiveKey: "archive.xlsx",
        etag: "etag",
        updatedAt: "2026-06-30T12:01:00.000Z"
      });
    const io = makeIO({
      getExportData: vi.fn(async () => exportData()),
      workbookBlob: vi.fn(async () => new Blob(["xlsx"])),
      uploadCloudExcel
    });
    const stateRef = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } },
        settings: { excel_dirty_at: "dirty-old" }
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-old");
    await vi.advanceTimersByTimeAsync(0);
    expect(uploadCloudExcel).toHaveBeenCalledTimes(1);

    stateRef.current.settings = { excel_dirty_at: "dirty-new" };
    engine.scheduleCloudExcelUpload(100, "dirty-new");
    rejectOldUpload(new ApiResponseError("temporary", 503));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(uploadCloudExcel).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("blocks deterministic worker failures and caps repeated worker timeouts for one token", async () => {
    vi.useFakeTimers();
    const workbookBlob = vi.fn()
      .mockRejectedValueOnce(new WorkbookWorkerBuildError("invalid workbook"))
      .mockRejectedValueOnce(new WorkbookWorkerTimeoutError())
      .mockRejectedValueOnce(new WorkbookWorkerTimeoutError());
    const io = makeIO({
      getExportData: vi.fn(async () => exportData()),
      workbookBlob
    });
    const stateRef = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } }
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-build");
    await vi.runAllTimersAsync();
    engine.scheduleCloudExcelUpload(0, "dirty-build");
    await vi.runAllTimersAsync();
    expect(workbookBlob).toHaveBeenCalledTimes(1);

    stateRef.current.settings = { excel_dirty_at: "dirty-timeout" };
    engine.scheduleCloudExcelUpload(0, "dirty-timeout");
    await vi.runAllTimersAsync();
    expect(workbookBlob).toHaveBeenCalledTimes(3);
    engine.scheduleCloudExcelUpload(0, "dirty-timeout");
    await vi.runAllTimersAsync();
    expect(workbookBlob).toHaveBeenCalledTimes(3);
    engine.dispose();
  });

  it("does not retry an old failure after another tab clears the dirty marker", async () => {
    vi.useFakeTimers();
    let rejectUpload!: (error: Error) => void;
    const upload = new Promise<never>((_resolve, reject) => {
      rejectUpload = reject;
    });
    const uploadCloudExcel = vi.fn(() => upload);
    const io = makeIO({
      getExportData: vi.fn(async () => exportData()),
      workbookBlob: vi.fn(async () => new Blob(["xlsx"])),
      uploadCloudExcel
    });
    const stateRef: { current: AppState } = {
      current: {
        ...makeState([]),
        session: { ...makeState([]).session!, features: { r2Backups: false, authMode: "password", excelAutosync: true } },
        settings: { excel_dirty_at: "dirty-peer" }
      }
    };
    const engine = new SyncEngine({ stateRef, dispatch: vi.fn(), clientId: "client", io });

    engine.scheduleCloudExcelUpload(0, "dirty-peer");
    await vi.advanceTimersByTimeAsync(0);
    stateRef.current.settings = { excel_dirty_at: null };
    rejectUpload(new ApiResponseError("temporary", 503));
    await flushMicrotasks();
    await vi.runAllTimersAsync();

    expect(uploadCloudExcel).toHaveBeenCalledTimes(1);
    engine.dispose();
  });
});

describe("SyncEngine.adoptPendingFromStorage", () => {
  it("replays another tab's durable outbox while offline", async () => {
    const peerTask = task("peer", "2026-06-30T12:00:00.000Z", 2);
    const pending: ClientMutation = {
      id: "peer-mutation",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: peerTask,
      patch: { title: peerTask.title },
      createdAt: "2026-06-30T12:00:00.000Z"
    };
    const io = makeIO({ getPendingMutations: vi.fn(async () => [pending]), isOnline: () => false });
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    await engine.adoptPendingFromStorage();

    expect(stateRef.current.tasks).toEqual([peerTask]);
    expect(dispatch).toHaveBeenCalledWith({ type: "setPendingCount", payload: 1 });
    expect(io.bootstrap).not.toHaveBeenCalled();
  });
});

describe("SyncEngine.forceFullResync", () => {
  it("preserves a durable mutation that appears while the full bootstrap is in flight", async () => {
    let resolveBootstrap!: (value: BootstrapResponse) => void;
    const bootstrapPromise = new Promise<BootstrapResponse>((resolve) => {
      resolveBootstrap = resolve;
    });
    const pendingTask = task("local", "2026-06-30T12:01:00.000Z", 2);
    const pending: ClientMutation = {
      id: "during-fetch",
      entity: "task",
      operation: "upsert",
      baseVersion: 1,
      data: pendingTask,
      patch: { title: pendingTask.title },
      createdAt: "2026-06-30T12:01:00.000Z"
    };
    const outbox: ClientMutation[] = [];
    const io = makeIO({
      bootstrap: vi.fn(() => bootstrapPromise),
      getPendingMutations: vi.fn(async () => outbox)
    });
    const stateRef = { current: makeState([]) };
    const dispatch = vi.fn();
    const engine = new SyncEngine({ stateRef, dispatch, clientId: "client", io });

    const resync = engine.forceFullResync();
    await Promise.resolve();
    outbox.push(pending);
    stateRef.current = { ...stateRef.current, tasks: [pendingTask] };
    resolveBootstrap(bootstrapResponse([]));
    await resync;

    expect(stateRef.current.tasks.map((row) => row.id)).toEqual(["local"]);
    expect(io.saveBootstrapSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tasks: [pendingTask] }), true);
  });
});
