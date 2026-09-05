import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeWatcher } from "./changeWatcher";
import { withChangeLeadership } from "./syncChannel";
import type { ChangesResponse } from "./types";

// Model queued ownership and cancellation (abort only cancels queued requests;
// a granted callback keeps ownership until its promise settles).
function locks() {
  let held = false;
  const queue: Array<() => void> = [];
  return {
    request: (_name: string, options: { signal: AbortSignal }, work: () => Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        let granted = false;
        const cancel = () => { if (!granted) reject(options.signal.reason); };
        options.signal.addEventListener("abort", cancel, { once: true });
        const grant = () => {
          if (options.signal.aborted) { queue.shift()?.(); return; }
          held = true; granted = true;
          void work().then(resolve, reject).finally(() => {
            options.signal.removeEventListener("abort", cancel);
            held = false; queue.shift()?.();
          });
        };
        if (held) queue.push(grant); else grant();
      })
  };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
afterEach(() => vi.unstubAllGlobals());
describe("one watcher per browser", () => {
  it("only opens one request and hands leadership to a peer when the owner hides", async () => {
    vi.stubGlobal("navigator", { locks: locks() });
    let active = 0;
    let max = 0;
    const opened: string[] = [];
    const create = (name: string) => new ChangeWatcher({
      shouldRun: () => true, cursor: () => ({ epoch: "e", cursor: 1 }), onChanged: async () => {},
      withLeadership: withChangeLeadership,
      waitForChanges: (_e, _c, signal) => new Promise<ChangesResponse>((_resolve, reject) => {
        opened.push(name); active++; max = Math.max(max, active);
        signal.addEventListener("abort", () => { active--; reject(signal.reason); }, { once: true });
      })
    });
    const a = create("a"); const b = create("b");
    a.start(); b.start(); await settle();
    expect(opened).toEqual(["a"]);
    a.stop(); await settle();
    expect(opened).toEqual(["a", "b"]);
    expect(max).toBe(1);
    expect(b.isRunning()).toBe(true);
    b.stop(); await settle();
    expect(active).toBe(0);
  });
});
