import type { BootstrapResponse, ClientMutation, NextIdea, NextProject, Project, Task } from "./types";
import { sanitizeSettings } from "./sync";

const DB_NAME = "project-manager-pwa";
// v3 removes the tag stores ("tags", "taskTags") after the tag feature was cut.
const DB_VERSION = 3;
const REMOVED_STORES = ["tags", "taskTags"];

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
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

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

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
  const [projects, tasks, nextProjects, nextIdeas, pendingMutations, settings, lastSync] = await Promise.all([
    getAll<Project>("projects"),
    getAll<Task>("tasks"),
    getAll<NextProject>("nextProjects"),
    getAll<NextIdea>("nextIdeas"),
    getAll<ClientMutation>("pendingMutations"),
    getMeta<Record<string, unknown>>("settings"),
    getMeta<string>("lastSync")
  ]);

  return {
    projects,
    tasks,
    nextProjects,
    nextIdeas,
    settings: sanitizeSettings(settings ?? {}),
    pendingMutations,
    lastSync
  };
}

export async function saveBootstrapSnapshot(snapshot: BootstrapResponse): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["projects", "tasks", "nextProjects", "nextIdeas", "meta"], "readwrite");

  for (const storeName of ["projects", "tasks", "nextProjects", "nextIdeas"] as const) {
    tx.objectStore(storeName).clear();
  }
  for (const project of snapshot.projects) tx.objectStore("projects").put(project);
  for (const task of snapshot.tasks) tx.objectStore("tasks").put(task);
  for (const nextProject of snapshot.nextProjects) tx.objectStore("nextProjects").put(nextProject);
  for (const nextIdea of snapshot.nextIdeas) tx.objectStore("nextIdeas").put(nextIdea);
  tx.objectStore("meta").put({ key: "settings", value: sanitizeSettings(snapshot.settings) });
  tx.objectStore("meta").put({ key: "lastSync", value: snapshot.serverTime });

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
