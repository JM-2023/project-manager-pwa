import { describe, expect, it } from "vitest";
import type { AppEnv } from "./types";
import { getOrCreateUser, INTERNAL_SETTING_KEYS, readSettings, readSyncState } from "./db";

interface CapturedStatement {
  sql: string;
  args: unknown[];
}

describe("database sync helpers", () => {
  it("keeps the server-owned Excel dirty marker visible to client sync", () => {
    expect(INTERNAL_SETTING_KEYS.has("excel_dirty_at")).toBe(false);
  });

  it("filters internal settings in SQL and uses the sequence cursor", async () => {
    const captured: CapturedStatement[] = [];
    const DB = {
      prepare(sql: string) {
        const item: CapturedStatement = { sql, args: [] };
        captured.push(item);
        return {
          bind(...args: unknown[]) {
            item.args = args;
            return {
              all: async () => ({ results: [{ key: "theme", value_json: '"dark"' }] })
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(readSettings({ DB } as AppEnv, "user-1", 7)).resolves.toEqual({ theme: "dark" });
    expect(captured[0].sql).toContain("sync_seq > ?");
    expect(captured[0].sql).toContain("key NOT IN");
    expect(captured[0].args).toEqual(["user-1", 7, ...INTERNAL_SETTING_KEYS]);
  });

  it("resolves the canonical user after a concurrent INSERT wins", async () => {
    const captured: CapturedStatement[] = [];
    let userSelects = 0;
    const canonical = { id: "canonical-user", email: "owner@example.com", display_name: "owner" };
    const DB = {
      prepare(sql: string) {
        const item: CapturedStatement = { sql, args: [] };
        captured.push(item);
        return {
          bind(...args: unknown[]) {
            item.args = args;
            return {
              first: async () => {
                if (!sql.startsWith("SELECT id, email")) return null;
                userSelects += 1;
                return userSelects === 1 ? null : canonical;
              },
              run: async () => ({ success: true, meta: { changes: 1 } })
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(getOrCreateUser({ DB } as AppEnv, canonical.email)).resolves.toEqual(canonical);
    expect(captured.some((item) => item.sql.startsWith("INSERT OR IGNORE INTO users"))).toBe(true);
    const syncInsert = captured.find((item) => item.sql.startsWith("INSERT OR IGNORE INTO sync_state"));
    expect(syncInsert?.args).toEqual([canonical.id]);
  });

  it("reads an existing sync state without issuing a write", async () => {
    const captured: string[] = [];
    let state: { epoch: string; seq: number } | null = null;
    const DB = {
      prepare(sql: string) {
        captured.push(sql);
        return {
          bind() {
            return {
              first: async () => state,
              run: async () => {
                state = { epoch: "fresh", seq: 0 };
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    state = { epoch: "e1", seq: 4 };
    await expect(readSyncState({ DB } as AppEnv, "user-1")).resolves.toEqual({ epoch: "e1", seq: 4 });
    expect(captured.some((sql) => sql.startsWith("INSERT"))).toBe(false);

    captured.length = 0;
    state = null;
    await expect(readSyncState({ DB } as AppEnv, "user-1")).resolves.toEqual({ epoch: "fresh", seq: 0 });
    expect(captured.filter((sql) => sql.startsWith("INSERT OR IGNORE INTO sync_state"))).toHaveLength(1);
  });
});
