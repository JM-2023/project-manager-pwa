import { abortable, pause } from "./cancellation";
import { AuthRequiredError } from "./api";
import { describeError, trace } from "./syncTrace";
import type { ChangesResponse } from "./types";

/** Seconds the server may hold one wait request before answering "unchanged". */
export const CHANGES_WAIT_SECONDS = 25;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 2_000;
/** Pause before the first wait while the tab has no cursor yet (no bootstrap so far). */
const NO_CURSOR_PAUSE_MS = 2_000;

export interface ChangeWatcherDeps {
  waitForChanges: (epoch: string, cursor: number, signal: AbortSignal) => Promise<ChangesResponse>;
  cursor: () => { epoch: string | null; cursor: number | null };
  /** Whether a wait should be open right now (visible, online, signed in). */
  shouldRun: () => boolean;
  /** Pull the delta; runs the engine's normal sync cycle. */
  onChanged: () => Promise<void>;
  /** The server rejected the session; the app's recovery path takes over. */
  onAuthRequired?: () => void;
  withLeadership?: (signal: AbortSignal, work: () => Promise<void>) => Promise<void>;
  onHealthy?: () => void;
}

/** Each start owns its controller; an old loop can never stop a newer run. */
export class ChangeWatcher {
  private run: AbortController | null = null;
  constructor(private readonly deps: ChangeWatcherDeps) {}
  isRunning(): boolean { return this.run !== null; }
  start(): void {
    if (this.run || !this.deps.shouldRun()) return;
    const run = new AbortController();
    this.run = run;
    const work = () => this.loop(run.signal);
    const pending = this.deps.withLeadership ? this.deps.withLeadership(run.signal, work) : work();
    void pending.catch((error) => {
      if (!run.signal.aborted) trace("changes watch failed", describeError(error));
    }).finally(() => { if (this.run === run) this.run = null; });
  }
  stop(): void {
    const old = this.run;
    this.run = null;
    old?.abort(new DOMException("Change watcher stopped", "AbortError"));
  }
  refresh(): void { if (this.deps.shouldRun()) this.start(); else this.stop(); }
  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let stalled = 0;
    trace("changes watch start");
    while (!signal.aborted && this.deps.shouldRun()) {
      const before = this.deps.cursor();
      if (before.epoch === null || before.cursor === null) {
        await pause(NO_CURSOR_PAUSE_MS, signal);
        continue;
      }
      try {
        const result = await abortable(this.deps.waitForChanges(before.epoch, before.cursor, signal), signal);
        signal.throwIfAborted();
        this.deps.onHealthy?.();
        failures = 0;
        if (!result.changed) continue;
        // A peer or a concurrent local sync may already have adopted this cursor.
        const current = this.deps.cursor();
        if (current.epoch === result.epoch && current.cursor === result.cursor) continue;
        trace("changes: server ahead", `cursor ${before.cursor} → ${result.cursor}`);
        await abortable(this.deps.onChanged(), signal);
        signal.throwIfAborted();
        const after = this.deps.cursor();
        if (after.epoch !== before.epoch || after.cursor !== before.cursor) { stalled = 0; continue; }
        await pause(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(stalled++, 4)), signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof AuthRequiredError) { this.deps.onAuthRequired?.(); break; }
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(failures++, 4));
        trace("changes wait failed", `${describeError(error)}; retry in ${delay}ms`);
        await pause(delay, signal);
      }
    }
  }
}
