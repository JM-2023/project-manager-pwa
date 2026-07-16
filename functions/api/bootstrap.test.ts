import { describe, expect, it } from "vitest";
import type { AppContext } from "./_utils/types";
import { onRequestGet } from "./bootstrap";

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => FakeStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  all: <T>() => Promise<{ success: boolean; results: T[]; meta: Record<string, never> }>;
}

describe("bootstrap snapshot cursor", () => {
  it("captures epoch and cursor before the streamed collection reads", async () => {
    const events: string[] = [];
    const user = { id: "user-1", email: "owner@example.com", display_name: "owner" };
    let liveSequence = 12;
    const prepare = (sql: string): FakeStatement => {
      const statement: FakeStatement = {
        sql,
        args: [],
        bind: (...args: unknown[]) => {
          statement.args = args;
          return statement;
        },
        first: async <T>() => {
          if (sql.startsWith("SELECT id, email, display_name FROM users")) {
            events.push("authenticate");
            return user as T;
          }
          if (sql.startsWith("SELECT epoch, seq FROM sync_state")) {
            events.push(`state:${liveSequence}`);
            return { epoch: "epoch-1", seq: liveSequence } as T;
          }
          return null;
        },
        run: async () => {
          events.push("ensure-state");
          return { success: true, meta: { changes: 0 } };
        },
        all: async <T>() => {
          const table = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? "unknown";
          events.push(`page:${table}`);
          // Simulate a write after the state read but before the first page is
          // serialized. The response must retain the earlier cursor so this
          // write remains eligible for the next incremental request.
          liveSequence = 13;
          const results = table === "projects"
            ? [{ id: "project-a", name: "A", sync_seq: liveSequence }]
            : [];
          return { success: true, results: results as T[], meta: {} };
        }
      };
      return statement;
    };
    const context = {
      request: new Request("https://app.example.com/api/bootstrap?epoch=epoch-1&cursor=7"),
      waitUntil: () => undefined,
      env: {
        AUTH_MODE: "none",
        OWNER_EMAIL: user.email,
        DB: { prepare }
      }
    } as unknown as AppContext;

    const response = await onRequestGet(context);
    expect(events).toEqual(["authenticate", "ensure-state", "state:12"]);
    const body = await response.json() as { syncCursor: number; projects: Array<{ sync_seq: number }> };
    expect(body.syncCursor).toBe(12);
    expect(body.projects[0].sync_seq).toBe(13);
    expect(events.filter((event) => event.startsWith("state:"))).toEqual(["state:12"]);
    expect(events.findIndex((event) => event.startsWith("state:")))
      .toBeLessThan(events.findIndex((event) => event.startsWith("page:")));
  });
});
