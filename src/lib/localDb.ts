import type { BootstrapResponse, ClientMutation, NextIdea, NextProject, Project, SessionResponse, Task } from "./types";
import { sanitizeSettings } from "./sync";
import { compactPendingMutations, mergeMutationRecord, mutationData } from "./syncMerge";
import { describeError, trace } from "./syncTrace";

const DB_NAME = "project-manager-pwa";
// v3 removed the tag stores. v4 adds persisted sync epoch/cursor and cached
// session metadata; no new object store is required for those meta records.
const DB_VERSION = 4;
const REMOVED_STORES = ["tags", "taskTags"];
const OFFLINE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type StoreName = "projects" | "tasks" | "nextProjects" | "nextIdeas" | "pendingMutations" | "meta";
export type EntityStoreName = "projects" | "tasks" | "nextProjects" | "nextIdeas";
export type SavableEntity = Project | Task | NextProject | NextIdea;

export interface LocalSnapshot {
  projects: Project[];
  tasks: Task[];
  nextProjects: NextProject[];
  nextIdeas: NextIdea[];
  settings: Record<string, unknown>;
  pendingMutations: ClientMutation[];
  lastSync: string | null;
  syncEpoch: string | null;
  syncCursor: number | null;
  session: SessionResponse | null;
}

export type LocalEntityWrite =
  | { type: "put"; store: EntityStoreName; record: SavableEntity }
  | { type: "delete"; store: EntityStoreName; id: string };

export interface LocalMutationCommit {
  writes?: LocalEntityWrite[];
  /** Pending child edits superseded by a cascade delete, removed in the same transaction. */
  removePendingIds?: string[];
  /** Conflict rebases already contain the merged server record and must replace the stale local base. */
  replaceExisting?: boolean;
}

export function isCachedSessionUsable(session: SessionResponse | null, now = Date.now()): session is SessionResponse {
  if (!session?.offlineExpiresAt) return false;
  const expiresAt = Date.parse(session.offlineExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function forgetConnection(connection: Promise<IDBDatabase>): void {
  if (dbPromise === connection) dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let abandoned = false;

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("nextProjects")) db.createObjectStore("nextProjects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("nextIdeas")) db.createObjectStore("nextIdeas", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pendingMutations")) db.createObjectStore("pendingMutations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      for (const store of REMOVED_STORES) {
        if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        forgetConnection(opening);
      };
      // iOS Safari force-closes the IndexedDB connections of a page it has
      // suspended in the background. Once that happens every transaction on
      // the cached handle fails until the page reloads, so drop the handle and
      // let the next operation open a fresh connection.
      db.onclose = () => forgetConnection(opening);
      resolve(db);
    };
    request.onblocked = () => {
      abandoned = true;
      forgetConnection(opening);
      reject(new Error("Local database upgrade is waiting for another open tab. Close the other tab and reload."));
    };
    request.onerror = () => {
      forgetConnection(opening);
      reject(request.error);
    };
  });
  dbPromise = opening;

  return opening;
}

function isLostConnectionError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  // InvalidStateError: transaction() on a closed connection. AbortError: a
  // transaction the browser aborted while force-closing the connection.
  // UnknownError: WebKit's "Connection to Indexed Database server lost".
  return name === "InvalidStateError" || name === "AbortError" || name === "UnknownError";
}

/**
 * WebKit can also leave a request pending forever instead of failing it. Past
 * this bound we abort the attempt's transactions. Only confirmed rollbacks
 * may be retried; an uncertain commit must not replay over a newer edit.
 */
export const LOCAL_DB_TIMEOUT_MS = 20_000;
const SLOW_LOCAL_DB_MS = 1_500;

export class LocalDbTimeoutError extends Error {
  constructor(label: string) {
    super(`Local database did not respond within ${LOCAL_DB_TIMEOUT_MS / 1000}s (${label})`);
    this.name = "LocalDbTimeoutError";
  }
}

type LocalConnection = Pick<IDBDatabase, "transaction">;
class RetryableLocalError extends Error {
  constructor(cause: unknown) { super("Local transaction rolled back", { cause }); }
}

interface TrackedTransaction {
  tx: IDBTransaction;
  status: "pending" | "complete" | "abort";
  done: Promise<void>;
}

/** Every attempt owns its transactions, including reads and delayed opens. */
async function attempt<T>(label: string, work: (db: LocalConnection) => Promise<T>): Promise<T> {
  const connection = openDb();
  const transactions: TrackedTransaction[] = [];
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new LocalDbTimeoutError(label);
  const operation = (async () => {
    const db = await connection;
    if (expired) throw timeout; // An open request must never start late writes.
    const scoped: LocalConnection = {
      transaction: (...args) => {
        if (expired) throw timeout;
        const tx = db.transaction(...args);
        let finish!: () => void;
        const item: TrackedTransaction = { tx, status: "pending", done: new Promise<void>((resolve) => { finish = resolve; }) };
        tx.addEventListener("complete", () => { item.status = "complete"; finish(); }, { once: true });
        tx.addEventListener("abort", () => { item.status = "abort"; finish(); }, { once: true });
        transactions.push(item);
        return tx;
      }
    };
    const value = await work(scoped);
    await Promise.all(transactions.map((item) => item.done));
    if (transactions.some((item) => item.status === "abort")) throw new DOMException("Local read aborted", "AbortError");
    return value;
  })();
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout), LOCAL_DB_TIMEOUT_MS); });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    expired = true;
    // close() does not abort transactions. Explicitly abort and observe their
    // terminal events before deciding a write can safely be repeated.
    for (const item of transactions) {
      if (item.status === "pending") { try { item.tx.abort(); } catch { /* Already finishing; don't assume rollback. */ } }
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(transactions.map((item) => item.done)),
      new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 1000); })
    ]);
    clearTimeout(cleanupTimer);
    const rolledBack = transactions.every((item) => item.status === "abort");
    if (error === timeout || isLostConnectionError(error)) {
      forgetConnection(connection);
      void connection.then((db) => db.close()).catch(() => undefined);
    }
    // No transactions (e.g. a delayed open) or confirmed aborts are retryable.
    // A completed/unknown commit is never replayed over subsequent edits.
    if (rolledBack && (error === timeout || isLostConnectionError(error))) {
      throw new RetryableLocalError(error);
    }
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

async function withDb<T>(label: string, work: (db: LocalConnection) => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  for (let tries = 0; ; tries++) {
    try {
      const value = await attempt(label, work);
      if (Date.now() - startedAt >= SLOW_LOCAL_DB_MS) trace(`idb ${label} slow`, `${Date.now() - startedAt}ms`);
      return value;
    } catch (error) {
      if (error instanceof RetryableLocalError) {
        if (tries === 0) { trace(`idb ${label} retry after rollback`, describeError(error.cause)); continue; }
        throw error.cause;
      }
      throw error;
    }
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new DOMException("IndexedDB transaction failed", "AbortError"));
    tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
  });
}

async function getAll<T>(storeName: StoreName): Promise<T[]> {
  return withDb("getAll", async (db) => {
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  });
}

async function getMeta<T>(key: string): Promise<T | null> {
  return withDb("getMeta", async (db) => {
    return new Promise((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  });
}

async function setMeta(key: string, value: unknown): Promise<void> {
  return withDb("setMeta", async (db) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    await transactionDone(tx);
  });
}

export async function loadLocalSnapshot(): Promise<LocalSnapshot> {
  return withDb("loadLocalSnapshot", async (db) => {
    const tx = db.transaction(["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"], "readonly");
    const read = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const meta = <T>(key: string) => read(tx.objectStore("meta").get(key)).then((row) => (row?.value ?? null) as T | null);
    const [projects, tasks, nextProjects, nextIdeas, pendingMutations, settings, lastSync, syncEpoch, syncCursor, session] = await Promise.all([
      read<Project[]>(tx.objectStore("projects").getAll()),
      read<Task[]>(tx.objectStore("tasks").getAll()),
      read<NextProject[]>(tx.objectStore("nextProjects").getAll()),
      read<NextIdea[]>(tx.objectStore("nextIdeas").getAll()),
      read<ClientMutation[]>(tx.objectStore("pendingMutations").getAll()),
      meta<Record<string, unknown>>("settings"), meta<string>("lastSync"),
      meta<string>("syncEpoch"), meta<number>("syncCursor"), meta<SessionResponse>("session")
    ]);
    return { projects, tasks, nextProjects, nextIdeas, pendingMutations, settings: sanitizeSettings(settings ?? {}), lastSync, syncEpoch, syncCursor, session };
  });
}

function persistIncomingRecord(store: IDBObjectStore, record: SavableEntity): void {
  if (record.deleted_at) {
    store.delete(record.id);
  } else {
    store.put(record);
  }
}

/**
 * Persist a cloud snapshot. Full snapshots replace entity stores; incremental
 * snapshots touch only returned rows, keeping no-op pulls proportional to the
 * amount of cloud data that actually changed.
 */
export async function saveBootstrapSnapshot(
  snapshot: BootstrapResponse,
  replaceMode: boolean,
  removePendingIds: string[] = []
): Promise<void> {
  return withDb("saveBootstrapSnapshot", async (db) => {
    const tx = db.transaction(["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"], "readwrite");
    const pendingRequest = tx.objectStore("pendingMutations").getAll();
    pendingRequest.onsuccess = () => {
      const removed = new Set(removePendingIds);
      for (const id of removed) tx.objectStore("pendingMutations").delete(id);
      const pending = (pendingRequest.result as ClientMutation[]).filter((mutation) => !removed.has(mutation.id));
      const compactedPending = compactPendingMutations(pending).map((group) => group.mutation);
      if (replaceMode) {
        for (const storeName of ["projects", "tasks", "nextProjects", "nextIdeas"] as const) {
          tx.objectStore(storeName).clear();
        }
      }
      for (const project of snapshot.projects) persistIncomingRecord(tx.objectStore("projects"), project);
      for (const task of snapshot.tasks) persistIncomingRecord(tx.objectStore("tasks"), task);
      for (const nextProject of snapshot.nextProjects) persistIncomingRecord(tx.objectStore("nextProjects"), nextProject);
      for (const nextIdea of snapshot.nextIdeas) persistIncomingRecord(tx.objectStore("nextIdeas"), nextIdea);

      const settings = { ...sanitizeSettings(snapshot.settings) };
      // Reapply the outbox within this same transaction. This closes the narrow
      // cross-tab race where a local write commits while a cloud fetch is in
      // flight and would otherwise be overwritten by the later snapshot write.
      const deletedProjectIds = new Set(
        compactedPending
          .filter((mutation) => mutation.entity === "project" && (mutation.operation === "delete" || mutation.operation === "purge"))
          .map((mutation) => String((mutation.data as Record<string, unknown>)?.id ?? ""))
          .filter(Boolean)
      );
      const deletedNextProjectIds = new Set(
        compactedPending
          .filter((mutation) => mutation.entity === "next_project" && (mutation.operation === "delete" || mutation.operation === "purge"))
          .map((mutation) => String((mutation.data as Record<string, unknown>)?.id ?? ""))
          .filter(Boolean)
      );
      const putMerged = (storeName: EntityStoreName, mutation: ClientMutation) => {
        const data = mutationData(mutation);
        const id = String(data.id ?? "");
        const store = tx.objectStore(storeName);
        if (!id || mutation.baseVersion === null || mutation.baseVersion === undefined || !mutation.patch) {
          if (id) store.put(data);
          return;
        }
        const request = store.get(id);
        request.onsuccess = () => store.put(mergeMutationRecord(request.result as Record<string, unknown> | undefined, mutation));
        request.onerror = () => tx.abort();
      };
      for (const mutation of compactedPending) {
        const data = mutationData(mutation);
        const id = typeof data.id === "string" ? data.id : "";
        const deleting = mutation.operation === "delete" || mutation.operation === "purge";
        if (mutation.entity === "setting") {
          const key = String(data.key ?? data.id ?? "");
          if (key && mutation.operation === "upsert") settings[key] = data.value;
          else if (key) delete settings[key];
        } else if (mutation.entity === "project" && id) {
          if (deleting) {
            tx.objectStore("projects").delete(id);
            for (const taskId of Array.isArray(data.taskIds) ? data.taskIds : []) tx.objectStore("tasks").delete(String(taskId));
          } else putMerged("projects", mutation);
        } else if (mutation.entity === "task" && id) {
          if (deleting || deletedProjectIds.has(String(data.project_id ?? ""))) tx.objectStore("tasks").delete(id);
          else putMerged("tasks", mutation);
        } else if (mutation.entity === "next_project" && id) {
          if (deleting) {
            tx.objectStore("nextProjects").delete(id);
            for (const ideaId of Array.isArray(data.ideaIds) ? data.ideaIds : []) tx.objectStore("nextIdeas").delete(String(ideaId));
          } else putMerged("nextProjects", mutation);
        } else if (mutation.entity === "next_idea" && id) {
          if (deleting || deletedNextProjectIds.has(String(data.next_project_id ?? ""))) tx.objectStore("nextIdeas").delete(id);
          else putMerged("nextIdeas", mutation);
        }
      }

      tx.objectStore("meta").put({ key: "settings", value: settings });
      tx.objectStore("meta").put({ key: "lastSync", value: snapshot.serverTime });
      tx.objectStore("meta").put({ key: "syncEpoch", value: snapshot.syncEpoch });
      tx.objectStore("meta").put({ key: "syncCursor", value: snapshot.syncCursor });
    };
    pendingRequest.onerror = () => tx.abort();
    await transactionDone(tx);
  });
}

/** Atomically persist the optimistic entity change and its durable outbox entry. */
export async function commitLocalMutation(mutation: ClientMutation, commit: LocalMutationCommit = {}): Promise<ClientMutation> {
  return withDb("commitLocalMutation", async (db) => {
    const stores = new Set<StoreName>(["pendingMutations"]);
    for (const write of commit.writes ?? []) stores.add(write.store);
    const tx = db.transaction([...stores], "readwrite");
    const pendingStore = tx.objectStore("pendingMutations");
    for (const id of commit.removePendingIds ?? []) pendingStore.delete(id);

    const mutationId = String(mutationData(mutation).id ?? "");
    const matchingPut = (commit.writes ?? []).find(
      (write): write is Extract<LocalEntityWrite, { type: "put" }> =>
        write.type === "put" && write.record.id === mutationId
    );
    let durableMutation = mutation;
    const applyWrites = (mergedRecord?: SavableEntity) => {
      for (const write of commit.writes ?? []) {
        const store = tx.objectStore(write.store);
        if (write.type === "delete") store.delete(write.id);
        else if (mergedRecord && write === matchingPut) store.put(mergedRecord);
        else store.put(write.record);
      }
      if (mergedRecord) durableMutation = { ...mutation, data: mergedRecord };
      pendingStore.put(durableMutation);
    };

    if (
      matchingPut &&
      !commit.replaceExisting &&
      mutation.baseVersion !== null &&
      mutation.baseVersion !== undefined &&
      mutation.patch
    ) {
      const request = tx.objectStore(matchingPut.store).get(mutationId);
      request.onsuccess = () => {
        const merged = mergeMutationRecord(
          request.result as Record<string, unknown> | undefined,
          mutation
        ) as unknown as SavableEntity;
        applyWrites(merged);
      };
      request.onerror = () => tx.abort();
    } else {
      applyWrites();
    }
    await transactionDone(tx);
    return durableMutation;
  });
}

export async function saveLocalSession(session: SessionResponse | null): Promise<void> {
  return withDb("saveLocalSession", async (db) => {
    const tx = db.transaction("meta", "readwrite");
    if (session) {
      const cached = {
        ...session,
        offlineExpiresAt: new Date(Date.now() + OFFLINE_SESSION_TTL_MS).toISOString()
      } satisfies SessionResponse;
      tx.objectStore("meta").put({ key: "session", value: cached });
    } else tx.objectStore("meta").delete("session");
    await transactionDone(tx);
  });
}

export async function saveEntity(storeName: EntityStoreName, record: SavableEntity): Promise<void> {
  return withDb("saveEntity", async (db) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    await transactionDone(tx);
  });
}

export async function purgeNextProjectData(projectId: string, ideaIds: string[]): Promise<void> {
  return withDb("purgeNextProjectData", async (db) => {
    const tx = db.transaction(["nextProjects", "nextIdeas"], "readwrite");
    tx.objectStore("nextProjects").delete(projectId);
    for (const id of ideaIds) {
      tx.objectStore("nextIdeas").delete(id);
    }
    await transactionDone(tx);
  });
}

export async function purgeNextIdeaData(ideaId: string): Promise<void> {
  return withDb("purgeNextIdeaData", async (db) => {
    const tx = db.transaction("nextIdeas", "readwrite");
    tx.objectStore("nextIdeas").delete(ideaId);
    await transactionDone(tx);
  });
}

// Hard-delete a project and its cascade (tasks) from local storage in a single
// transaction so the cache can never end up half-pruned.
export async function purgeProjectData(projectId: string, taskIds: string[]): Promise<void> {
  return withDb("purgeProjectData", async (db) => {
    const tx = db.transaction(["projects", "tasks"], "readwrite");
    tx.objectStore("projects").delete(projectId);
    for (const id of taskIds) {
      tx.objectStore("tasks").delete(id);
    }
    await transactionDone(tx);
  });
}

// Hard-delete a single task from local storage (the task-level counterpart to
// purgeProjectData).
export async function purgeTaskData(taskId: string): Promise<void> {
  return withDb("purgeTaskData", async (db) => {
    const tx = db.transaction("tasks", "readwrite");
    tx.objectStore("tasks").delete(taskId);
    await transactionDone(tx);
  });
}

export async function queueMutation(mutation: ClientMutation): Promise<void> {
  return withDb("queueMutation", async (db) => {
    const tx = db.transaction("pendingMutations", "readwrite");
    tx.objectStore("pendingMutations").put(mutation);
    await transactionDone(tx);
  });
}

export async function removePendingMutations(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  return withDb("removePendingMutations", async (db) => {
    const tx = db.transaction("pendingMutations", "readwrite");
    for (const id of ids) {
      tx.objectStore("pendingMutations").delete(id);
    }
    await transactionDone(tx);
  });
}

export async function getPendingMutations(): Promise<ClientMutation[]> {
  return getAll<ClientMutation>("pendingMutations");
}

export async function setLastSync(value: string): Promise<void> {
  await setMeta("lastSync", value);
}

export async function resetLocalData(): Promise<void> {
  return withDb("resetLocalData", async (db) => {
    const tx = db.transaction(["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"], "readwrite");
    for (const store of ["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"] as StoreName[]) {
      tx.objectStore(store).clear();
    }
    await transactionDone(tx);
  });
}
