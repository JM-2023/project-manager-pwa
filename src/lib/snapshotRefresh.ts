export interface SnapshotVersion { epoch?: string; cursor?: number }

/** Coalesce peer notifications; hidden tabs read once when they become visible. */
export class SnapshotRefresh {
  private pending: SnapshotVersion | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private disposed = false;
  constructor(private readonly deps: {
    eligible: () => boolean;
    current: () => SnapshotVersion;
    adopt: () => Promise<void>;
    onError: (error: unknown) => void;
  }) {}
  hint(version: SnapshotVersion = {}): void {
    if (this.disposed) return;
    this.pending = version;
    this.refresh();
  }
  refresh(): void {
    if (this.disposed || this.reading || this.timer || !this.pending || !this.deps.eligible()) return;
    const current = this.deps.current();
    if (this.pending.epoch !== undefined && this.pending.epoch === current.epoch &&
        this.pending.cursor !== undefined && current.cursor !== undefined && current.cursor >= this.pending.cursor) {
      this.pending = null;
      return;
    }
    this.timer = setTimeout(() => { this.timer = null; void this.read(); }, 100);
  }
  private async read(): Promise<void> {
    if (this.disposed || !this.deps.eligible()) return;
    this.pending = null;
    this.reading = true;
    try { await this.deps.adopt(); }
    catch (error) { this.deps.onError(error); }
    finally { this.reading = false; this.refresh(); }
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending = null;
  }
}
