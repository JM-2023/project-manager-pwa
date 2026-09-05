import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEASE_WAIT_MS, withSyncLease } from "./syncChannel";

interface LockRequest {
  name: string;
  options: { mode?: string; signal?: AbortSignal; steal?: boolean };
}

function installFakeLocks(grant: (request: LockRequest) => boolean) {
  const requests: LockRequest[] = [];
  const locks = {
    request: (name: string, options: LockRequest["options"], callback: () => Promise<unknown>) => {
      const request = { name, options };
      requests.push(request);
      if (grant(request)) return callback();
      return new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    }
  };
  vi.stubGlobal("navigator", { locks });
  return requests;
}

describe("withSyncLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs the work under the lock when it is granted promptly", async () => {
    const requests = installFakeLocks(() => true);
    const work = vi.fn(async () => "done");
    await expect(withSyncLease(work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].options.steal).toBeUndefined();
  });

  it("times out a waiter without stealing or starting its work", async () => {
    const requests = installFakeLocks(() => false);
    const work = vi.fn(async () => "done");
    const outcome = expect(withSyncLease(work)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(LEASE_WAIT_MS);
    await outcome;
    expect(work).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].options.steal).toBeUndefined();
  });

  it("cancels a queued acquisition with the cycle signal", async () => {
    installFakeLocks(() => false);
    const controller = new AbortController();
    const work = vi.fn(async () => undefined);
    const result = expect(withSyncLease(work, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(work).not.toHaveBeenCalled();
  });

  it("propagates a failure from work that was granted the lock instead of stealing", async () => {
    const requests = installFakeLocks(() => true);
    const failure = new Error("network down");
    const work = vi.fn(async () => {
      throw failure;
    });
    await expect(withSyncLease(work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("propagates work failures even when they happen after the wait bound", async () => {
    const requests = installFakeLocks(() => true);
    const failure = new Error("slow failure");
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_MS + 1000));
      throw failure;
    });
    const outcome = expect(withSyncLease(work)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(LEASE_WAIT_MS + 1000);
    await outcome;
    expect(requests).toHaveLength(1);
  });
});
