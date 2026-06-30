// SyncEngine owns the imperative sync state machine that used to live inline in
// App.tsx: the debounce/in-flight/queue-again bookkeeping, the optimistic queue
// of pending mutations, the bootstrap reconciliation, and the cloud-Excel
// autosync. Every side-effecting dependency (network, IndexedDB, the Excel
// workbook builder, the online check, the clock) is injected through SyncIO, so
// the whole machine can be driven with fakes in a unit test instead of a real
// browser. App.tsx is now just the React binding around this class.
import { AuthRequiredError } from "./api";
import type {
  BootstrapResponse,
  ClientMutation,
  CloudExcelUploadResponse,
  ExportDataResponse,
  MutationResult,
  MutationsResponse,
  SessionResponse
} from "./types";
import type { AppAction, AppState } from "../state/appStore";
import type { EntityStoreName, SavableEntity } from "./localDb";
import {
  compactPendingMutations,
  excelDirtyAt,
  keepaliveBody,
  mergeBootstrapForLocal,
  mergePendingMutations,
  mutationRecordKey,
  pendingRecordKeys,
  stateWithBootstrap,
  upsertRecord,
  type PendingMutationGroup
} from "./syncMerge";
import { visibleTasks } from "./sync";

const SYNC_DEBOUNCE_MS = 850;
const CLOUD_EXCEL_FILENAME = "project-manager-latest.xlsx";

export interface SyncIO {
  getSession: () => Promise<SessionResponse>;
  bootstrap: (since: string | null) => Promise<BootstrapResponse>;
  sendMutations: (clientId: string, mutations: ClientMutation[]) => Promise<MutationsResponse>;
  getExportData: () => Promise<ExportDataResponse>;
  uploadCloudExcel: (blob: Blob, filename: string, rowCount: number) => Promise<CloudExcelUploadResponse>;
  workbookBlob: (data: ExportDataResponse) => Blob | Promise<Blob>;
  queueMutation: (mutation: ClientMutation) => Promise<void>;
  getPendingMutations: () => Promise<ClientMutation[]>;
  removePendingMutations: (ids: string[]) => Promise<void>;
  saveBootstrapSnapshot: (snapshot: BootstrapResponse) => Promise<void>;
  saveEntity: (store: EntityStoreName, record: SavableEntity) => Promise<void>;
  resetLocalData: () => Promise<void>;
  isOnline: () => boolean;
  now: () => string;
  sendBeacon?: (url: string, body: Blob) => boolean;
}

export interface SyncEngineDeps {
  stateRef: { current: AppState };
  dispatch: (action: AppAction) => void;
  clientId: string;
  io: SyncIO;
}

export class SyncEngine {
  private readonly stateRef: { current: AppState };
  private readonly dispatch: (action: AppAction) => void;
  private readonly clientId: string;
  private readonly io: SyncIO;

  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInFlight = false;
  private syncCompletion: Promise<void> | null = null;
  private syncAgainAfterCurrent = false;
  private forceFullResyncInFlight = false;
  private excelUploadTimer: ReturnType<typeof setTimeout> | null = null;
  private excelUploadInFlight = false;
  // The first sync after the app loads reconciles local IndexedDB against the
  // server's full live set instead of using the incremental cursor (see syncNow).
  private fullBootstrapPending = true;
  private pendingMutationsRef: ClientMutation[] = [];
  private readonly pendingWritePromises = new Set<Promise<void>>();

  constructor(deps: SyncEngineDeps) {
    this.stateRef = deps.stateRef;
    this.dispatch = deps.dispatch;
    this.clientId = deps.clientId;
    this.io = deps.io;
  }

  // --- lifecycle wiring used by App.tsx --------------------------------------

  hydratePending(mutations: ClientMutation[]): void {
    this.pendingMutationsRef = mutations;
  }

  markFullBootstrapPending(): void {
    this.fullBootstrapPending = true;
  }

  pendingMutations(): ClientMutation[] {
    return this.pendingMutationsRef;
  }

  // --- queue management (called by the CRUD handlers) ------------------------

  persistMutation(mutation: ClientMutation): void {
    const queuedMutation = { ...mutation, createdAt: this.io.now() };
    this.rememberPendingMutation(queuedMutation);
    this.trackPendingWrite(
      this.io
        .queueMutation(queuedMutation)
        .then(() => this.updatePendingCount())
        .then(() => undefined)
        .catch((error) => {
          this.dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Local save failed" });
        })
    );
    this.scheduleSync();
  }

  // Drop queued mutations both from memory and IndexedDB. Used when a hard
  // delete must prevent a late upsert from resurrecting a purged record.
  dropPendingMutations(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    this.forgetPendingMutations(ids);
    void this.io.removePendingMutations(ids);
  }

  private rememberPendingMutation(mutation: ClientMutation): void {
    this.pendingMutationsRef = mergePendingMutations(this.pendingMutationsRef, [mutation]);
    this.dispatch({ type: "setPendingCount", payload: compactPendingMutations(this.pendingMutationsRef).length });
  }

  private forgetPendingMutations(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const removed = new Set(ids);
    this.pendingMutationsRef = this.pendingMutationsRef.filter((mutation) => !removed.has(mutation.id));
    this.dispatch({ type: "setPendingCount", payload: compactPendingMutations(this.pendingMutationsRef).length });
  }

  private trackPendingWrite(promise: Promise<void>): void {
    this.pendingWritePromises.add(promise);
    void promise.finally(() => {
      this.pendingWritePromises.delete(promise);
    });
  }

  private async settlePendingWrites(): Promise<void> {
    const writes = [...this.pendingWritePromises];
    if (writes.length > 0) {
      await Promise.allSettled(writes);
    }
  }

  private async updatePendingCount(): Promise<ClientMutation[]> {
    const persisted = await this.io.getPendingMutations();
    this.pendingMutationsRef = mergePendingMutations(persisted, this.pendingMutationsRef);
    const compactedCount = compactPendingMutations(this.pendingMutationsRef).length;
    this.dispatch({ type: "setPendingCount", payload: compactedCount });
    return this.pendingMutationsRef;
  }

  // --- bootstrap reconciliation ----------------------------------------------

  private async applyBootstrapSnapshot(snapshot: BootstrapResponse, replaceMode: boolean): Promise<void> {
    const merged = mergeBootstrapForLocal(this.stateRef.current, snapshot, this.pendingMutationsRef, replaceMode);
    this.stateRef.current = stateWithBootstrap(this.stateRef.current, merged);
    this.dispatch({ type: "replaceBootstrap", payload: merged });
    await this.io.saveBootstrapSnapshot(merged);
  }

  private async applyMutationMetadata(applied: MutationResult[], sentGroups: PendingMutationGroup[]): Promise<void> {
    if (applied.length === 0) {
      return;
    }

    const groupByMutationId = new Map(sentGroups.map((group) => [group.mutation.id, group]));
    const protectedKeys = pendingRecordKeys(this.pendingMutationsRef);
    const saves: Promise<void>[] = [];

    const stamp = <T extends { id: string; version: number; updated_at: string }>(existing: T, result: MutationResult): T => ({
      ...existing,
      version: result.version ?? existing.version,
      updated_at: result.updated_at ?? existing.updated_at
    });

    for (const result of applied) {
      const group = groupByMutationId.get(result.id);
      const key = group ? mutationRecordKey(group.mutation) : null;
      if (key && protectedKeys.has(key)) {
        continue;
      }

      if (result.entity === "task") {
        const existing = this.stateRef.current.tasks.find((task) => task.id === result.recordId);
        if (!existing) continue;
        const next = stamp(existing, result);
        this.stateRef.current = { ...this.stateRef.current, tasks: upsertRecord(this.stateRef.current.tasks, next) };
        this.dispatch({ type: "upsertTask", payload: next });
        saves.push(this.io.saveEntity("tasks", next));
      } else if (result.entity === "project") {
        const existing = this.stateRef.current.projects.find((project) => project.id === result.recordId);
        if (!existing) continue;
        const next = stamp(existing, result);
        this.stateRef.current = { ...this.stateRef.current, projects: upsertRecord(this.stateRef.current.projects, next) };
        this.dispatch({ type: "upsertProject", payload: next });
        saves.push(this.io.saveEntity("projects", next));
      } else if (result.entity === "tag") {
        const existing = this.stateRef.current.tags.find((tag) => tag.id === result.recordId);
        if (!existing) continue;
        const next = stamp(existing, result);
        this.stateRef.current = { ...this.stateRef.current, tags: upsertRecord(this.stateRef.current.tags, next) };
        this.dispatch({ type: "upsertTag", payload: next });
        saves.push(this.io.saveEntity("tags", next));
      } else if (result.entity === "next_project") {
        const existing = this.stateRef.current.nextProjects.find((project) => project.id === result.recordId);
        if (!existing) continue;
        const next = stamp(existing, result);
        this.stateRef.current = { ...this.stateRef.current, nextProjects: upsertRecord(this.stateRef.current.nextProjects, next) };
        this.dispatch({ type: "upsertNextProject", payload: next });
        saves.push(this.io.saveEntity("nextProjects", next));
      } else if (result.entity === "next_idea") {
        const existing = this.stateRef.current.nextIdeas.find((idea) => idea.id === result.recordId);
        if (!existing) continue;
        const next = stamp(existing, result);
        this.stateRef.current = { ...this.stateRef.current, nextIdeas: upsertRecord(this.stateRef.current.nextIdeas, next) };
        this.dispatch({ type: "upsertNextIdea", payload: next });
        saves.push(this.io.saveEntity("nextIdeas", next));
      }
    }

    if (saves.length > 0) {
      await Promise.all(saves);
    }
  }

  // --- cloud Excel autosync --------------------------------------------------

  scheduleCloudExcelUpload = (delayMs = 5000): void => {
    if (!this.stateRef.current.session?.features.excelAutosync) {
      return;
    }
    if (!this.io.isOnline()) {
      return;
    }
    if (this.excelUploadTimer) {
      clearTimeout(this.excelUploadTimer);
    }

    this.excelUploadTimer = setTimeout(async () => {
      if (this.excelUploadInFlight) {
        this.scheduleCloudExcelUpload(delayMs);
        return;
      }
      this.excelUploadInFlight = true;
      try {
        const data = await this.io.getExportData();
        const blob = await this.io.workbookBlob(data);
        const result = await this.io.uploadCloudExcel(blob, CLOUD_EXCEL_FILENAME, visibleTasks(data.tasks).length);
        this.dispatch({ type: "setLastExport", payload: result.updatedAt });
      } catch (error) {
        this.dispatch({
          type: "setError",
          payload: error instanceof Error ? `Cloud Excel sync failed: ${error.message}` : "Cloud Excel sync failed"
        });
      } finally {
        this.excelUploadInFlight = false;
      }
    }, delayMs);
  };

  // --- keepalive flush on page hide ------------------------------------------

  flushPendingWithKeepalive = (): void => {
    if (!this.io.isOnline() || !this.stateRef.current.session || this.pendingMutationsRef.length === 0) {
      return;
    }

    const body = keepaliveBody(this.clientId, compactPendingMutations(this.pendingMutationsRef));
    if (!body) {
      return;
    }

    if (this.io.sendBeacon?.("/api/mutations", body)) {
      return;
    }

    void fetch("/api/mutations", {
      method: "POST",
      body,
      credentials: "same-origin",
      keepalive: true
    }).catch(() => undefined);
  };

  // --- the main sync loop ----------------------------------------------------

  syncNow = async (): Promise<void> => {
    if (this.forceFullResyncInFlight) {
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    if (!this.io.isOnline()) {
      this.dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (this.syncInFlight) {
      this.syncAgainAfterCurrent = true;
      await this.syncCompletion;
      return;
    }

    let resolveSyncCompletion: () => void = () => undefined;
    const currentSync = new Promise<void>((resolve) => {
      resolveSyncCompletion = resolve;
    });
    this.syncCompletion = currentSync;
    this.syncInFlight = true;
    let canRunQueuedSync = true;
    this.dispatch({ type: "setSyncStatus", payload: "syncing" });
    this.dispatch({ type: "setError", payload: null });

    try {
      let shouldUploadCloudExcel = false;
      if (!this.stateRef.current.session) {
        const session = await this.io.getSession();
        this.dispatch({ type: "setSession", payload: session });
      }

      await this.settlePendingWrites();
      const pending = mergePendingMutations(await this.io.getPendingMutations(), this.pendingMutationsRef);
      this.pendingMutationsRef = pending;
      const pendingGroups = compactPendingMutations(pending);
      if (pendingGroups.length > 0) {
        const result = await this.io.sendMutations(
          this.clientId,
          pendingGroups.map((group) => group.mutation)
        );
        // Drain anything the server gave a definitive answer for: applied, plus
        // permanently-rejected conflicts (malformed/unsupported) that can never
        // succeed on retry. Transient conflicts stay queued and are retried.
        const resolvedIds = new Set([
          ...result.applied.map((item) => item.id),
          ...result.conflicts.filter((item) => item.permanent).map((item) => item.id)
        ]);
        const sourceIdsToRemove = pendingGroups.flatMap((group) => (resolvedIds.has(group.mutation.id) ? group.sourceIds : []));
        await this.io.removePendingMutations(sourceIdsToRemove);
        this.forgetPendingMutations(sourceIdsToRemove);
        await this.applyMutationMetadata(result.applied, pendingGroups);
        this.dispatch({ type: "setConflicts", payload: result.conflicts.length });
        shouldUploadCloudExcel = result.applied.length > 0;
      }

      // The first sync after the app loads ignores the incremental cursor and
      // does a full bootstrap + replace. That reconciles local IndexedDB against
      // the server's authoritative live set, so if the cloud dataset was wiped
      // and re-seeded out of band, stale local rows are pruned automatically on
      // entry instead of doubling up against the fresh import. Subsequent syncs
      // in the session stay incremental. Pending edits are flushed above and kept
      // by the replace-mode merge, so nothing local is dropped.
      const fullReplace = this.fullBootstrapPending;
      const lastSync = fullReplace ? null : this.stateRef.current.lastSync;
      const refreshed = await this.io.bootstrap(lastSync);
      await this.applyBootstrapSnapshot(refreshed, fullReplace || !lastSync);
      this.fullBootstrapPending = false;
      shouldUploadCloudExcel = shouldUploadCloudExcel || Boolean(excelDirtyAt(refreshed.settings));
      await this.updatePendingCount();
      this.dispatch({ type: "setAuthRequired", payload: false });
      this.dispatch({ type: "setSyncStatus", payload: "idle" });
      if (shouldUploadCloudExcel) {
        this.scheduleCloudExcelUpload();
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        canRunQueuedSync = false;
        this.dispatch({ type: "setAuthRequired", payload: true });
        this.dispatch({ type: "setSession", payload: null });
      } else {
        this.dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Sync failed" });
        this.dispatch({ type: "setSyncStatus", payload: "error" });
      }
    } finally {
      this.syncInFlight = false;
      if (this.syncCompletion === currentSync) {
        this.syncCompletion = null;
      }
      resolveSyncCompletion();
      if (this.syncAgainAfterCurrent && canRunQueuedSync) {
        this.syncAgainAfterCurrent = false;
        setTimeout(() => void this.syncNow(), 0);
      }
    }
  };

  // Intentional, user-triggered cache reset. Use this only when the cloud
  // dataset was wiped and re-seeded out of band, so a client's stale IndexedDB
  // rows can't linger and double up against the fresh import. Pending edits must
  // drain before we touch local storage; then we fetch the full D1 snapshot
  // before clearing IndexedDB so a failed bootstrap cannot leave the cache empty.
  forceFullResync = async (): Promise<void> => {
    if (!this.io.isOnline()) {
      this.dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    this.dispatch({ type: "setSyncStatus", payload: "syncing" });
    this.dispatch({ type: "setError", payload: null });
    try {
      if (this.syncCompletion) {
        await this.syncCompletion;
      }
      await this.syncNow();
      if (this.syncCompletion) {
        await this.syncCompletion;
      }
      this.forceFullResyncInFlight = true;
      await this.settlePendingWrites();
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
      this.syncAgainAfterCurrent = false;
      const pending = mergePendingMutations(await this.io.getPendingMutations(), this.pendingMutationsRef);
      this.pendingMutationsRef = pending;
      const pendingCount = compactPendingMutations(pending).length;
      this.dispatch({ type: "setPendingCount", payload: pendingCount });
      if (pendingCount > 0) {
        throw new Error(`Full resync stopped because ${pendingCount} local change${pendingCount === 1 ? "" : "s"} still need to sync.`);
      }
      const refreshed = await this.io.bootstrap(null);
      await this.io.resetLocalData();
      this.pendingMutationsRef = [];
      this.dispatch({ type: "setPendingCount", payload: 0 });
      await this.applyBootstrapSnapshot(refreshed, true);
      await this.updatePendingCount();
      this.dispatch({ type: "setSyncStatus", payload: "idle" });
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        this.dispatch({ type: "setAuthRequired", payload: true });
        this.dispatch({ type: "setSession", payload: null });
      } else {
        this.dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Resync failed" });
        this.dispatch({ type: "setSyncStatus", payload: "error" });
      }
    } finally {
      this.forceFullResyncInFlight = false;
    }
  };

  scheduleSync = (): void => {
    if (!this.io.isOnline()) {
      this.dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (this.syncInFlight) {
      this.syncAgainAfterCurrent = true;
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.dispatch({ type: "setSyncStatus", payload: "queued" });
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  };
}
