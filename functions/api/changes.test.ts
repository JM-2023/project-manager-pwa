import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./_utils/types";
import { CHECK_INTERVAL_MS, onRequestGet } from "./changes";

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => FakeStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  all: <T>() => Promise<{ success: boolean; results: T[]; meta: Record<string, never> }>;
}

function makeContext(url: string, state: { epoch: string; seq: number }, signal?: AbortSignal) {
  const user = { id: "user-1", email: "owner@example.com", display_name: "owner" };
  const reads: number[] = [];
  const prepare = (sql: string): FakeStatement => {
    const statement: FakeStatement = {
      sql,
      args: [],
      bind: (...args: unknown[]) => {
        statement.args = args;
        return statement;
      },
      first: async <T>() => {
        if (sql.startsWith("SELECT id, email, display_name FROM users")) return user as T;
        if (sql.startsWith("SELECT epoch, seq FROM sync_state")) {
          reads.push(state.seq);
          return { ...state } as T;
        }
        return null;
      },
      run: async () => ({ success: true, meta: { changes: 0 } }),
      all: async <T>() => ({ success: true, results: [] as T[], meta: {} })
    };
    return statement;
  };
  const request = new Request(url, signal ? { signal } : undefined);
  const context = {
    request,
    waitUntil: () => undefined,
    env: { AUTH_MODE: "none", OWNER_EMAIL: user.email, DB: { prepare } }
  } as unknown as AppContext;
  return { context, reads };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("changes long-poll", () => {
  it("answers at once when the client cursor is behind the server", async () => {
    const { context, reads } = makeContext("https://app.example.com/api/changes?epoch=e1&cursor=3&wait=25", { epoch: "e1", seq: 5 });
    const response = await onRequestGet(context);
    expect(await response.json()).toMatchObject({ changed: true, epoch: "e1", cursor: 5 });
    expect(reads).toEqual([5]);
  });

  it("answers at once on an epoch mismatch or a missing cursor", async () => {
    const mismatch = makeContext("https://app.example.com/api/changes?epoch=old&cursor=5&wait=25", { epoch: "e1", seq: 5 });
    expect(await (await onRequestGet(mismatch.context)).json()).toMatchObject({ changed: true });
    const missing = makeContext("https://app.example.com/api/changes?wait=25", { epoch: "e1", seq: 5 });
    expect(await (await onRequestGet(missing.context)).json()).toMatchObject({ changed: true, cursor: 5 });
  });

  it("holds the request and answers when the cursor advances", async () => {
    vi.useFakeTimers();
    const state = { epoch: "e1", seq: 5 };
    const { context, reads } = makeContext("https://app.example.com/api/changes?epoch=e1&cursor=5&wait=25", state);
    const pending = onRequestGet(context);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(reads).toEqual([5, 5]);
    state.seq = 6;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    const response = await pending;
    expect(await response.json()).toMatchObject({ changed: true, cursor: 6 });
    expect(reads).toEqual([5, 5, 6]);
  });

  it("answers unchanged once the wait budget is spent", async () => {
    vi.useFakeTimers();
    const { context, reads } = makeContext("https://app.example.com/api/changes?epoch=e1&cursor=5&wait=3", { epoch: "e1", seq: 5 });
    const pending = onRequestGet(context);
    await vi.advanceTimersByTimeAsync(3_000);
    const response = await pending;
    expect(await response.json()).toMatchObject({ changed: false, cursor: 5 });
    // t=0, t=2s, then the 1s remainder.
    expect(reads).toEqual([5, 5, 5]);
  });

  it("stops holding the request when the client goes away", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { context, reads } = makeContext("https://app.example.com/api/changes?epoch=e1&cursor=5&wait=25", { epoch: "e1", seq: 5 }, controller.signal);
    const pending = onRequestGet(context);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const response = await pending;
    expect(await response.json()).toMatchObject({ changed: false });
    expect(reads).toEqual([5, 5]);
  });

  it("caps the wait at the server maximum", async () => {
    vi.useFakeTimers();
    const { context } = makeContext("https://app.example.com/api/changes?epoch=e1&cursor=5&wait=600", { epoch: "e1", seq: 5 });
    const pending = onRequestGet(context);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await (await pending).json()).toMatchObject({ changed: false });
  });
});
