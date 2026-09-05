import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotRefresh } from "./snapshotRefresh";
afterEach(() => vi.useRealTimers());
function harness() {
  vi.useFakeTimers();
  const state = { visible: true, epoch: "e", cursor: 1 };
  const adopt = vi.fn(async () => { state.cursor = 5; });
  const queue = new SnapshotRefresh({ eligible: () => state.visible, current: () => state, adopt, onError: vi.fn() });
  return { state, adopt, queue };
}
describe("peer snapshot refresh", () => {
  it("combines a burst and skips versions already adopted", async () => {
    const h = harness();
    for (let cursor = 2; cursor <= 5; cursor++) h.queue.hint({ epoch: "e", cursor });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.adopt).toHaveBeenCalledTimes(1);
    h.queue.hint({ epoch: "e", cursor: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.adopt).toHaveBeenCalledTimes(1);
  });
  it("defers hidden work until visible", async () => {
    const h = harness(); h.state.visible = false;
    h.queue.hint({ epoch: "e", cursor: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.adopt).not.toHaveBeenCalled();
    h.state.visible = true; h.queue.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.adopt).toHaveBeenCalledTimes(1);
  });
  it("coalesces hints during a read without concurrent full reads", async () => {
    const h = harness();
    let done!: () => void;
    h.adopt.mockImplementationOnce(() => new Promise<void>((resolve) => { done = resolve; }));
    h.queue.hint({ epoch: "e", cursor: 2 });
    await vi.advanceTimersByTimeAsync(100);
    h.queue.hint({ epoch: "e", cursor: 3 }); h.queue.hint({ epoch: "e", cursor: 5 });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.adopt).toHaveBeenCalledTimes(1);
    done(); await vi.advanceTimersByTimeAsync(100);
    expect(h.adopt).toHaveBeenCalledTimes(2);
  });
});
