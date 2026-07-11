import { describe, expect, it } from "vitest";
import {
  autosyncObjectKey,
  autosyncRetentionDeletes,
  isLegacyAutosyncObject,
  pruneAutosyncHistory
} from "./excel-state";

function listedObject(key: string, uploaded: string): Pick<R2Object, "key" | "uploaded"> {
  return { key, uploaded: new Date(uploaded) };
}

describe("Cloud Excel R2 retention", () => {
  it("uses one lexicographically ordered key for each user revision", () => {
    expect(autosyncObjectKey("user/one", "epoch/one", 42)).toBe(
      "autosync/user%2Fone/epoch%2Fone/0000000000000042.xlsx"
    );
    expect(autosyncObjectKey("user/one", "epoch/one", 42)).toBe(
      autosyncObjectKey("user/one", "epoch/one", 42)
    );
    expect(autosyncObjectKey("user/one", "epoch/one", 9) < autosyncObjectKey("user/one", "epoch/one", 42)).toBe(true);
  });

  it("keeps the current revision, four predecessors, and any higher in-flight cursor", () => {
    const userId = "user-1";
    const epoch = "epoch-1";
    const uploaded = "2026-07-11T12:00:00.000Z";
    const objects = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((cursor) =>
      listedObject(autosyncObjectKey(userId, epoch, cursor), uploaded)
    );
    const state = { recentOlderKeys: [] as string[] };

    const deletes = autosyncRetentionDeletes(
      objects,
      userId,
      epoch,
      9,
      new Date("2026-07-11T12:00:01.000Z"),
      state
    );

    expect(deletes).toEqual([1, 2, 3, 4].map((cursor) => autosyncObjectKey(userId, epoch, cursor)));
    expect(state.recentOlderKeys).toEqual([5, 6, 7, 8].map((cursor) => autosyncObjectKey(userId, epoch, cursor)));
    expect(deletes).not.toContain(autosyncObjectKey(userId, epoch, 9));
    expect(deletes).not.toContain(autosyncObjectKey(userId, epoch, 10));
  });

  it("deletes older epochs but protects an object uploaded after the current revision", () => {
    const userId = "user-1";
    const state = { recentOlderKeys: [] as string[] };
    const oldEpochKey = autosyncObjectKey(userId, "epoch-old", 3);
    const futureEpochKey = autosyncObjectKey(userId, "epoch-future", 1);

    const deletes = autosyncRetentionDeletes(
      [
        listedObject(oldEpochKey, "2026-07-11T11:59:00.000Z"),
        listedObject(futureEpochKey, "2026-07-11T12:01:00.000Z")
      ],
      userId,
      "epoch-current",
      4,
      new Date("2026-07-11T12:00:00.000Z"),
      state
    );

    expect(deletes).toEqual([oldEpochKey]);
    expect(deletes).not.toContain(futureEpochKey);
  });

  it("drains retention backlogs larger than the R2 1000-key delete limit", async () => {
    const userId = "user-1";
    const epoch = "epoch-1";
    const uploaded = "2026-07-11T12:00:00.000Z";
    const objects = new Map(
      Array.from({ length: 1_007 }, (_value, index) => {
        const object = listedObject(autosyncObjectKey(userId, epoch, index + 1), uploaded);
        return [object.key, object];
      })
    );
    const deleteBatches: string[][] = [];
    const bucket: Pick<R2Bucket, "list" | "delete"> = {
      list: async (options) => {
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(options?.prefix ?? "") && (!options?.cursor || key > options.cursor))
          .sort();
        const pageKeys = keys.slice(0, options?.limit ?? 1_000);
        const pageObjects = pageKeys.map((key) => objects.get(key)!) as R2Object[];
        return keys.length > pageKeys.length
          ? { objects: pageObjects, delimitedPrefixes: [], truncated: true, cursor: pageKeys.at(-1)! }
          : { objects: pageObjects, delimitedPrefixes: [], truncated: false };
      },
      delete: async (keys) => {
        const batch = Array.isArray(keys) ? keys : [keys];
        deleteBatches.push(batch);
        for (const key of batch) objects.delete(key);
      }
    };

    await pruneAutosyncHistory(
      bucket,
      userId,
      epoch,
      1_007,
      new Date("2026-07-11T12:00:01.000Z")
    );

    expect(deleteBatches.every((batch) => batch.length <= 1_000)).toBe(true);
    expect(objects.size).toBe(5);
    expect([...objects.keys()]).toEqual(
      [1_003, 1_004, 1_005, 1_006, 1_007].map((cursor) => autosyncObjectKey(userId, epoch, cursor))
    );
  });

  it("recognizes legacy autosync metadata without matching explicit backups", () => {
    const cutoff = new Date("2026-07-11T12:00:00.000Z");
    const uploaded = new Date("2026-07-11T11:00:00.000Z");

    expect(isLegacyAutosyncObject({
      uploaded,
      customMetadata: { userId: "user-1", sourceSyncEpoch: "epoch-1", sourceSyncCursor: "7" }
    }, "user-1", cutoff)).toBe(true);
    expect(isLegacyAutosyncObject({
      uploaded,
      customMetadata: {
        userId: "user-1",
        filename: "project-manager-latest.xlsx",
        updatedAt: "2026-07-11T11:00:00.000Z",
        rowCount: "12"
      }
    }, "user-1", cutoff)).toBe(true);
    expect(isLegacyAutosyncObject({
      uploaded,
      customMetadata: { userId: "user-1", filename: "manual-backup.xlsx", rowCount: "12" }
    }, "user-1", cutoff)).toBe(false);
    expect(isLegacyAutosyncObject({
      uploaded: new Date("2026-07-11T13:00:00.000Z"),
      customMetadata: { userId: "user-1", sourceSyncEpoch: "epoch-2", sourceSyncCursor: "8" }
    }, "user-1", cutoff)).toBe(false);
  });
});
