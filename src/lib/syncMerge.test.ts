import { describe, expect, it } from "vitest";
import {
  compactPendingMutations,
  mergeBootstrapForLocal,
  mergeMutationRecord,
  mergeRecordsForSync,
  mutationRecordKey,
  pendingRecordKeys,
  replayPendingMutations
} from "./syncMerge";
import type { BootstrapResponse, ClientMutation, Task } from "./types";
import type { SyncBootstrapState } from "./syncMerge";

function mutation(partial: Partial<ClientMutation> & Pick<ClientMutation, "id" | "entity" | "operation">): ClientMutation {
  return { baseVersion: null, data: {}, ...partial };
}

function task(id: string, updatedAt: string, extra: Partial<Task> = {}): Task {
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
    version: 1,
    ...extra
  };
}

function emptyState(overrides: Partial<SyncBootstrapState> = {}): SyncBootstrapState {
  return { projects: [], tasks: [], nextProjects: [], nextIdeas: [], settings: {}, ...overrides };
}

function snapshot(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    serverTime: "2026-06-30T00:00:00.000Z",
    syncEpoch: "epoch-1",
    syncCursor: 1,
    projects: [],
    tasks: [],
    nextProjects: [],
    nextIdeas: [],
    settings: {},
    ...overrides
  };
}

describe("mutationRecordKey", () => {
  it("keys settings by key and entities by id", () => {
    expect(mutationRecordKey(mutation({ id: "m2", entity: "setting", operation: "upsert", data: { key: "theme" } }))).toBe("setting:theme");
    expect(mutationRecordKey(mutation({ id: "m3", entity: "task", operation: "upsert", data: { id: "abc" } }))).toBe("task:abc");
    expect(mutationRecordKey(mutation({ id: "m4", entity: "task", operation: "upsert", data: {} }))).toBeNull();
  });
});

describe("compactPendingMutations", () => {
  it("collapses repeated edits of one record to the latest, preserving every source id", () => {
    const groups = compactPendingMutations([
      mutation({ id: "a", entity: "task", operation: "upsert", data: { id: "t1", title: "first" }, createdAt: "2026-01-01T00:00:01.000Z" }),
      mutation({ id: "b", entity: "task", operation: "upsert", data: { id: "t1", title: "second" }, createdAt: "2026-01-01T00:00:02.000Z" }),
      mutation({ id: "c", entity: "task", operation: "upsert", data: { id: "t2", title: "other" }, createdAt: "2026-01-01T00:00:03.000Z" })
    ]);
    expect(groups).toHaveLength(2);
    const t1 = groups.find((group) => mutationRecordKey(group.mutation) === "task:t1");
    expect((t1?.mutation.data as { title: string }).title).toBe("second");
    expect(t1?.sourceIds.sort()).toEqual(["a", "b"]);
  });

  it("never collapses key-less mutations together", () => {
    const groups = compactPendingMutations([
      mutation({ id: "a", entity: "task", operation: "upsert", data: {} }),
      mutation({ id: "b", entity: "task", operation: "upsert", data: {} })
    ]);
    expect(groups).toHaveLength(2);
  });

  it("merges field patches and preserves the earliest base version", () => {
    const groups = compactPendingMutations([
      mutation({
        id: "a",
        entity: "task",
        operation: "upsert",
        baseVersion: 4,
        data: { id: "t1", title: "renamed", due_date: null },
        patch: { title: "renamed" },
        createdAt: "2026-01-01T00:00:01.000Z"
      }),
      mutation({
        id: "b",
        entity: "task",
        operation: "upsert",
        baseVersion: 5,
        data: { id: "t1", title: "renamed", due_date: "2026-02-01" },
        patch: { due_date: "2026-02-01" },
        createdAt: "2026-01-01T00:00:02.000Z"
      })
    ]);
    expect(groups[0].mutation.id).toBe("b");
    expect(groups[0].mutation.baseVersion).toBe(4);
    expect(groups[0].mutation.patch).toEqual({ title: "renamed", due_date: "2026-02-01" });
    expect(groups[0].sourceIds).toEqual(["a", "b"]);
  });

  it("keeps a create as a full-record create after local edits", () => {
    const groups = compactPendingMutations([
      mutation({ id: "create", entity: "task", operation: "upsert", baseVersion: null, data: { id: "t1", title: "first" } }),
      mutation({ id: "edit", entity: "task", operation: "upsert", baseVersion: 1, data: { id: "t1", title: "final" }, patch: { title: "final" } })
    ]);
    expect(groups[0].mutation.baseVersion).toBeNull();
    expect(groups[0].mutation.patch).toBeUndefined();
    expect(groups[0].mutation.data).toEqual({ id: "t1", title: "final" });
  });
});

describe("mergeRecordsForSync", () => {
  const protectedKeys = new Set<string>();

  it("accepts cursor-ordered incoming rows without relying on wall-clock timestamps", () => {
    const local = [task("t1", "2026-06-30T10:00:00.000Z", { title: "local-new" })];
    const incomingNewer = [task("t1", "2026-06-30T11:00:00.000Z", { title: "server-newer" })];
    const incomingOlder = [task("t1", "2026-06-30T09:00:00.000Z", { title: "server-older" })];

    expect(mergeRecordsForSync(local, incomingNewer, "task", protectedKeys, false)[0].title).toBe("server-newer");
    expect(mergeRecordsForSync(local, incomingOlder, "task", protectedKeys, false)[0].title).toBe("server-older");
  });

  it("protects un-synced local edits from being overwritten by the server", () => {
    const local = [task("t1", "2026-06-30T09:00:00.000Z", { title: "pending-local" })];
    const incoming = [task("t1", "2026-06-30T12:00:00.000Z", { title: "server" })];
    const guarded = mergeRecordsForSync(local, incoming, "task", new Set(["task:t1"]), false);
    expect(guarded[0].title).toBe("pending-local");
  });

  it("drops local rows missing from the server in replace mode, unless protected", () => {
    const local = [task("stale", "2026-06-30T09:00:00.000Z"), task("kept", "2026-06-30T09:00:00.000Z", { title: "pending" })];
    const incoming = [task("fresh", "2026-06-30T10:00:00.000Z")];
    const replaced = mergeRecordsForSync(local, incoming, "task", new Set(["task:kept"]), true);
    const ids = replaced.map((row) => row.id).sort();
    expect(ids).toEqual(["fresh", "kept"]);
  });

  it("removes an unprotected row when an incremental tombstone arrives", () => {
    const local = [task("t1", "2026-06-30T10:00:00.000Z")];
    const tombstone = task("t1", "2026-06-30T11:00:00.000Z", { deleted_at: "2026-06-30T11:00:00.000Z" });
    expect(mergeRecordsForSync(local, [tombstone], "task", protectedKeys, false)).toEqual([]);
    expect(mergeRecordsForSync(local, [tombstone], "task", new Set(["task:t1"]), false)).toEqual(local);
  });
});

describe("mergeBootstrapForLocal", () => {
  it("hides next ideas whose parent has a pending purge", () => {
    const current = emptyState({
      nextIdeas: [{ id: "i1", next_project_id: "p1", title: "idea", sort_order: 0, created_at: "x", updated_at: "x", deleted_at: null, version: 1 }]
    });
    const pending: ClientMutation[] = [mutation({ id: "m", entity: "next_project", operation: "purge", data: { id: "p1" } })];
    const merged = mergeBootstrapForLocal(current, snapshot({ nextIdeas: current.nextIdeas }), pending, false);
    expect(merged.nextIdeas).toHaveLength(0);
  });

  it("derives protected keys from the pending queue", () => {
    const keys = pendingRecordKeys([
      mutation({ id: "m1", entity: "task", operation: "upsert", data: { id: "t1" } }),
      mutation({ id: "m2", entity: "setting", operation: "upsert", data: { key: "theme" } })
    ]);
    expect(keys).toEqual(new Set(["task:t1", "setting:theme"]));
  });
});

describe("replayPendingMutations", () => {
  it("merges disjoint same-version patches from different tabs field by field", () => {
    const original = task("t1", "2026-06-30T10:00:00.000Z", { title: "original", notes: "original note", version: 4 });
    const titleEdit = task("t1", "2026-06-30T10:01:00.000Z", {
      title: "tab A title",
      notes: "original note",
      version: 5
    });
    const notesEdit = task("t1", "2026-06-30T10:02:00.000Z", {
      title: "original",
      notes: "tab B note",
      version: 5
    });
    const mutations: ClientMutation[] = [
      mutation({
        id: "tab-a",
        entity: "task",
        operation: "upsert",
        baseVersion: 4,
        data: titleEdit,
        patch: { title: titleEdit.title },
        createdAt: "2026-06-30T10:01:00.000Z"
      }),
      mutation({
        id: "tab-b",
        entity: "task",
        operation: "upsert",
        baseVersion: 4,
        data: notesEdit,
        patch: { notes: notesEdit.notes },
        createdAt: "2026-06-30T10:02:00.000Z"
      })
    ];

    const replayed = replayPendingMutations(emptyState({ tasks: [original] }), mutations);
    expect(replayed.tasks[0]).toEqual(
      expect.objectContaining({ title: "tab A title", notes: "tab B note", version: 5, updated_at: notesEdit.updated_at })
    );

    // commitLocalMutation and bootstrap replay share this merge primitive, so
    // a later full-record payload cannot erase a field it did not patch.
    const committedA = mergeMutationRecord(original as unknown as Record<string, unknown>, mutations[0]);
    const committedB = mergeMutationRecord(committedA, mutations[1]);
    expect(committedB).toEqual(expect.objectContaining({ title: "tab A title", notes: "tab B note" }));
  });

  it("does not revive a child upsert queued after its parent delete", () => {
    const child = task("t1", "2026-06-30T12:00:00.000Z", { project_id: "p1" });
    const replayed = replayPendingMutations(emptyState(), [
      mutation({ id: "delete", entity: "project", operation: "delete", data: { id: "p1", taskIds: ["t1"] }, createdAt: "1" }),
      mutation({ id: "child", entity: "task", operation: "upsert", data: child, patch: { title: child.title }, createdAt: "2" })
    ]);
    expect(replayed.tasks).toEqual([]);
  });
});
