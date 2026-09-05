import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse, ClientMutation, Task } from "./types";
beforeEach(() => { vi.resetModules(); vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => vi.unstubAllGlobals());
function snapshot(cursor: number): BootstrapResponse {
  return { syncEpoch: "e", syncCursor: cursor, serverTime: "2026-09-05", projects: [], tasks: [], nextIdeas: [], nextProjects: [], settings: {} };
}
function task(id: string): Task {
  return { id, title: id, version: 1, created_at: "2026-09-05", updated_at: "2026-09-05", status: "todo", priority: "medium", sort_order: 0, source: "app", archived: 0 };
}
describe("local database transactions", () => {
  it("reads data and its cursor from one atomic snapshot", async () => {
    const db = await import("./localDb");
    await db.saveBootstrapSnapshot({ ...snapshot(1), tasks: [task("old")] }, true);
    const read = db.loadLocalSnapshot();
    const write = db.saveBootstrapSnapshot({ ...snapshot(2), tasks: [task("new")] }, true);
    const before = await read;
    await write;
    expect(before.syncCursor).toBe(1);
    expect(before.tasks.map((row) => row.id)).toEqual(["old"]);
    const after = await db.loadLocalSnapshot();
    expect(after.syncCursor).toBe(2);
    expect(after.tasks.map((row) => row.id)).toEqual(["new"]);
  });
  it("rolls back earlier writes when a later record cannot be cloned", async () => {
    const db = await import("./localDb");
    const valid = task("valid");
    const invalid = { ...task("invalid"), extra_json: (() => undefined) as unknown as string };
    const mutation: ClientMutation = { id: "m", entity: "task", operation: "upsert", data: valid };
    await expect(db.commitLocalMutation(mutation, { writes: [
      { type: "put", store: "tasks", record: valid },
      { type: "put", store: "tasks", record: invalid }
    ] })).rejects.toMatchObject({ name: "DataCloneError" });
    const after = await db.loadLocalSnapshot();
    expect(after.tasks).toEqual([]);
    expect(after.pendingMutations).toEqual([]);
  });
  it("preserves the durable outbox and its edits when a cloud snapshot arrives", async () => {
    const db = await import("./localDb");
    const local = task("offline");
    const mutation: ClientMutation = { id: "m", entity: "task", operation: "upsert", data: local };
    await db.commitLocalMutation(mutation, { writes: [{ type: "put", store: "tasks", record: local }] });
    await db.saveBootstrapSnapshot(snapshot(2), true);
    const loaded = await db.loadLocalSnapshot();
    expect(loaded.tasks.map((row) => row.id)).toEqual(["offline"]);
    expect(loaded.pendingMutations.map((row) => row.id)).toEqual(["m"]);
  });
});
