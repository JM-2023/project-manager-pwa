// Pure sync helpers: pending-mutation compaction, the protected-key guards that
// keep un-synced local edits from being clobbered by a bootstrap, and the
// last-writer-wins merge between local state and a server snapshot.
//
// Everything here is side-effect free and decoupled from React, IndexedDB, and
// the network so it can be unit-tested directly (see syncMerge.test.ts). The
// imperative orchestration that calls into it lives in syncEngine.ts.
import type { BootstrapResponse, ClientMutation, TaskTag } from "./types";
import type { AppState } from "../state/appStore";

export const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";
export const KEEPALIVE_MAX_BYTES = 60_000;

export type MergeEntity = "project" | "task" | "tag" | "next_project" | "next_idea";

export interface PendingMutationGroup {
  mutation: ClientMutation;
  sourceIds: string[];
}

export type SyncBootstrapState = Pick<
  AppState,
  "projects" | "tasks" | "tags" | "taskTags" | "nextProjects" | "nextIdeas" | "settings"
>;

export function mutationData(mutation: ClientMutation): Record<string, unknown> {
  return mutation.data && typeof mutation.data === "object" ? (mutation.data as Record<string, unknown>) : {};
}

export function mutationCreatedAt(mutation: ClientMutation): string {
  return String(mutation.createdAt ?? "");
}

export function mutationRecordKey(mutation: ClientMutation): string | null {
  const data = mutationData(mutation);
  if (mutation.entity === "task_tag") {
    const taskId = data.task_id ? String(data.task_id) : "";
    const tagId = data.tag_id ? String(data.tag_id) : "";
    return taskId && tagId ? `${mutation.entity}:${taskId}:${tagId}` : null;
  }
  if (mutation.entity === "setting") {
    const key = data.key ?? data.id;
    return key ? `${mutation.entity}:${String(key)}` : null;
  }
  const id = data.id;
  return id ? `${mutation.entity}:${String(id)}` : null;
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
      const group = { mutation, sourceIds: [mutation.id] };
      groupByRecord.set(key, group);
      groups.push(group);
      continue;
    }

    existing.sourceIds.push(mutation.id);
    existing.mutation = mutation;
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
  let selected = groups;
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
  }
  return keys;
}

export function pendingPurgedNextProjectIds(mutations: ClientMutation[]): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.entity === "next_project" && mutation.operation === "purge") {
      const id = mutationData(mutation).id;
      if (id) {
        ids.add(String(id));
      }
    }
  }
  return ids;
}

export function entityRecordKey(entity: MergeEntity, id: string): string {
  return `${entity}:${id}`;
}

export function mergeRecordsForSync<T extends { id: string; updated_at?: string }>(
  local: T[],
  incoming: T[],
  entity: MergeEntity,
  protectedKeys: Set<string>,
  replaceMode: boolean
): T[] {
  if (replaceMode) {
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

  const records = new Map(local.map((record) => [record.id, record]));
  for (const record of incoming) {
    if (protectedKeys.has(entityRecordKey(entity, record.id))) {
      continue;
    }
    const existing = records.get(record.id);
    if (!existing || String(record.updated_at ?? "") >= String(existing.updated_at ?? "")) {
      records.set(record.id, record);
    }
  }
  return [...records.values()];
}

export function mergeTaskTagsForSync(local: TaskTag[], incoming: TaskTag[], protectedKeys: Set<string>, replaceMode: boolean): TaskTag[] {
  const keyFor = (tag: TaskTag) => `task_tag:${tag.task_id}:${tag.tag_id}`;
  const records = new Map<string, TaskTag>();

  if (!replaceMode) {
    for (const tag of local) {
      records.set(keyFor(tag), tag);
    }
  }

  for (const tag of incoming) {
    const key = keyFor(tag);
    if (!protectedKeys.has(key)) {
      records.set(key, tag);
    }
  }

  if (replaceMode) {
    for (const tag of local) {
      const key = keyFor(tag);
      if (protectedKeys.has(key)) {
        records.set(key, tag);
      }
    }
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
  const purgedNextProjects = pendingPurgedNextProjectIds(pendingMutations);
  const nextIdeas = mergeFullLiveRecordsForSync(current.nextIdeas, snapshot.nextIdeas, "next_idea", protectedKeys).filter(
    (idea) => !purgedNextProjects.has(idea.next_project_id)
  );
  return {
    serverTime: snapshot.serverTime,
    projects: mergeRecordsForSync(current.projects, snapshot.projects, "project", protectedKeys, replaceMode),
    tasks: mergeRecordsForSync(current.tasks, snapshot.tasks, "task", protectedKeys, replaceMode),
    tags: mergeRecordsForSync(current.tags, snapshot.tags, "tag", protectedKeys, replaceMode),
    taskTags: mergeTaskTagsForSync(current.taskTags, snapshot.taskTags, protectedKeys, replaceMode),
    nextProjects: mergeFullLiveRecordsForSync(current.nextProjects, snapshot.nextProjects, "next_project", protectedKeys),
    nextIdeas,
    settings: mergeSettingsForSync(current.settings, snapshot.settings, protectedKeys, replaceMode)
  };
}

export function stateWithBootstrap(state: AppState, snapshot: BootstrapResponse): AppState {
  return {
    ...state,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    tags: snapshot.tags,
    taskTags: snapshot.taskTags,
    nextProjects: snapshot.nextProjects,
    nextIdeas: snapshot.nextIdeas,
    settings: snapshot.settings,
    lastSync: snapshot.serverTime,
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

export function taskTagKey(tag: TaskTag): string {
  return `${tag.task_id}:${tag.tag_id}`;
}

export function upsertTaskTagRecord(records: TaskTag[], record: TaskTag): TaskTag[] {
  const key = taskTagKey(record);
  const index = records.findIndex((item) => taskTagKey(item) === key);
  if (index < 0) {
    return [...records, record];
  }
  const next = records.slice();
  next[index] = record;
  return next;
}
