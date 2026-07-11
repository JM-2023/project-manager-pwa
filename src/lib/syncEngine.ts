import { ApiResponseError, AuthRequiredError } from "./api";
import type {
  BootstrapResponse,
  ClientMutation,
  CloudExcelUploadResponse,
  ExportDataResponse,
  MutationConflict,
  MutationsResponse,
  SessionResponse
} from "./types";
import type { AppAction, AppState } from "../state/appStore";
import type { EntityStoreName, LocalEntityWrite, LocalMutationCommit, LocalSnapshot, SavableEntity } from "./localDb";
import {
  compactPendingMutations,
  excelDirtyAt,
  keepaliveBody,
  mergeBootstrapForLocal,
  mergePendingMutations,
  mutationRecordKey,
  pendingRecordKeys,
  replayPendingMutations,
  stateWithBootstrap,
  upsertRecord
} from "./syncMerge";
import { visibleTasks } from "./sync";

const SYNC_DEBOUNCE_MS = 850;
const MAX_MUTATIONS_PER_REQUEST = 10;
const MAX_RETRY_MS = 30_000;
const CLOUD_EXCEL_DEBOUNCE_MS = 15_000;
const CLOUD_EXCEL_FILENAME = "project-manager-latest.xlsx";
const MAX_WORKBOOK_TIMEOUT_ATTEMPTS = 2;

export interface SyncIO {
  getSession: () => Promise<SessionResponse>;
  bootstrap: (syncEpoch: string | null, syncCursor: number | null) => Promise<BootstrapResponse>;
  sendMutations: (clientId: string, mutations: ClientMutation[]) => Promise<MutationsResponse>;
  getExportData: (signal?: AbortSignal) => Promise<ExportDataResponse>;
  uploadCloudExcel: (
    blob: Blob,
    filename: string,
    rowCount: number,
    sourceSyncEpoch: string,
    sourceSyncCursor: number,
    signal?: AbortSignal
  ) => Promise<CloudExcelUploadResponse>;
  workbookBlob: (data: ExportDataResponse, signal?: AbortSignal) => Blob | Promise<Blob>;
  commitLocalMutation: (mutation: ClientMutation, commit?: LocalMutationCommit) => Promise<ClientMutation | void>;
  loadLocalSnapshot: () => Promise<LocalSnapshot>;
  getPendingMutations: () => Promise<ClientMutation[]>;
  removePendingMutations: (ids: string[]) => Promise<void>;
  saveBootstrapSnapshot: (snapshot: BootstrapResponse, replaceMode: boolean, removePendingIds?: string[]) => Promise<void>;
  saveLocalSession: (session: SessionResponse | null) => Promise<void>;
  saveLastSync: (value: string) => Promise<void>;
  isOnline: () => boolean;
  now: () => string;
  withSyncLease?: <T>(work: () => Promise<T>) => Promise<T>;
  publishSyncHint?: () => void;
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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private syncInFlight = false;
  private syncCompletion: Promise<void> | null = null;
  private syncAgainAfterCurrent = false;
  private forceFullResyncInFlight = false;
  private forceNextBootstrapFull = false;
  private excelUploadTimer: ReturnType<typeof setTimeout> | null = null;
  private excelUploadInFlight = false;
  private excelUploadController: AbortController | null = null;
  private excelUploadCompletion: Promise<void> | null = null;
  private excelRetryAttempt = 0;
  private excelRetryDirtyToken: string | null = null;
  private excelTimeoutDirtyToken: string | null = null;
  private excelTimeoutAttempts = 0;
  private excelCompletedDirtyToken: string | null = null;
  private excelBlockedDirtyToken: string | null = null;
  private suspended = false;
  private pendingMutationsRef: ClientMutation[] = [];
  private readonly pendingWritePromises = new Set<Promise<void>>();
  private localStateReconcile: Promise<void> = Promise.resolve();

  constructor(deps: SyncEngineDeps) {
    this.stateRef = deps.stateRef;
    this.dispatch = deps.dispatch;
    this.clientId = deps.clientId;
    this.io = deps.io;
  }

  hydratePending(mutations: ClientMutation[]): void {
    this.pendingMutationsRef = mutations;
  }

  markFullBootstrapPending(): void {
    this.forceNextBootstrapFull = true;
  }

  pendingMutations(): ClientMutation[] {
    return this.pendingMutationsRef;
  }

  /** Adopt another tab's durable optimistic edits without requiring a network. */
  adoptPendingFromStorage = async (): Promise<void> => {
    if (this.suspended) return;
    try {
      await this.settlePendingWrites();
      await this.refreshPendingFromStorage(true);
    } catch (error) {
      this.dispatch({ type: "setError", payload: error instanceof Error ? `Local refresh failed: ${error.message}` : "Local refresh failed" });
    }
  };

  /**
   * The entity write and outbox insert commit together. The pending badge and
   * sync scheduler advance only after IndexedDB confirms durability.
   */
  persistMutation(mutation: ClientMutation, commit: LocalMutationCommit = {}): void {
    const queuedMutation = { ...mutation, createdAt: mutation.createdAt ?? this.io.now() };
    if (this.suspended) {
      this.dispatch({ type: "setError", payload: "Local save paused while signing out" });
      this.dispatch({ type: "setSyncStatus", payload: "error" });
      const restore = this.enqueueLocalStateReconcile(async () => {
        await this.restoreDurableSnapshot();
      }).catch(() => undefined);
      this.trackPendingWrite(restore);
      return;
    }
    const write = this.io
      .commitLocalMutation(queuedMutation, commit)
      .then(async (durableMutation) => {
        if (commit.removePendingIds?.length) this.forgetPendingMutations(commit.removePendingIds);
        this.rememberPendingMutation(durableMutation ?? queuedMutation);
        const durablePending = [...this.pendingMutationsRef];
        const removedPendingIds = new Set(commit.removePendingIds ?? []);
        // A failed sibling commit may have restored the UI from IndexedDB while
        // this write was still pending. Replaying the now-durable outbox in a
        // serialized step makes the final UI include every successful write,
        // including while offline.
        await this.enqueueLocalStateReconcile(() => {
          this.pendingMutationsRef = mergePendingMutations(
            this.pendingMutationsRef.filter((item) => !removedPendingIds.has(item.id)),
            durablePending
          );
          this.overlayPendingState(durablePending);
        });
        this.io.publishSyncHint?.();
        this.scheduleSync();
      })
      .catch(async (error) => {
        const message = error instanceof Error ? `Local save failed: ${error.message}` : "Local save failed";
        await this.enqueueLocalStateReconcile(async () => {
          await this.restoreDurableSnapshot();
        }).catch(() => undefined);
        this.dispatch({ type: "setError", payload: message });
        this.dispatch({ type: "setSyncStatus", payload: "error" });
      });
    this.trackPendingWrite(write);
  }

  dropPendingMutations(ids: string[]): void {
    if (ids.length === 0) return;
    this.forgetPendingMutations(ids);
    void this.io.removePendingMutations(ids);
  }

  private rememberPendingMutation(mutation: ClientMutation): void {
    const byId = new Map(this.pendingMutationsRef.map((item) => [item.id, item]));
    byId.set(mutation.id, mutation);
    this.pendingMutationsRef = [...byId.values()];
    this.dispatch({ type: "setPendingCount", payload: compactPendingMutations(this.pendingMutationsRef).length });
  }

  private forgetPendingMutations(ids: string[]): void {
    const removed = new Set(ids);
    this.pendingMutationsRef = this.pendingMutationsRef.filter((mutation) => !removed.has(mutation.id));
    this.dispatch({ type: "setPendingCount", payload: compactPendingMutations(this.pendingMutationsRef).length });
  }

  private trackPendingWrite(promise: Promise<void>): void {
    this.pendingWritePromises.add(promise);
    void promise.finally(() => this.pendingWritePromises.delete(promise));
  }

  private async settlePendingWrites(): Promise<void> {
    while (this.pendingWritePromises.size > 0) {
      await Promise.allSettled([...this.pendingWritePromises]);
    }
  }

  private enqueueLocalStateReconcile(work: () => void | Promise<void>): Promise<void> {
    const next = this.localStateReconcile.then(work, work);
    this.localStateReconcile = next.catch(() => undefined);
    return next;
  }

  private overlayPendingState(mutations: ClientMutation[]): void {
    const overlaid = replayPendingMutations(this.stateRef.current, mutations);
    const payload = {
      projects: overlaid.projects,
      tasks: overlaid.tasks,
      nextProjects: overlaid.nextProjects,
      nextIdeas: overlaid.nextIdeas,
      settings: overlaid.settings,
      pendingCount: compactPendingMutations(this.pendingMutationsRef).length,
      lastSync: this.stateRef.current.lastSync,
      syncEpoch: this.stateRef.current.syncEpoch,
      syncCursor: this.stateRef.current.syncCursor
    };
    this.stateRef.current = { ...this.stateRef.current, ...payload };
    this.dispatch({ type: "hydrateLocal", payload });
  }

  private async restoreDurableSnapshot(): Promise<ClientMutation[]> {
    const local = await this.io.loadLocalSnapshot();
    const overlaid = replayPendingMutations(local, local.pendingMutations);
    this.pendingMutationsRef = local.pendingMutations;
    const payload = {
      projects: overlaid.projects,
      tasks: overlaid.tasks,
      nextProjects: overlaid.nextProjects,
      nextIdeas: overlaid.nextIdeas,
      settings: overlaid.settings,
      pendingCount: compactPendingMutations(local.pendingMutations).length,
      lastSync: local.lastSync,
      syncEpoch: local.syncEpoch,
      syncCursor: local.syncCursor
    };
    this.stateRef.current = { ...this.stateRef.current, ...payload };
    this.dispatch({ type: "hydrateLocal", payload });
    return local.pendingMutations;
  }

  private setConflictDetails(conflicts: MutationConflict[]): void {
    this.stateRef.current = { ...this.stateRef.current, conflicts };
    this.dispatch({ type: "setConflicts", payload: conflicts });
  }

  private reconcileConflictDetails(
    incoming: MutationConflict[],
    applied: MutationsResponse["applied"]
  ): void {
    const appliedIds = new Set(applied.map((item) => item.id));
    const appliedRecords = new Set(applied.map((item) => `${item.entity}:${item.recordId}`));
    const retained = (this.stateRef.current.conflicts ?? []).filter(
      (conflict) =>
        !appliedIds.has(conflict.id) &&
        !appliedRecords.has(`${conflict.entity}:${conflict.recordId}`)
    );
    const byMutation = new Map(retained.map((conflict) => [conflict.id, conflict]));
    for (const conflict of incoming) byMutation.set(conflict.id, conflict);
    this.setConflictDetails([...byMutation.values()]);
  }

  private async refreshPendingFromStorage(replay = false, excludedIds: ReadonlySet<string> = new Set()): Promise<ClientMutation[]> {
    const persisted = (await this.io.getPendingMutations()).filter((mutation) => !excludedIds.has(mutation.id));
    this.pendingMutationsRef = persisted;
    this.dispatch({ type: "setPendingCount", payload: compactPendingMutations(persisted).length });
    if (replay && persisted.length > 0) this.overlayPendingState(persisted);
    return persisted;
  }

  private async applyBootstrapSnapshot(
    snapshot: BootstrapResponse,
    replaceMode: boolean,
    removePendingIds: string[] = []
  ): Promise<void> {
    const emptyDelta =
      !replaceMode &&
      removePendingIds.length === 0 &&
      snapshot.projects.length === 0 &&
      snapshot.tasks.length === 0 &&
      snapshot.nextProjects.length === 0 &&
      snapshot.nextIdeas.length === 0 &&
      Object.keys(snapshot.settings).length === 0 &&
      snapshot.syncEpoch === this.stateRef.current.syncEpoch &&
      snapshot.syncCursor === this.stateRef.current.syncCursor;
    if (emptyDelta) {
      this.stateRef.current = { ...this.stateRef.current, lastSync: snapshot.serverTime };
      this.dispatch({ type: "setLastSync", payload: snapshot.serverTime });
      await this.io.saveLastSync(snapshot.serverTime);
      return;
    }
    const merged = mergeBootstrapForLocal(this.stateRef.current, snapshot, this.pendingMutationsRef, replaceMode);
    this.stateRef.current = stateWithBootstrap(this.stateRef.current, merged);
    this.dispatch({ type: "replaceBootstrap", payload: merged });

    if (replaceMode) {
      if (removePendingIds.length > 0) await this.io.saveBootstrapSnapshot(merged, true, removePendingIds);
      else await this.io.saveBootstrapSnapshot(merged, true);
    } else {
      const protectedKeys = pendingRecordKeys(this.pendingMutationsRef);
      const persistable: BootstrapResponse = {
        ...snapshot,
        projects: snapshot.projects.filter((row) => !protectedKeys.has(`project:${row.id}`)),
        tasks: snapshot.tasks.filter((row) => !protectedKeys.has(`task:${row.id}`)),
        nextProjects: snapshot.nextProjects.filter((row) => !protectedKeys.has(`next_project:${row.id}`)),
        nextIdeas: snapshot.nextIdeas.filter((row) => !protectedKeys.has(`next_idea:${row.id}`)),
        settings: merged.settings
      };
      if (removePendingIds.length > 0) await this.io.saveBootstrapSnapshot(persistable, false, removePendingIds);
      else await this.io.saveBootstrapSnapshot(persistable, false);
    }
  }

  private async rebaseConflict(
    group: ReturnType<typeof compactPendingMutations>[number],
    serverRecordValue: unknown
  ): Promise<boolean> {
    const serverRecord =
      serverRecordValue && typeof serverRecordValue === "object" && !Array.isArray(serverRecordValue)
        ? (serverRecordValue as Record<string, unknown>)
        : null;
    const serverVersion = Number(serverRecord?.version);
    if (!serverRecord || !Number.isFinite(serverVersion) || group.mutation.entity === "setting") return false;

    const recordId = String((group.mutation.data as Record<string, unknown>)?.id ?? serverRecord.id ?? "");
    if (!recordId) return false;
    const deleting = group.mutation.operation === "delete" || group.mutation.operation === "purge";
    if (!deleting && !group.mutation.patch) return false;
    const optimistic = deleting
      ? group.mutation.data
      : {
          ...serverRecord,
          ...group.mutation.patch,
          id: recordId,
          updated_at: this.io.now(),
          version: serverVersion + 1
        };
    const rebased: ClientMutation = {
      ...group.mutation,
      baseVersion: serverVersion,
      data: optimistic,
      createdAt: this.io.now()
    };

    const stores: Partial<Record<ClientMutation["entity"], EntityStoreName>> = {
      project: "projects",
      task: "tasks",
      next_project: "nextProjects",
      next_idea: "nextIdeas"
    };
    const store = stores[rebased.entity];
    const writes: LocalEntityWrite[] =
      store && !deleting ? [{ type: "put", store, record: optimistic as SavableEntity }] : [];
    const durableMutation = await this.io.commitLocalMutation(rebased, {
      writes,
      removePendingIds: group.sourceIds,
      replaceExisting: !deleting
    });
    this.forgetPendingMutations(group.sourceIds);
    this.rememberPendingMutation(durableMutation ?? rebased);
    if (!deleting) {
      if (rebased.entity === "project") {
        this.stateRef.current = {
          ...this.stateRef.current,
          projects: upsertRecord(this.stateRef.current.projects, optimistic as AppState["projects"][number])
        };
      } else if (rebased.entity === "task") {
        this.stateRef.current = {
          ...this.stateRef.current,
          tasks: upsertRecord(this.stateRef.current.tasks, optimistic as AppState["tasks"][number])
        };
      } else if (rebased.entity === "next_project") {
        this.stateRef.current = {
          ...this.stateRef.current,
          nextProjects: upsertRecord(this.stateRef.current.nextProjects, optimistic as AppState["nextProjects"][number])
        };
      } else if (rebased.entity === "next_idea") {
        this.stateRef.current = {
          ...this.stateRef.current,
          nextIdeas: upsertRecord(this.stateRef.current.nextIdeas, optimistic as AppState["nextIdeas"][number])
        };
      }
    }
    this.overlayPendingState(this.pendingMutationsRef);
    this.io.publishSyncHint?.();
    this.syncAgainAfterCurrent = true;
    return true;
  }

  scheduleCloudExcelUpload = (
    delayMs = CLOUD_EXCEL_DEBOUNCE_MS,
    dirtyToken = excelDirtyAt(this.stateRef.current.settings)
  ): void => {
    if (
      this.suspended ||
      !dirtyToken ||
      dirtyToken === this.excelCompletedDirtyToken ||
      dirtyToken === this.excelBlockedDirtyToken ||
      !this.stateRef.current.session?.features.excelAutosync ||
      !this.io.isOnline()
    ) return;
    if (this.excelUploadTimer) clearTimeout(this.excelUploadTimer);

    this.excelUploadTimer = setTimeout(() => {
      this.excelUploadTimer = null;
      if (this.suspended) return;
      if (this.excelUploadInFlight) {
        this.scheduleCloudExcelUpload(delayMs, dirtyToken);
        return;
      }
      this.excelUploadInFlight = true;
      if (this.excelRetryDirtyToken !== dirtyToken) {
        this.excelRetryDirtyToken = dirtyToken;
        this.excelRetryAttempt = 0;
      }
      const controller = new AbortController();
      this.excelUploadController = controller;
      const run = (async () => {
        try {
          const data = await this.io.getExportData(controller.signal);
          const sourceSyncEpoch = data.syncEpoch;
          const sourceSyncCursor = data.syncCursor;
          const blob = await this.io.workbookBlob(data, controller.signal);
          const result = await this.io.uploadCloudExcel(
            blob,
            CLOUD_EXCEL_FILENAME,
            visibleTasks(data.tasks).length,
            sourceSyncEpoch,
            sourceSyncCursor,
            controller.signal
          );
          this.excelRetryAttempt = 0;
          this.excelRetryDirtyToken = null;
          this.excelTimeoutDirtyToken = null;
          this.excelTimeoutAttempts = 0;
          this.excelCompletedDirtyToken = dirtyToken;
          this.excelBlockedDirtyToken = null;
          this.dispatch({ type: "setLastExport", payload: result.updatedAt });
        } catch (error) {
          // Signing out or disposing the engine deliberately aborts this
          // pipeline. It must finish quietly without scheduling work for the
          // session that is being torn down.
          if (controller.signal.aborted) return;
          this.dispatch({
            type: "setError",
            payload: error instanceof Error ? `Cloud Excel sync failed: ${error.message}` : "Cloud Excel sync failed"
          });
          const errorName = error instanceof Error ? error.name : "";
          if (errorName === "WorkbookWorkerTimeoutError") {
            if (this.excelTimeoutDirtyToken !== dirtyToken) {
              this.excelTimeoutDirtyToken = dirtyToken;
              this.excelTimeoutAttempts = 0;
            }
            this.excelTimeoutAttempts += 1;
          }
          const permanentWorkbookFailure =
            errorName === "WorkbookWorkerBuildError" ||
            (errorName === "WorkbookWorkerTimeoutError" && this.excelTimeoutAttempts >= MAX_WORKBOOK_TIMEOUT_ATTEMPTS);

          if (error instanceof AuthRequiredError) {
            this.dispatch({ type: "setAuthRequired", payload: true });
            this.dispatch({ type: "setSession", payload: null });
            this.stateRef.current = { ...this.stateRef.current, session: null, authRequired: true };
            await this.io.saveLocalSession(null).catch(() => undefined);
          } else if ((error instanceof ApiResponseError && !error.retryable) || permanentWorkbookFailure) {
            this.excelBlockedDirtyToken = dirtyToken;
          } else {
            const retryMs = Math.min(MAX_RETRY_MS, 2000 * 2 ** this.excelRetryAttempt++);
            // A newer edit may already have scheduled its own export while
            // this one was in flight. Preserve that timer; otherwise retry the
            // current state token so an older failure cannot displace it.
            if (!this.excelUploadTimer) {
              const currentDirtyToken = excelDirtyAt(this.stateRef.current.settings);
              if (currentDirtyToken) this.scheduleCloudExcelUpload(retryMs, currentDirtyToken);
            }
          }
        }
      })();
      let completion: Promise<void>;
      completion = run.finally(() => {
        if (this.excelUploadController === controller) {
          this.excelUploadController = null;
          this.excelUploadInFlight = false;
        }
        if (this.excelUploadCompletion === completion) {
          this.excelUploadCompletion = null;
        }
      });
      this.excelUploadCompletion = completion;
      void completion.catch(() => undefined);
    }, delayMs);
  };

  flushPendingWithKeepalive = (): void => {
    if (this.suspended || !this.io.isOnline() || !this.stateRef.current.session || this.pendingMutationsRef.length === 0) return;
    const body = keepaliveBody(this.clientId, compactPendingMutations(this.pendingMutationsRef));
    if (!body) return;
    if (this.io.sendBeacon?.("/api/mutations", body)) return;
    void fetch("/api/mutations", { method: "POST", body, credentials: "same-origin", keepalive: true }).catch(() => undefined);
  };

  private clearRetry(): void {
    this.retryAttempt = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.suspended || !this.io.isOnline() || this.retryTimer) return;
    const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.retryAttempt++);
    const delay = Math.min(MAX_RETRY_MS, Math.round(base * (1 + Math.random() * 0.2)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, delay);
  }

  private async runSyncCycle(): Promise<void> {
    let shouldUploadCloudExcel = false;
    let retryUnresolvedMutations = false;
    let sentBatchFullyResolved = true;
    let pendingIdsResolvedWithBootstrap: string[] = [];
    if (!this.stateRef.current.session) {
      const session = await this.io.getSession();
      this.stateRef.current = { ...this.stateRef.current, session, authRequired: false };
      this.dispatch({ type: "setSession", payload: session });
      await this.io.saveLocalSession(session);
    }

    await this.settlePendingWrites();
    const pending = await this.refreshPendingFromStorage(true);
    const pendingGroups = compactPendingMutations(pending);
    const sentGroups = pendingGroups.slice(0, MAX_MUTATIONS_PER_REQUEST);
    if (sentGroups.length > 0) {
      const result = await this.io.sendMutations(
        this.clientId,
        sentGroups.map((group) => group.mutation)
      );
      const appliedIds = new Set(result.applied.map((item) => item.id));
      const permanentIds = new Set(result.conflicts.filter((item) => item.permanent).map((item) => item.id));
      const resolvedIds = new Set([...appliedIds, ...permanentIds]);
      const groupById = new Map(sentGroups.map((group) => [group.mutation.id, group]));
      for (const conflict of result.conflicts) {
        if (conflict.permanent || conflict.serverRecord === undefined) continue;
        const group = groupById.get(conflict.id);
        if (group && (await this.rebaseConflict(group, conflict.serverRecord))) resolvedIds.add(conflict.id);
      }
      sentBatchFullyResolved = sentGroups.every((group) => resolvedIds.has(group.mutation.id));
      retryUnresolvedMutations = !sentBatchFullyResolved;
      const sourceIdsToRemove = sentGroups.flatMap((group) => (appliedIds.has(group.mutation.id) ? group.sourceIds : []));
      pendingIdsResolvedWithBootstrap = sentGroups.flatMap((group) =>
        permanentIds.has(group.mutation.id) ? group.sourceIds : []
      );
      await this.io.removePendingMutations(sourceIdsToRemove);
      this.forgetPendingMutations([...sourceIdsToRemove, ...pendingIdsResolvedWithBootstrap]);
      if (pendingIdsResolvedWithBootstrap.length > 0) {
        // The rejected optimistic row may not appear in an incremental delta
        // because the server did not change during this request. A full pull
        // restores stale deletes and removes invalid local-only creates.
        this.forceNextBootstrapFull = true;
      }
      // A later successful edit clears the conflict for that record. Conflicts
      // from an earlier batch remain visible while subsequent independent
      // batches drain, rather than disappearing in the next zero-delay cycle.
      this.reconcileConflictDetails(result.conflicts, result.applied);
      if (pendingGroups.length > sentGroups.length && sentBatchFullyResolved) this.syncAgainAfterCurrent = true;
    } else if ((this.stateRef.current.conflicts ?? []).length > 0) this.setConflictDetails([]);

    const requestedEpoch = this.forceNextBootstrapFull ? null : this.stateRef.current.syncEpoch;
    const requestedCursor = this.forceNextBootstrapFull ? null : this.stateRef.current.syncCursor;
    const refreshed = await this.io.bootstrap(requestedEpoch, requestedCursor);

    // Include writes from another tab that landed while the network request was
    // in flight before deciding which incoming rows may touch local state.
    await this.settlePendingWrites();
    const resolvingIds = new Set(pendingIdsResolvedWithBootstrap);
    await this.refreshPendingFromStorage(true, resolvingIds);
    const replaceMode =
      refreshed.full === true || requestedEpoch === null || requestedCursor === null || refreshed.syncEpoch !== requestedEpoch;
    await this.applyBootstrapSnapshot(refreshed, replaceMode, pendingIdsResolvedWithBootstrap);
    this.forceNextBootstrapFull = false;

    // A cross-tab write can race the IndexedDB snapshot transaction. Replay the
    // durable outbox once more and schedule another pass if anything remains.
    const remaining = await this.refreshPendingFromStorage(true);
    const originalIds = new Set(pending.map((mutation) => mutation.id));
    if (remaining.some((mutation) => !originalIds.has(mutation.id))) this.syncAgainAfterCurrent = true;
    const dirtyToken = excelDirtyAt(this.stateRef.current.settings);
    shouldUploadCloudExcel = Boolean(dirtyToken);
    this.dispatch({ type: "setAuthRequired", payload: false });
    this.dispatch({ type: "setSyncStatus", payload: "idle" });
    if (retryUnresolvedMutations) this.scheduleRetry();
    else this.clearRetry();
    if (shouldUploadCloudExcel) this.scheduleCloudExcelUpload(CLOUD_EXCEL_DEBOUNCE_MS, dirtyToken);
  }

  syncNow = async (): Promise<void> => {
    if (this.suspended || this.forceFullResyncInFlight) return;
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
      await this.syncCompletion?.catch(() => undefined);
      return;
    }

    this.syncInFlight = true;
    this.dispatch({ type: "setSyncStatus", payload: "syncing" });
    this.dispatch({ type: "setError", payload: null });
    const work = async () => {
      if (this.io.withSyncLease) await this.io.withSyncLease(() => this.runSyncCycle());
      else await this.runSyncCycle();
    };
    const current = work();
    this.syncCompletion = current;
    let canRunAgain = true;
    try {
      await current;
    } catch (error) {
      // If a permanent conflict was awaiting an atomic full-snapshot commit,
      // restore its still-durable outbox entry after any failed bootstrap.
      await this.refreshPendingFromStorage(true).catch(() => undefined);
      if (error instanceof AuthRequiredError) {
        canRunAgain = false;
        this.stateRef.current = { ...this.stateRef.current, session: null, authRequired: true };
        this.dispatch({ type: "setAuthRequired", payload: true });
        this.dispatch({ type: "setSession", payload: null });
        await this.io.saveLocalSession(null).catch(() => undefined);
      } else {
        this.dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Sync failed" });
        this.dispatch({ type: "setSyncStatus", payload: "error" });
        this.scheduleRetry();
      }
    } finally {
      this.syncInFlight = false;
      if (this.syncCompletion === current) this.syncCompletion = null;
      if (!canRunAgain) this.syncAgainAfterCurrent = false;
      else if (this.syncAgainAfterCurrent) {
        this.syncAgainAfterCurrent = false;
        setTimeout(() => void this.syncNow(), 0);
      }
    }
  };

  forceFullResync = async (): Promise<void> => {
    if (this.suspended) return;
    if (!this.io.isOnline()) {
      this.dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (this.syncCompletion) await this.syncCompletion.catch(() => undefined);
    this.forceFullResyncInFlight = true;
    this.dispatch({ type: "setSyncStatus", payload: "syncing" });
    this.dispatch({ type: "setError", payload: null });
    try {
      const work = async () => {
        const refreshed = await this.io.bootstrap(null, null);
        await this.settlePendingWrites();
        await this.refreshPendingFromStorage(true);
        await this.applyBootstrapSnapshot(refreshed, true);
        const remaining = await this.refreshPendingFromStorage(true);
        if (remaining.length > 0) this.syncAgainAfterCurrent = true;
      };
      if (this.io.withSyncLease) await this.io.withSyncLease(work);
      else await work();
      this.forceNextBootstrapFull = false;
      this.dispatch({ type: "setSyncStatus", payload: "idle" });
      this.clearRetry();
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        this.stateRef.current = { ...this.stateRef.current, session: null, authRequired: true };
        this.dispatch({ type: "setAuthRequired", payload: true });
        this.dispatch({ type: "setSession", payload: null });
        await this.io.saveLocalSession(null).catch(() => undefined);
      } else {
        this.dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Resync failed" });
        this.dispatch({ type: "setSyncStatus", payload: "error" });
        this.scheduleRetry();
      }
    } finally {
      this.forceFullResyncInFlight = false;
      if (this.syncAgainAfterCurrent) {
        this.syncAgainAfterCurrent = false;
        setTimeout(() => void this.syncNow(), 0);
      }
    }
  };

  scheduleSync = (): void => {
    if (this.suspended) return;
    if (!this.io.isOnline()) {
      this.dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (this.syncInFlight) {
      this.syncAgainAfterCurrent = true;
      return;
    }
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.dispatch({ type: "setSyncStatus", payload: "queued" });
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  };

  dispose(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.excelUploadTimer) clearTimeout(this.excelUploadTimer);
    this.syncTimer = null;
    this.retryTimer = null;
    this.excelUploadTimer = null;
    this.excelUploadController?.abort(new DOMException("Sync engine suspended", "AbortError"));
  }

  async suspend(): Promise<ClientMutation[]> {
    this.suspended = true;
    this.syncAgainAfterCurrent = false;
    const syncCompletion = this.syncCompletion;
    const excelUploadCompletion = this.excelUploadCompletion;
    this.dispose();
    await Promise.all([
      syncCompletion?.catch(() => undefined),
      excelUploadCompletion?.catch(() => undefined)
    ]);
    await this.settlePendingWrites();
    return this.refreshPendingFromStorage(false);
  }

  async flushWhileSuspended(): Promise<ClientMutation[]> {
    if (!this.suspended) return this.pendingMutationsRef;
    this.suspended = false;
    try {
      await this.syncNow();
    } finally {
      this.suspended = true;
      this.dispose();
    }
    await this.settlePendingWrites();
    return this.refreshPendingFromStorage(false);
  }

  resume(): void {
    this.suspended = false;
  }
}
