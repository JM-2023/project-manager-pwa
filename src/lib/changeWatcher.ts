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
}

/**
 * Keeps one long-poll open against /api/changes while the tab is eligible.
 * The server answers as soon as its cursor moves past ours (another device
 * wrote), or after ~25s with "unchanged"; either way the next wait starts
 * immediately. Cross-device latency drops from the 30s poll to about the
 * server's check interval, and idle waits cost one tiny query every 2s.
 */
export class ChangeWatcher {
  private readonly deps: ChangeWatcherDeps;
  private running = false;
  private controller: AbortController | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private resumePause: (() => void) | null = null;
  private backoffAttempt = 0;
  private hotLoopAttempt = 0;

  constructor(deps: ChangeWatcherDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running || !this.deps.shouldRun()) return;
    this.running = true;
    trace("changes watch start");
    void this.loop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    trace("changes watch stop");
    this.controller?.abort(new DOMException("Change watcher stopped", "AbortError"));
    this.controller = null;
    this.wake();
  }

  /** Re-evaluate eligibility after visibility, connectivity or session changed. */
  refresh(): void {
    if (this.deps.shouldRun()) this.start();
    else this.stop();
  }

  private wake(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.resumePause?.();
    this.resumePause = null;
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.resumePause = resolve;
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        this.resumePause = null;
        resolve();
      }, ms);
    });
  }

  private async loop(): Promise<void> {
    while (this.running && this.deps.shouldRun()) {
      const before = this.deps.cursor();
      if (before.epoch === null || before.cursor === null) {
        await this.pause(NO_CURSOR_PAUSE_MS);
        continue;
      }
      const controller = new AbortController();
      this.controller = controller;
      let result: ChangesResponse;
      try {
        result = await this.deps.waitForChanges(before.epoch, before.cursor, controller.signal);
      } catch (error) {
        if (this.controller === controller) this.controller = null;
        if (controller.signal.aborted || !this.running) break;
        if (error instanceof AuthRequiredError) {
          trace("changes watch auth required");
          this.running = false;
          this.deps.onAuthRequired?.();
          break;
        }
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.backoffAttempt++);
        trace("changes wait failed", `${describeError(error)}; retry in ${delay}ms`);
        await this.pause(delay);
        continue;
      }
      if (this.controller === controller) this.controller = null;
      this.backoffAttempt = 0;
      if (!this.running) break;
      if (!result.changed) continue;

      trace("changes: server ahead", `cursor ${before.cursor} → ${result.cursor}`);
      await this.deps.onChanged().catch(() => undefined);
      const after = this.deps.cursor();
      const advanced = after.epoch !== before.epoch || after.cursor !== before.cursor;
      if (advanced) {
        this.hotLoopAttempt = 0;
        continue;
      }
      // The pull did not move our cursor (offline, sync error, engine
      // suspended); the server would answer "changed" again at once. Back off
      // instead of spinning.
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.hotLoopAttempt++);
      trace("changes: cursor unchanged after pull", `retry in ${delay}ms`);
      await this.pause(delay);
    }
    this.running = false;
  }
}
