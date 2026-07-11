// Pure sync helpers: pending-mutation compaction, the protected-key guards that
// keep un-synced local edits from being clobbered by a bootstrap, and the
// last-writer-wins merge between local state and a server snapshot.
//
// Everything here is side-effect free and decoupled from React, IndexedDB, and
// the network so it can be unit-tested directly (see syncMerge.test.ts). The
// imperative orchestration that calls into it lives in syncEngine.ts.
import type { BootstrapResponse, ClientMutation } from "./types";
import type { AppState } from "../state/appStore";

export const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";
export const KEEPALIVE_MAX_BYTES = 60_000;

export type MergeEntity = "project" | "task" | "next_project" | "next_idea";

export interface PendingMutationGroup {
  mutation: ClientMutation;
  sourceIds: string[];
}

export type SyncBootstrapState = Pick<AppState, "projects" | "tasks" | "nextProjects" | "nextIdeas" | "settings">;

export function mutationData(mutation: ClientMutation): Record<string, unknown> {
  return mutation.data && typeof mutation.data === "object" ? (mutation.data as Record<string, unknown>) : {};
}

export function mutationCreatedAt(mutation: ClientMutation): string {
  return String(mutation.createdAt ?? "");
}

export function mutationRecordKey(mutation: ClientMutation): string | null {
  const data = mutationData(mutation);
  if (mutation.entity === "setting") {
    const key = data.key ?? data.id;
    return key ? `${mutation.entity}:${String(key)}` : null;
  }
  const id = data.id;
  return id ? `${mutation.entity}:${String(id)}` : null;
}

const MUTATION_METADATA_FIELDS = ["id", "user_id", "created_at", "updated_at", "deleted_at", "version"] as const;

/**
 * Materialize an existing-record patch over the freshest locally durable row.
 * The mutation's user patch owns only the named fields; client metadata comes
 * from the newest optimistic record. Creates still use their full payload.
 */
export function mergeMutationRecord<T extends Record<string, unknown>>(
  existing: T | null | undefined,
  mutation: ClientMutation
): T {
  const incoming = mutationData(mutation);
  if (!existing || mutation.baseVersion === null || mutation.baseVersion === undefined || !mutation.patch) {
    return incoming as T;
  }

  const merged: Record<string, unknown> = { ...existing, ...mutation.patch };
  for (const field of MUTATION_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) merged[field] = incoming[field];
  }
  const existingVersion = Number(existing.version);
  const incomingVersion = Number(incoming.version);
  if (Number.isFinite(existingVersion) && Number.isFinite(incomingVersion)) {
    merged.version = Math.max(existingVersion, incomingVersion);
  }
  const existingUpdatedAt = String(existing.updated_at ?? "");
  const incomingUpdatedAt = String(incoming.updated_at ?? "");
  if (existingUpdatedAt > incomingUpdatedAt) merged.updated_at = existing.updated_at;
  return merged as T;
}

// Collapse every queued mutation for the same record down to its latest state,
// preserving the list of source ids so the caller can drop them all once the
// compacted mutation syncs.
export function compactPendingMutations(mutations: ClientMutation[]): PendingMutationGroup[] {
  const groups: PendingMutationGroup[] = [];
  const groupByRecord = new Map<string, PendingMutationGroup>();
  const ordered = mutations
    .map((mutation, index) => ({ mutation, index }))
    .sort(
      (left, right) =>
        mutationCreatedAt(left.mutation).localeCompare(mutationCreatedAt(right.mutation)) || left.index - right.index
    );

  for (const { mutation } of ordered) {
    const key = mutationRecordKey(mutation);
    if (!key) {
      groups.push({ mutation, sourceIds: [mutation.id] });
      continue;
    }

    const existing = groupByRecord.get(key);
    if (!existing) {
      const group = { mutation: { ...mutation, patch: mutation.patch ? { ...mutation.patch } : undefined }, sourceIds: [mutation.id] };
      groupByRecord.set(key, group);
      groups.push(group);
      continue;
    }

    existing.sourceIds.push(mutation.id);
    const firstBaseVersion = existing.mutation.baseVersion;
    const mergedPatch = {
      ...(existing.mutation.patch ?? {}),
      ...(mutation.patch ?? {})
    };
    existing.mutation = {
      ...mutation,
      // A locally-created row remains a create after later edits. Existing-row
      // edits retain the earliest version they were based on and send one
      // field-wise patch, so compaction cannot discard changes to other fields.
      baseVersion: firstBaseVersion,
      patch:
        mutation.operation === "upsert" && firstBaseVersion !== null && Object.keys(mergedPatch).length > 0
          ? mergedPatch
          : undefined
    };
  }

  return groups;
}

export function mergePendingMutations(...lists: ClientMutation[][]): ClientMutation[] {
  const byId = new Map<string, ClientMutation>();
  for (const list of lists) {
    for (const mutation of list) {
      byId.set(mutation.id, mutation);
    }
  }
  return [...byId.values()].sort((left, right) => mutationCreatedAt(left).localeCompare(mutationCreatedAt(right)));
}

export function excelDirtyAt(settings: Record<string, unknown>): string | null {
  const value = settings[EXCEL_DIRTY_SETTING_KEY];
  return typeof value === "string" && value ? value : null;
}

export function keepaliveBody(clientId: string, groups: PendingMutationGroup[]): Blob | null {
  let selected = groups.slice(0, 10);
  while (selected.length > 0) {
    const payload = JSON.stringify({
      clientId,
      flush: true,
      mutations: selected.map((group) => group.mutation)
    });
    const blob = new Blob([payload], { type: "application/json" });
    if (blob.size <= KEEPALIVE_MAX_BYTES) {
      return blob;
    }
    selected = selected.slice(Math.ceil(selected.length / 2));
  }
  return null;
}

export function pendingRecordKeys(mutations: ClientMutation[]): Set<string> {
  const keys = new Set<string>();
  for (const mutation of mutations) {
    const key = mutationRecordKey(mutation);
    if (key) {
      keys.add(key);
    }
    const data = mutationData(mutation);
    if (mutation.entity === "project" && (mutation.operation === "delete" || mutation.operation === "purge")) {
      for (const id of Array.isArray(data.taskIds) ? data.taskIds : []) keys.add(`task:${String(id)}`);
    }
    if (mutation.entity === "next_project" && (mutation.operation === "delete" || mutation.operation === "purge")) {
      for (const id of Array.isArray(data.ideaIds) ? data.ideaIds : []) keys.add(`next_idea:${String(id)}`);
    }
  }
  return keys;
}

export function pendingDeletedNextProjectIds(mutations: ClientMutation[]): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.entity === "next_project" && (mutation.operation === "delete" || mutation.operation === "purge")) {
      const id = mutationData(mutation).id;
      if (id) {
        ids.add(String(id));
      }
    }
  }
  return ids;
}

export function pendingDeletedProjectIds(mutations: ClientMutation[]): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.entity === "project" && (mutation.operation === "delete" || mutation.operation === "purge")) {
      const id = mutationData(mutation).id;
      if (id) ids.add(String(id));
    }
  }
  return ids;
}

export function entityRecordKey(entity: MergeEntity, id: string): string {
  return `${entity}:${id}`;
}

export function mergeRecordsForSync<T extends { id: string; updated_at?: string; deleted_at?: string | null }>(
  local: T[],
  incoming: T[],
  entity: MergeEntity,
  protectedKeys: Set<string>,
  replaceMode: boolean
): T[] {
  if (!replaceMode && incoming.length === 0) return local;
  if (replaceMode) {
    const records = new Map<string, T>();
    for (const record of incoming) {
      if (!record.deleted_at && !protectedKeys.has(entityRecordKey(entity, record.id))) {
        records.set(record.id, record);
      }
    }
    for (const record of local) {
      if (protectedKeys.has(entityRecordKey(entity, record.id))) {
        records.set(record.id, record);
      }
    }
    return [...records.values()];
  }

  const records = new Map(local.map((record) => [record.id, record]));
  for (const record of incoming) {
    if (protectedKeys.has(entityRecordKey(entity, record.id))) {
      continue;
    }
    if (record.deleted_at) records.delete(record.id);
    else records.set(record.id, record);
  }
  return [...records.values()];
}

export function mergeFullLiveRecordsForSync<T extends { id: string }>(
  local: T[],
  incoming: T[],
  entity: "next_project" | "next_idea",
  protectedKeys: Set<string>
): T[] {
  const records = new Map<string, T>();
  for (const record of incoming) {
    if (!protectedKeys.has(entityRecordKey(entity, record.id))) {
      records.set(record.id, record);
    }
  }
  for (const record of local) {
    if (protectedKeys.has(entityRecordKey(entity, record.id))) {
      records.set(record.id, record);
    }
  }
  return [...records.values()];
}

export function mergeSettingsForSync(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  protectedKeys: Set<string>,
  replaceMode: boolean
): Record<string, unknown> {
  if (!replaceMode && Object.keys(incoming).length === 0) return local;
  const merged: Record<string, unknown> = replaceMode ? {} : { ...local };
  for (const [key, value] of Object.entries(incoming)) {
    if (!protectedKeys.has(`setting:${key}`)) {
      merged[key] = value;
    }
  }
  if (replaceMode) {
    for (const [key, value] of Object.entries(local)) {
      if (protectedKeys.has(`setting:${key}`)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export function mergeBootstrapForLocal(
  current: SyncBootstrapState,
  snapshot: BootstrapResponse,
  pendingMutations: ClientMutation[],
  replaceMode: boolean
): BootstrapResponse {
  const protectedKeys = pendingRecordKeys(pendingMutations);
  const deletedProjects = pendingDeletedProjectIds(pendingMutations);
  const deletedNextProjects = pendingDeletedNextProjectIds(pendingMutations);
  const mergedNextIdeas = mergeRecordsForSync(current.nextIdeas, snapshot.nextIdeas, "next_idea", protectedKeys, replaceMode);
  const nextIdeas = deletedNextProjects.size > 0
    ? mergedNextIdeas.filter((idea) => !deletedNextProjects.has(idea.next_project_id))
    : mergedNextIdeas;
  const mergedTasks = mergeRecordsForSync(current.tasks, snapshot.tasks, "task", protectedKeys, replaceMode);
  const tasks = deletedProjects.size > 0
    ? mergedTasks.filter((task) => !task.project_id || !deletedProjects.has(task.project_id))
    : mergedTasks;
  return {
    serverTime: snapshot.serverTime,
    syncEpoch: snapshot.syncEpoch,
    syncCursor: snapshot.syncCursor,
    full: snapshot.full,
    projects: mergeRecordsForSync(current.projects, snapshot.projects, "project", protectedKeys, replaceMode),
    tasks,
    nextProjects: mergeRecordsForSync(current.nextProjects, snapshot.nextProjects, "next_project", protectedKeys, replaceMode),
    nextIdeas,
    settings: mergeSettingsForSync(current.settings, snapshot.settings, protectedKeys, replaceMode)
  };
}

export function stateWithBootstrap(state: AppState, snapshot: BootstrapResponse): AppState {
  return {
    ...state,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    nextProjects: snapshot.nextProjects,
    nextIdeas: snapshot.nextIdeas,
    settings: snapshot.settings,
    lastSync: snapshot.serverTime,
    syncEpoch: snapshot.syncEpoch,
    syncCursor: snapshot.syncCursor,
    syncStatus: "idle"
  };
}

export function upsertRecord<T extends { id: string }>(records: T[], record: T): T[] {
  const index = records.findIndex((item) => item.id === record.id);
  if (index < 0) {
    return [record, ...records];
  }
  const next = records.slice();
  next[index] = record;
  return next;
}

export function removeRecord<T extends { id: string }>(records: T[], id: string): T[] {
  return records.filter((item) => item.id !== id);
}

/**
 * Reapply the durable outbox over a local/cloud snapshot. Besides making cold
 * starts resilient, this lets a tab adopt optimistic writes made by another
 * tab sharing the same IndexedDB before those writes reach the server.
 */
export function replayPendingMutations(state: SyncBootstrapState, mutations: ClientMutation[]): SyncBootstrapState {
  let next: SyncBootstrapState = state;
  const deletedProjectIds = new Set<string>();
  const deletedNextProjectIds = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.operation !== "delete" && mutation.operation !== "purge") continue;
    const id = String(mutationData(mutation).id ?? "");
    if (mutation.entity === "project" && id) deletedProjectIds.add(id);
    if (mutation.entity === "next_project" && id) deletedNextProjectIds.add(id);
  }
  const ordered = mutations
    .map((mutation, index) => ({ mutation, index }))
    .sort(
      (left, right) =>
        mutationCreatedAt(left.mutation).localeCompare(mutationCreatedAt(right.mutation)) || left.index - right.index
    );

  for (const { mutation } of ordered) {
    const data = mutationData(mutation);
    const id = typeof data.id === "string" ? data.id : "";
    if (mutation.entity === "setting") {
      const key = String(data.key ?? data.id ?? "");
      if (key && mutation.operation === "upsert") next = { ...next, settings: { ...next.settings, [key]: data.value } };
      continue;
    }
    if (!id) continue;
    const deleting = mutation.operation === "delete" || mutation.operation === "purge";
    if (mutation.entity === "project") {
      const taskIds = new Set(Array.isArray(data.taskIds) ? data.taskIds.map(String) : []);
      const existing = next.projects.find((record) => record.id === id) as unknown as Record<string, unknown> | undefined;
      const record = mergeMutationRecord(existing, mutation) as unknown as AppState["projects"][number];
      next = {
        ...next,
        projects: deleting ? removeRecord(next.projects, id) : upsertRecord(next.projects, record),
        tasks: deleting ? next.tasks.filter((task) => task.project_id !== id && !taskIds.has(task.id)) : next.tasks
      };
    } else if (mutation.entity === "task") {
      const existing = next.tasks.find((record) => record.id === id) as unknown as Record<string, unknown> | undefined;
      const record = mergeMutationRecord(existing, mutation) as unknown as AppState["tasks"][number];
      next = { ...next, tasks: deleting ? removeRecord(next.tasks, id) : upsertRecord(next.tasks, record) };
    } else if (mutation.entity === "next_project") {
      const ideaIds = new Set(Array.isArray(data.ideaIds) ? data.ideaIds.map(String) : []);
      const existing = next.nextProjects.find((record) => record.id === id) as unknown as Record<string, unknown> | undefined;
      const record = mergeMutationRecord(existing, mutation) as unknown as AppState["nextProjects"][number];
      next = {
        ...next,
        nextProjects: deleting
          ? removeRecord(next.nextProjects, id)
          : upsertRecord(next.nextProjects, record),
        nextIdeas: deleting ? next.nextIdeas.filter((idea) => idea.next_project_id !== id && !ideaIds.has(idea.id)) : next.nextIdeas
      };
    } else if (mutation.entity === "next_idea") {
      const existing = next.nextIdeas.find((record) => record.id === id) as unknown as Record<string, unknown> | undefined;
      const record = mergeMutationRecord(existing, mutation) as unknown as AppState["nextIdeas"][number];
      next = {
        ...next,
        nextIdeas: deleting ? removeRecord(next.nextIdeas, id) : upsertRecord(next.nextIdeas, record)
      };
    }
  }
  return {
    ...next,
    tasks: next.tasks.filter((task) => !task.project_id || !deletedProjectIds.has(task.project_id)),
    nextIdeas: next.nextIdeas.filter((idea) => !deletedNextProjectIds.has(idea.next_project_id))
  };
}
