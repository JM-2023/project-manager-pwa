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

  it("steals a lock that another (suspended) holder never releases", async () => {
    const requests = installFakeLocks((request) => request.options.steal === true);
    const work = vi.fn(async () => "done");
    const pending = withSyncLease(work);
    await vi.advanceTimersByTimeAsync(LEASE_WAIT_MS - 1);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.options.steal)).toEqual([undefined, true]);
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
