import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "./api";
import { ChangeWatcher, type ChangeWatcherDeps } from "./changeWatcher";
import type { ChangesResponse } from "./types";

interface Harness {
  watcher: ChangeWatcher;
  deps: ChangeWatcherDeps;
  cursor: { epoch: string | null; cursor: number | null };
  eligible: { value: boolean };
  waits: Array<{ epoch: string; cursor: number; signal: AbortSignal; resolve: (r: ChangesResponse) => void; reject: (e: unknown) => void }>;
  onChanged: ReturnType<typeof vi.fn>;
  onAuthRequired: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const cursor = { epoch: "e1" as string | null, cursor: 5 as number | null };
  const eligible = { value: true };
  const waits: Harness["waits"] = [];
  const onChanged = vi.fn(async () => {
    cursor.cursor = (cursor.cursor ?? 0) + 1;
  });
  const onAuthRequired = vi.fn();
  const deps: ChangeWatcherDeps = {
    waitForChanges: (epoch, cursorValue, signal) =>
      new Promise((resolve, reject) => {
        waits.push({ epoch, cursor: cursorValue, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    cursor: () => ({ ...cursor }),
    shouldRun: () => eligible.value,
    onChanged,
    onAuthRequired
  };
  return { watcher: new ChangeWatcher(deps), deps, cursor, eligible, waits, onChanged, onAuthRequired };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("ChangeWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a wait with the current cursor and pulls when the server is ahead", async () => {
    const h = makeHarness();
    h.watcher.start();
    await settle();
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0]).toMatchObject({ epoch: "e1", cursor: 5 });

    h.waits[0].resolve({ changed: true, epoch: "e1", cursor: 6, serverTime: "t" });
    await settle();
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    // The next wait uses the cursor advanced by the pull.
    expect(h.waits).toHaveLength(2);
    expect(h.waits[1].cursor).toBe(6);
  });

  it("reopens immediately after an unchanged answer without pulling", async () => {
    const h = makeHarness();
    h.watcher.start();
    await settle();
    h.waits[0].resolve({ changed: false, epoch: "e1", cursor: 5, serverTime: "t" });
    await settle();
    expect(h.onChanged).not.toHaveBeenCalled();
    expect(h.waits).toHaveLength(2);
  });

  it("aborts the open wait on stop and does not reopen", async () => {
    const h = makeHarness();
    h.watcher.start();
    await settle();
    h.watcher.stop();
    expect(h.waits[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.waits).toHaveLength(1);
    expect(h.watcher.isRunning()).toBe(false);
  });

  it("refresh follows eligibility: stops when hidden, restarts when visible", async () => {
    const h = makeHarness();
    h.watcher.refresh();
    await settle();
    expect(h.waits).toHaveLength(1);
    h.eligible.value = false;
    h.watcher.refresh();
    expect(h.waits[0].signal.aborted).toBe(true);
    h.eligible.value = true;
    h.watcher.refresh();
    await settle();
    expect(h.waits).toHaveLength(2);
    expect(h.watcher.isRunning()).toBe(true);
    h.waits[1].resolve({ changed: false, epoch: "e1", cursor: 5, serverTime: "t" });
    await settle();
    expect(h.waits).toHaveLength(3);
    h.watcher.stop();
  });

  it("backs off after a failed wait and recovers", async () => {
    const h = makeHarness();
    h.watcher.start();
    await settle();
    h.waits[0].reject(new Error("network down"));
    await settle();
    expect(h.waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.waits).toHaveLength(2);
    h.waits[1].reject(new Error("still down"));
    await settle();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.waits).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.waits).toHaveLength(3);
    h.waits[2].resolve({ changed: false, epoch: "e1", cursor: 5, serverTime: "t" });
    await settle();
    expect(h.waits).toHaveLength(4);
  });

  it("stops and reports when the session is rejected", async () => {
    const h = makeHarness();
    h.watcher.start();
    await settle();
    h.waits[0].reject(new AuthRequiredError());
    await settle();
    expect(h.onAuthRequired).toHaveBeenCalledTimes(1);
    expect(h.watcher.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.waits).toHaveLength(1);
  });

  it("does not spin when a pull fails to advance the cursor", async () => {
    const h = makeHarness();
    h.onChanged.mockImplementation(async () => undefined);
    h.watcher.start();
    await settle();
    h.waits[0].resolve({ changed: true, epoch: "e1", cursor: 9, serverTime: "t" });
    await settle();
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    expect(h.waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.waits).toHaveLength(2);
  });

  it("does not let an old pull resume a stopped loop after restart", async () => {
    const h = makeHarness();
    let finish!: () => void;
    h.onChanged.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    h.watcher.start();
    h.waits[0].resolve({ changed: true, epoch: "e1", cursor: 6, serverTime: "t" });
    await settle();
    h.watcher.stop();
    h.watcher.start();
    finish();
    await settle();
    expect(h.watcher.isRunning()).toBe(true);
    expect(h.waits).toHaveLength(2);
    h.watcher.stop();
  });

  it("does not run a duplicate pull after a peer already adopted the reported version", async () => {
    const h = makeHarness();
    h.watcher.start();
    h.cursor.cursor = 6;
    h.waits[0].resolve({ changed: true, epoch: "e1", cursor: 6, serverTime: "t" });
    await settle();
    expect(h.onChanged).not.toHaveBeenCalled();
    expect(h.waits[1].cursor).toBe(6);
    h.watcher.stop();
  });

  it("waits for a cursor before opening the first request", async () => {
    const h = makeHarness();
    h.cursor.epoch = null;
    h.cursor.cursor = null;
    h.watcher.start();
    await settle();
    expect(h.waits).toHaveLength(0);
    h.cursor.epoch = "e1";
    h.cursor.cursor = 2;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0].cursor).toBe(2);
  });
});
