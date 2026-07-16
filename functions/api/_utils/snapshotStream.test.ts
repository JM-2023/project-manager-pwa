import { describe, expect, it } from "vitest";
import { INTERNAL_SETTING_KEYS } from "./db";
import { streamSnapshotResponse } from "./snapshotStream";

interface CapturedQuery {
  sql: string;
  args: unknown[];
}

type FakeRow = Record<string, unknown>;

function fakeDatabase(source: Record<string, FakeRow[]>): { db: D1Database; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              queries.push({ sql, args });
              const table = /FROM\s+(\w+)/i.exec(sql)?.[1];
              if (!table) throw new Error(`Missing table in query: ${sql}`);
              const key = table === "app_settings" ? "key" : "id";
              const after = sql.includes(`AND ${key} > ?`) ? String(args[args.length - 2]) : null;
              const limit = Number(args[args.length - 1]);
              const rows = [...(source[table] ?? [])]
                .filter((row) => after === null || String(row[key]) > after)
                .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
                .slice(0, limit);
              return { success: true, results: rows, meta: {} };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
  return { db, queries };
}

describe("streamed snapshot JSON", () => {
  it("waits for response demand before reading the first D1 page", async () => {
    const { db, queries } = fakeDatabase({
      projects: [{ id: "project-a" }],
      tasks: [],
      next_projects: [],
      next_ideas: [],
      app_settings: []
    });
    const response = streamSnapshotResponse({
      db,
      userId: "user-1",
      serverTime: "2026-07-16T00:00:00.000Z",
      syncEpoch: "epoch-1",
      syncCursor: 1,
      full: true,
      cursor: 0,
      pageSize: 2
    });

    const reader = response.body!.getReader();
    await reader.read();
    await Promise.resolve();
    expect(queries).toHaveLength(0);
    await reader.cancel();
  });

  it("preserves the bootstrap contract across immutable-key pages", async () => {
    const projects = [
      { id: "project-a", name: "A", sync_seq: 8 },
      { id: "project-b", name: "B", sync_seq: 9 },
      { id: "project-c", name: "C", sync_seq: 10 }
    ];
    const { db, queries } = fakeDatabase({
      projects,
      tasks: [{ id: "task-a", title: "Task", sync_seq: 8 }],
      next_projects: [{ id: "next-project-a", name: "Next", sync_seq: 9 }],
      next_ideas: [],
      app_settings: [
        { key: "invalid", value_json: "not-json", sync_seq: 10 },
        { key: "language", value_json: '"zh-CN"', sync_seq: 8 },
        { key: "theme", value_json: '"dark"', sync_seq: 9 }
      ]
    });

    const response = streamSnapshotResponse({
      db,
      userId: "user-1",
      serverTime: "2026-07-16T01:02:03.000Z",
      syncEpoch: "epoch-1",
      syncCursor: 10,
      full: false,
      cursor: 7,
      pageSize: 2
    });

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "serverTime",
      "syncEpoch",
      "syncCursor",
      "full",
      "projects",
      "tasks",
      "nextProjects",
      "nextIdeas",
      "settings"
    ]);
    expect(body).toEqual({
      serverTime: "2026-07-16T01:02:03.000Z",
      syncEpoch: "epoch-1",
      syncCursor: 10,
      full: false,
      projects,
      tasks: [{ id: "task-a", title: "Task", sync_seq: 8 }],
      nextProjects: [{ id: "next-project-a", name: "Next", sync_seq: 9 }],
      nextIdeas: [],
      settings: { invalid: null, language: "zh-CN", theme: "dark" }
    });

    const projectQueries = queries.filter((query) => query.sql.includes("FROM projects"));
    expect(projectQueries).toHaveLength(2);
    expect(projectQueries[0].sql).not.toContain("OFFSET");
    expect(projectQueries[0].sql).toContain("sync_seq > ?");
    expect(projectQueries[0].args).toEqual(["user-1", 7, 3]);
    expect(projectQueries[1].sql).toContain("id > ?");
    expect(projectQueries[1].args).toEqual(["user-1", 7, "project-b", 3]);

    const settingQueries = queries.filter((query) => query.sql.includes("FROM app_settings"));
    expect(settingQueries).toHaveLength(2);
    expect(settingQueries[1].sql).toContain("key > ?");
    expect(settingQueries[1].args).toEqual(["user-1", 7, ...INTERNAL_SETTING_KEYS, "language", 3]);
  });

  it("preserves the export-data contract without incremental tombstones", async () => {
    const { db, queries } = fakeDatabase({
      projects: [{ id: "project-a", name: "A" }],
      tasks: [],
      next_projects: [{ id: "next-project-a", name: "Next", archived: 1 }],
      next_ideas: [{ id: "next-idea-a", title: "Idea" }],
      app_settings: [{ key: "theme", value_json: '"light"' }]
    });
    const timestamp = "2026-07-16T02:03:04.000Z";
    const response = streamSnapshotResponse({
      db,
      userId: "user-1",
      exportedAt: timestamp,
      serverTime: timestamp,
      syncEpoch: "epoch-export",
      syncCursor: 42,
      full: true,
      cursor: 0,
      pageSize: 2
    });

    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "exportedAt",
      "serverTime",
      "syncEpoch",
      "syncCursor",
      "full",
      "projects",
      "tasks",
      "nextProjects",
      "nextIdeas",
      "settings"
    ]);
    expect(body).toEqual({
      exportedAt: timestamp,
      serverTime: timestamp,
      syncEpoch: "epoch-export",
      syncCursor: 42,
      full: true,
      projects: [{ id: "project-a", name: "A" }],
      tasks: [],
      nextProjects: [{ id: "next-project-a", name: "Next", archived: 1 }],
      nextIdeas: [{ id: "next-idea-a", title: "Idea" }],
      settings: { theme: "light" }
    });
    for (const query of queries) {
      expect(query.sql).toContain(query.sql.includes("app_settings") ? "ORDER BY key" : "ORDER BY id");
      expect(query.sql).toContain(query.sql.includes("app_settings") ? "key NOT IN" : "deleted_at IS NULL");
      expect(query.sql).not.toContain("sync_seq > ?");
    }
  });
});
