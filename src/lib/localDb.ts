import type { BootstrapResponse, ClientMutation, NextIdea, NextProject, Project, SessionResponse, Task } from "./types";
import { sanitizeSettings } from "./sync";
import { compactPendingMutations, mergeMutationRecord, mutationData } from "./syncMerge";

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

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
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
        dbPromise = null;
      };
      resolve(db);
    };
    request.onblocked = () => {
      abandoned = true;
      dbPromise = null;
      reject(new Error("Local database upgrade is waiting for another open tab. Close the other tab and reload."));
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAll<T>(storeName: StoreName): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

async function getMeta<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key, value });
  await transactionDone(tx);
}

export async function loadLocalSnapshot(): Promise<LocalSnapshot> {
  const [projects, tasks, nextProjects, nextIdeas, pendingMutations, settings, lastSync, syncEpoch, syncCursor, session] = await Promise.all([
    getAll<Project>("projects"),
    getAll<Task>("tasks"),
    getAll<NextProject>("nextProjects"),
    getAll<NextIdea>("nextIdeas"),
    getAll<ClientMutation>("pendingMutations"),
    getMeta<Record<string, unknown>>("settings"),
    getMeta<string>("lastSync"),
    getMeta<string>("syncEpoch"),
    getMeta<number>("syncCursor"),
    getMeta<SessionResponse>("session")
  ]);

  return {
    projects,
    tasks,
    nextProjects,
    nextIdeas,
    settings: sanitizeSettings(settings ?? {}),
    pendingMutations,
    lastSync,
    syncEpoch,
    syncCursor,
    session
  };
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
  const db = await openDb();
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
}

/** Atomically persist the optimistic entity change and its durable outbox entry. */
export async function commitLocalMutation(mutation: ClientMutation, commit: LocalMutationCommit = {}): Promise<ClientMutation> {
  const db = await openDb();
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
}

export async function saveLocalSession(session: SessionResponse | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  if (session) {
    const cached = {
      ...session,
      offlineExpiresAt: new Date(Date.now() + OFFLINE_SESSION_TTL_MS).toISOString()
    } satisfies SessionResponse;
    tx.objectStore("meta").put({ key: "session", value: cached });
  } else tx.objectStore("meta").delete("session");
  await transactionDone(tx);
}

export async function saveEntity(storeName: EntityStoreName, record: SavableEntity): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(record);
  await transactionDone(tx);
}

export async function purgeNextProjectData(projectId: string, ideaIds: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["nextProjects", "nextIdeas"], "readwrite");
  tx.objectStore("nextProjects").delete(projectId);
  for (const id of ideaIds) {
    tx.objectStore("nextIdeas").delete(id);
  }
  await transactionDone(tx);
}

export async function purgeNextIdeaData(ideaId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("nextIdeas", "readwrite");
  tx.objectStore("nextIdeas").delete(ideaId);
  await transactionDone(tx);
}

// Hard-delete a project and its cascade (tasks) from local storage in a single
// transaction so the cache can never end up half-pruned.
export async function purgeProjectData(projectId: string, taskIds: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["projects", "tasks"], "readwrite");
  tx.objectStore("projects").delete(projectId);
  for (const id of taskIds) {
    tx.objectStore("tasks").delete(id);
  }
  await transactionDone(tx);
}

// Hard-delete a single task from local storage (the task-level counterpart to
// purgeProjectData).
export async function purgeTaskData(taskId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("tasks", "readwrite");
  tx.objectStore("tasks").delete(taskId);
  await transactionDone(tx);
}

export async function queueMutation(mutation: ClientMutation): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("pendingMutations", "readwrite");
  tx.objectStore("pendingMutations").put(mutation);
  await transactionDone(tx);
}

export async function removePendingMutations(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const db = await openDb();
  const tx = db.transaction("pendingMutations", "readwrite");
  for (const id of ids) {
    tx.objectStore("pendingMutations").delete(id);
  }
  await transactionDone(tx);
}

export async function getPendingMutations(): Promise<ClientMutation[]> {
  return getAll<ClientMutation>("pendingMutations");
}

export async function setLastSync(value: string): Promise<void> {
  await setMeta("lastSync", value);
}

export async function resetLocalData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"], "readwrite");
  for (const store of ["projects", "tasks", "nextProjects", "nextIdeas", "pendingMutations", "meta"] as StoreName[]) {
    tx.objectStore(store).clear();
  }
  await transactionDone(tx);
}
