import { authenticate, isResponse } from "./_utils/auth";
import {
  advanceSyncSequenceStatement,
  ensureSyncStateStatement,
  INTERNAL_SETTING_KEYS,
  SYNC_SEQUENCE_SQL
} from "./_utils/db";
import { apiError, json, readJson, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext, AuthUser } from "./_utils/types";
import {
  asIntFlag,
  assertUuidish,
  normalizeDate,
  normalizePriority,
  normalizeStatus,
  nullableText,
  safeJsonString
} from "./_utils/validation";

type Entity = "project" | "task" | "setting" | "next_project" | "next_idea";
type Operation = "upsert" | "delete" | "purge";

export interface IncomingMutation {
  id: string;
  entity: Entity;
  operation: Operation;
  baseVersion?: number | null;
  data: Record<string, unknown>;
  /** Only these fields are changed when updating an existing row. */
  patch?: Record<string, unknown>;
}

interface MutationBody {
  clientId?: string;
  mutations?: IncomingMutation[];
}

interface Applied {
  id: string;
  entity: Entity;
  recordId: string;
  version?: number;
  updated_at?: string;
  rebased?: boolean;
  serverVersion?: number;
}

interface Conflict {
  id: string;
  entity: Entity;
  recordId?: string;
  reason: string;
  permanent?: boolean;
  serverRecord?: unknown;
}

interface MutationPlan {
  result: Applied | Conflict;
  statements: D1PreparedStatement[];
  ledgerMode?: "row" | "always";
}

interface PlannedCommit {
  mutation: IncomingMutation;
  result: Applied;
  statements: D1PreparedStatement[];
  timestamp: string;
  ledgerMode: "row" | "always";
  ledgerIndex?: number;
}

interface PlanningHints {
  existingKnown?: boolean;
  existing?: Record<string, unknown> | null;
  plannedProjectIds?: ReadonlySet<string>;
  knownProjectIds?: ReadonlySet<string>;
  plannedTaskIds?: ReadonlySet<string>;
  knownTaskIds?: ReadonlySet<string>;
  plannedNextProjectIds?: ReadonlySet<string>;
  knownNextProjectIds?: ReadonlySet<string>;
}

interface FieldSpec {
  column: string;
  normalize: (value: unknown) => unknown;
}

const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";
const CLIENT_READ_ONLY_SETTING_KEYS = new Set([...INTERNAL_SETTING_KEYS, EXCEL_DIRTY_SETTING_KEY]);
const MAX_MUTATIONS = 10;

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const titleValue = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const PROJECT_FIELDS: Record<string, FieldSpec> = {
  name: { column: "name", normalize: (value) => nullableText(value) ?? "Untitled project" },
  description: { column: "description", normalize: nullableText },
  color: { column: "color", normalize: nullableText },
  sort_order: { column: "sort_order", normalize: numberValue },
  archived: { column: "archived", normalize: asIntFlag }
};

const TASK_FIELDS: Record<string, FieldSpec> = {
  project_id: { column: "project_id", normalize: nullableText },
  title: { column: "title", normalize: titleValue },
  description: { column: "description", normalize: nullableText },
  status: { column: "status", normalize: normalizeStatus },
  priority: { column: "priority", normalize: normalizePriority },
  due_date: { column: "due_date", normalize: normalizeDate },
  start_date: { column: "start_date", normalize: normalizeDate },
  completed_at: { column: "completed_at", normalize: nullableText },
  next_action: { column: "next_action", normalize: nullableText },
  notes: { column: "notes", normalize: nullableText },
  sort_order: { column: "sort_order", normalize: numberValue },
  parent_task_id: { column: "parent_task_id", normalize: nullableText },
  source: { column: "source", normalize: (value) => nullableText(value) ?? "app" },
  external_key: { column: "external_key", normalize: nullableText },
  extra_json: { column: "extra_json", normalize: safeJsonString },
  archived: { column: "archived", normalize: asIntFlag }
};

const NEXT_PROJECT_FIELDS: Record<string, FieldSpec> = {
  name: { column: "name", normalize: (value) => nullableText(value) ?? "New idea group" },
  description: { column: "description", normalize: nullableText },
  color: { column: "color", normalize: nullableText },
  sort_order: { column: "sort_order", normalize: numberValue },
  archived: { column: "archived", normalize: asIntFlag }
};

const NEXT_IDEA_FIELDS: Record<string, FieldSpec> = {
  next_project_id: { column: "next_project_id", normalize: (value) => String(value ?? "") },
  title: { column: "title", normalize: titleValue },
  note: { column: "note", normalize: nullableText },
  sort_order: { column: "sort_order", normalize: numberValue },
  extra_json: { column: "extra_json", normalize: safeJsonString }
};

function excelAutosyncEnabled(context: AppContext): boolean {
  return (context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS)) || context.env.ENABLE_D1_EXCEL_STATE === "true";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mutationPatch(mutation: IncomingMutation): Record<string, unknown> {
  return mutation.patch && typeof mutation.patch === "object" && !Array.isArray(mutation.patch)
    ? mutation.patch
    : mutation.data;
}

function appliedResult(mutation: IncomingMutation, recordId: string, existing?: Record<string, unknown> | null): Applied {
  const serverVersion = existing ? Number(existing.version ?? 0) : undefined;
  const hasBase = mutation.baseVersion !== null && mutation.baseVersion !== undefined;
  return {
    id: mutation.id,
    entity: mutation.entity,
    recordId,
    ...(hasBase ? { rebased: serverVersion === undefined || mutation.baseVersion !== serverVersion, serverVersion } : {})
  };
}

function conflict(mutation: IncomingMutation, reason: string, permanent = true, serverRecord?: unknown): MutationPlan {
  return {
    result: {
      id: mutation.id,
      entity: mutation.entity,
      recordId: String(mutation.data?.id ?? ""),
      reason,
      permanent,
      ...(serverRecord === undefined ? {} : { serverRecord })
    },
    statements: []
  };
}

function recordProcessed(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  timestamp: string,
  mode: "row" | "always"
): D1PreparedStatement {
  if (mode === "always" || mutation.operation === "purge") {
    return context.env.DB.prepare(
      "INSERT INTO processed_mutations (id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(mutation.id, user.id, timestamp);
  }

  if (mutation.entity === "setting") {
    const key = String(mutation.data.key ?? mutation.data.id ?? "").trim();
    return context.env.DB.prepare(
      `INSERT INTO processed_mutations (id, user_id, created_at)
       SELECT ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM app_settings
         WHERE user_id = ? AND key = ? AND sync_seq = ${SYNC_SEQUENCE_SQL} AND updated_at = ?
       )
       ON CONFLICT(id) DO NOTHING`
    ).bind(mutation.id, user.id, timestamp, user.id, key, user.id, timestamp);
  }

  const table = {
    project: "projects",
    task: "tasks",
    next_project: "next_projects",
    next_idea: "next_ideas"
  }[mutation.entity];
  const id = String(mutation.data.id ?? "").trim();
  return context.env.DB.prepare(
    `INSERT INTO processed_mutations (id, user_id, created_at)
     SELECT ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM ${table}
       WHERE user_id = ? AND id = ? AND sync_seq = ${SYNC_SEQUENCE_SQL} AND updated_at = ?
     )
     ON CONFLICT(id) DO NOTHING`
  ).bind(mutation.id, user.id, timestamp, user.id, id, user.id, timestamp);
}

function guardedUpdate(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  table: string,
  id: string,
  specs: Record<string, FieldSpec>,
  timestamp: string,
  expectedVersion: number,
  extraWhere = "",
  extraArgs: unknown[] = []
): D1PreparedStatement {
  const patch = mutationPatch(mutation);
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, spec] of Object.entries(specs)) {
    if (!hasOwn(patch, field)) continue;
    assignments.push(`${spec.column} = ?`);
    values.push(spec.normalize(patch[field]));
  }
  assignments.push("updated_at = ?", "version = version + 1", `sync_seq = ${SYNC_SEQUENCE_SQL}`);
  values.push(timestamp, user.id);

  return context.env.DB.prepare(
    `UPDATE ${table}
     SET ${assignments.join(", ")}
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND version = ?
       ${extraWhere ? `AND (${extraWhere})` : ""}
       AND NOT EXISTS (SELECT 1 FROM processed_mutations WHERE id = ?)`
  ).bind(...values, user.id, id, expectedVersion, ...extraArgs, mutation.id);
}

function guardedInsert(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  table: string,
  columns: string[],
  values: unknown[],
  updateColumns: string[],
  insertCondition = "",
  insertConditionArgs: unknown[] = [],
  conflictCondition = ""
): D1PreparedStatement {
  const placeholders = values.map(() => "?").join(", ");
  return context.env.DB.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}, sync_seq)
     SELECT ${placeholders}, ${SYNC_SEQUENCE_SQL}
     WHERE NOT EXISTS (SELECT 1 FROM processed_mutations WHERE id = ?)
       ${insertCondition ? `AND (${insertCondition})` : ""}
     ON CONFLICT(id) DO UPDATE SET
       ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")},
       updated_at = excluded.updated_at,
       version = excluded.version,
       sync_seq = excluded.sync_seq
     WHERE ${table}.user_id = excluded.user_id
       AND ${table}.deleted_at IS NULL
       AND excluded.version > ${table}.version
       ${conflictCondition ? `AND (${conflictCondition})` : ""}`
  ).bind(...values, user.id, mutation.id, ...insertConditionArgs);
}

function markExcelDirtyStatement(context: AppContext, user: AuthUser, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ${SYNC_SEQUENCE_SQL})
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq`
  ).bind(user.id, EXCEL_DIRTY_SETTING_KEY, JSON.stringify(timestamp), timestamp, user.id);
}

async function findExisting(context: AppContext, user: AuthUser, mutation: IncomingMutation): Promise<Record<string, unknown> | null> {
  const id = String(mutation.data.id ?? "").trim();
  const table = {
    project: "projects",
    task: "tasks",
    next_project: "next_projects",
    next_idea: "next_ideas",
    setting: "app_settings"
  }[mutation.entity];
  if (mutation.entity === "setting") {
    const key = String(mutation.data.key ?? mutation.data.id ?? "");
    return context.env.DB.prepare("SELECT * FROM app_settings WHERE user_id = ? AND key = ?")
      .bind(user.id, key)
      .first<Record<string, unknown>>();
  }
  return context.env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND id = ?`)
    .bind(user.id, id)
    .first<Record<string, unknown>>();
}

function missingOrDeletedUpdate(mutation: IncomingMutation, existing: Record<string, unknown> | null): MutationPlan | null {
  if (!existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined) {
    return conflict(mutation, "Record no longer exists", true, null);
  }
  if (existing?.deleted_at) {
    return conflict(mutation, "Record was deleted", true, existing);
  }
  if (existing && (mutation.baseVersion === null || mutation.baseVersion === undefined)) {
    const incomingVersion = Number(mutation.data.version);
    const serverVersion = Number(existing.version ?? 0);
    if (!Number.isSafeInteger(incomingVersion) || incomingVersion <= serverVersion) {
      return conflict(mutation, "Record already exists", true, existing);
    }
  }
  if (
    existing &&
    mutation.baseVersion !== null &&
    mutation.baseVersion !== undefined &&
    Number(existing.version ?? 0) !== mutation.baseVersion
  ) {
    // Pre-patch clients cannot safely rebase a whole-record payload. Let them
    // drain and restore the authoritative row instead of retrying forever.
    return conflict(mutation, "Version conflict", !mutation.patch, existing);
  }
  return null;
}

function createVersion(data: Record<string, unknown>): number {
  const version = Number(data.version);
  return Number.isSafeInteger(version) && version >= 1 ? version : 1;
}

function planProject(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): MutationPlan {
  const blocked = missingOrDeletedUpdate(mutation, existing);
  if (blocked) return blocked;
  const data = { ...mutation.data, ...(mutation.patch ?? {}) };
  const id = assertUuidish(data.id);
  if (existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined) {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [guardedUpdate(context, user, mutation, "projects", id, PROJECT_FIELDS, timestamp, Number(existing.version ?? 0))]
    };
  }
  const createdAt = String(data.created_at ?? timestamp);
  const values = [
    id, user.id, PROJECT_FIELDS.name.normalize(data.name), PROJECT_FIELDS.description.normalize(data.description),
    PROJECT_FIELDS.color.normalize(data.color), PROJECT_FIELDS.sort_order.normalize(data.sort_order),
    PROJECT_FIELDS.archived.normalize(data.archived), createdAt, timestamp, null, createVersion(data)
  ];
  return {
    result: appliedResult(mutation, id),
    statements: [guardedInsert(context, user, mutation, "projects",
      ["id", "user_id", "name", "description", "color", "sort_order", "archived", "created_at", "updated_at", "deleted_at", "version"],
      values, ["name", "description", "color", "sort_order", "archived"])]
  };
}

async function projectExists(context: AppContext, user: AuthUser, projectId: string): Promise<boolean> {
  const parent = await context.env.DB.prepare(
    "SELECT id FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL"
  ).bind(user.id, projectId).first<{ id: string }>();
  return Boolean(parent);
}

async function taskExists(context: AppContext, user: AuthUser, taskId: string): Promise<boolean> {
  const parent = await context.env.DB.prepare(
    "SELECT id FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL"
  ).bind(user.id, taskId).first<{ id: string }>();
  return Boolean(parent);
}

async function planTask(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string,
  plannedProjectIds: ReadonlySet<string>,
  knownProjectIds?: ReadonlySet<string>,
  plannedTaskIds: ReadonlySet<string> = new Set(),
  knownTaskIds?: ReadonlySet<string>
): Promise<MutationPlan> {
  const blocked = missingOrDeletedUpdate(mutation, existing);
  if (blocked) return blocked;
  const data = { ...mutation.data, ...(mutation.patch ?? {}) };
  const id = assertUuidish(data.id);
  const usesPatch = Boolean(existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined && mutation.patch);
  const projectRelationFromServer = usesPatch && !hasOwn(mutation.patch!, "project_id");
  const rawProjectId = projectRelationFromServer
    ? existing?.project_id
    : hasOwn(data, "project_id")
      ? data.project_id
      : existing?.project_id;
  const projectId = rawProjectId === null || rawProjectId === undefined || rawProjectId === ""
    ? null
    : typeof rawProjectId === "string"
      ? rawProjectId.trim()
      : "";
  if (projectId !== null) {
    if (!projectId || projectId.length > 128) return conflict(mutation, "Task project_id is invalid");
    const parentKnown = plannedProjectIds.has(projectId) || knownProjectIds?.has(projectId);
    if (!parentKnown && !projectRelationFromServer && (knownProjectIds !== undefined || !(await projectExists(context, user, projectId)))) {
      return conflict(mutation, "Project not found");
    }
  }
  const taskRelationFromServer = usesPatch && !hasOwn(mutation.patch!, "parent_task_id");
  const rawParentTaskId = taskRelationFromServer
    ? existing?.parent_task_id
    : hasOwn(data, "parent_task_id")
      ? data.parent_task_id
      : existing?.parent_task_id;
  const parentTaskId = rawParentTaskId === null || rawParentTaskId === undefined || rawParentTaskId === ""
    ? null
    : typeof rawParentTaskId === "string"
      ? rawParentTaskId.trim()
      : "";
  if (parentTaskId !== null) {
    if (!parentTaskId || parentTaskId.length > 128) return conflict(mutation, "Task parent_task_id is invalid");
    if (parentTaskId === id) return conflict(mutation, "Task cannot be its own parent");
    const parentKnown = plannedTaskIds.has(parentTaskId) || knownTaskIds?.has(parentTaskId);
    if (!parentKnown && !taskRelationFromServer && (knownTaskIds !== undefined || !(await taskExists(context, user, parentTaskId)))) {
      return conflict(mutation, "Parent task not found");
    }
  }
  const relationGuards: string[] = [];
  const relationArgs: unknown[] = [];
  if (projectId) {
    relationGuards.push("EXISTS (SELECT 1 FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL)");
    relationArgs.push(user.id, projectId);
  }
  if (parentTaskId) {
    relationGuards.push("EXISTS (SELECT 1 FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL)");
    relationArgs.push(user.id, parentTaskId);
    relationGuards.push(`NOT EXISTS (
      WITH RECURSIVE ancestors(id) AS (
        SELECT ?
        UNION
        SELECT parent.parent_task_id
        FROM tasks AS parent
        JOIN ancestors ON parent.id = ancestors.id
        WHERE parent.user_id = ?
          AND parent.deleted_at IS NULL
          AND parent.parent_task_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE id = ?
    )`);
    relationArgs.push(parentTaskId, user.id, id);
  }
  if (existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined) {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [guardedUpdate(
        context,
        user,
        mutation,
        "tasks",
        id,
        TASK_FIELDS,
        timestamp,
        Number(existing.version ?? 0),
        relationGuards.join(" AND "),
        relationArgs
      )]
    };
  }
  const createdAt = String(data.created_at ?? timestamp);
  const values = [
    id, user.id, projectId, TASK_FIELDS.title.normalize(data.title),
    TASK_FIELDS.description.normalize(data.description), TASK_FIELDS.status.normalize(data.status),
    TASK_FIELDS.priority.normalize(data.priority), TASK_FIELDS.due_date.normalize(data.due_date),
    TASK_FIELDS.start_date.normalize(data.start_date), TASK_FIELDS.completed_at.normalize(data.completed_at),
    TASK_FIELDS.next_action.normalize(data.next_action), TASK_FIELDS.notes.normalize(data.notes),
    TASK_FIELDS.sort_order.normalize(data.sort_order), parentTaskId,
    TASK_FIELDS.source.normalize(data.source), TASK_FIELDS.external_key.normalize(data.external_key),
    TASK_FIELDS.extra_json.normalize(data.extra_json), TASK_FIELDS.archived.normalize(data.archived),
    createdAt, timestamp, null, createVersion(data)
  ];
  const columns = [
    "id", "user_id", "project_id", "title", "description", "status", "priority", "due_date", "start_date",
    "completed_at", "next_action", "notes", "sort_order", "parent_task_id", "source", "external_key", "extra_json",
    "archived", "created_at", "updated_at", "deleted_at", "version"
  ];
  return {
    result: appliedResult(mutation, id),
    statements: [guardedInsert(
      context,
      user,
      mutation,
      "tasks",
      columns,
      values,
      Object.values(TASK_FIELDS).map((spec) => spec.column),
      relationGuards.join(" AND "),
      relationArgs,
      `(excluded.project_id IS NULL OR EXISTS (
         SELECT 1 FROM projects
         WHERE user_id = excluded.user_id AND id = excluded.project_id AND deleted_at IS NULL
       )) AND (excluded.parent_task_id IS NULL OR (
         excluded.parent_task_id <> excluded.id AND EXISTS (
           SELECT 1 FROM tasks
           WHERE user_id = excluded.user_id AND id = excluded.parent_task_id AND deleted_at IS NULL
         ) AND NOT EXISTS (
           WITH RECURSIVE ancestors(id) AS (
             SELECT excluded.parent_task_id
             UNION
             SELECT parent.parent_task_id
             FROM tasks AS parent
             JOIN ancestors ON parent.id = ancestors.id
             WHERE parent.user_id = excluded.user_id
               AND parent.deleted_at IS NULL
               AND parent.parent_task_id IS NOT NULL
           )
           SELECT 1 FROM ancestors WHERE id = excluded.id
         )
       ))`
    )]
  };
}

function planNextProject(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): MutationPlan {
  const blocked = missingOrDeletedUpdate(mutation, existing);
  if (blocked) return blocked;
  const data = { ...mutation.data, ...(mutation.patch ?? {}) };
  const id = assertUuidish(data.id);
  if (existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined) {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [guardedUpdate(context, user, mutation, "next_projects", id, NEXT_PROJECT_FIELDS, timestamp, Number(existing.version ?? 0))]
    };
  }
  const createdAt = String(data.created_at ?? timestamp);
  const values = [
    id, user.id, NEXT_PROJECT_FIELDS.name.normalize(data.name), NEXT_PROJECT_FIELDS.description.normalize(data.description),
    NEXT_PROJECT_FIELDS.color.normalize(data.color), NEXT_PROJECT_FIELDS.sort_order.normalize(data.sort_order), null,
    NEXT_PROJECT_FIELDS.archived.normalize(data.archived), createdAt, timestamp, null, createVersion(data)
  ];
  return {
    result: appliedResult(mutation, id),
    statements: [guardedInsert(context, user, mutation, "next_projects",
      ["id", "user_id", "name", "description", "color", "sort_order", "source_project_id", "archived", "created_at", "updated_at", "deleted_at", "version"],
      values, Object.values(NEXT_PROJECT_FIELDS).map((spec) => spec.column))]
  };
}

async function nextProjectExists(context: AppContext, user: AuthUser, nextProjectId: string): Promise<boolean> {
  const parent = await context.env.DB.prepare(
    "SELECT id FROM next_projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL"
  ).bind(user.id, nextProjectId).first<{ id: string }>();
  return Boolean(parent);
}

async function planNextIdea(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string,
  plannedNextProjectIds: ReadonlySet<string>,
  knownNextProjectIds?: ReadonlySet<string>
): Promise<MutationPlan> {
  const blocked = missingOrDeletedUpdate(mutation, existing);
  if (blocked) return blocked;
  const data = { ...mutation.data, ...(mutation.patch ?? {}) };
  const id = assertUuidish(data.id);
  const usesPatch = Boolean(existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined && mutation.patch);
  const projectRelationFromServer = usesPatch && !hasOwn(mutation.patch!, "next_project_id");
  const rawNextProjectId = projectRelationFromServer
    ? existing?.next_project_id
    : hasOwn(data, "next_project_id")
      ? data.next_project_id
      : existing?.next_project_id;
  const nextProjectId = typeof rawNextProjectId === "string" ? rawNextProjectId.trim() : "";
  if (!nextProjectId || nextProjectId.length > 128) return conflict(mutation, "Next idea requires next_project_id");
  const parentKnown = plannedNextProjectIds.has(nextProjectId) || knownNextProjectIds?.has(nextProjectId);
  if (!parentKnown && !projectRelationFromServer && (knownNextProjectIds !== undefined || !(await nextProjectExists(context, user, nextProjectId)))) {
    return conflict(mutation, "Next project not found");
  }
  if (existing && mutation.baseVersion !== null && mutation.baseVersion !== undefined) {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [guardedUpdate(
        context,
        user,
        mutation,
        "next_ideas",
        id,
        NEXT_IDEA_FIELDS,
        timestamp,
        Number(existing.version ?? 0),
        "EXISTS (SELECT 1 FROM next_projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL)",
        [user.id, nextProjectId]
      )]
    };
  }
  const createdAt = String(data.created_at ?? timestamp);
  const values = [
    id, user.id, nextProjectId, NEXT_IDEA_FIELDS.title.normalize(data.title), NEXT_IDEA_FIELDS.note.normalize(data.note),
    NEXT_IDEA_FIELDS.sort_order.normalize(data.sort_order), null, NEXT_IDEA_FIELDS.extra_json.normalize(data.extra_json),
    createdAt, timestamp, null, createVersion(data)
  ];
  return {
    result: appliedResult(mutation, id),
    statements: [guardedInsert(
      context,
      user,
      mutation,
      "next_ideas",
      ["id", "user_id", "next_project_id", "title", "note", "sort_order", "source_task_id", "extra_json", "created_at", "updated_at", "deleted_at", "version"],
      values,
      Object.values(NEXT_IDEA_FIELDS).map((spec) => spec.column),
      "EXISTS (SELECT 1 FROM next_projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL)",
      [user.id, nextProjectId],
      "EXISTS (SELECT 1 FROM next_projects WHERE user_id = excluded.user_id AND id = excluded.next_project_id AND deleted_at IS NULL)"
    )]
  };
}

function planSetting(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): MutationPlan {
  const key = String(mutation.data.key ?? mutation.data.id ?? "").trim();
  const patch = mutationPatch(mutation);
  const value = mutation.operation === "delete" ? null : (hasOwn(patch, "value") ? patch.value : mutation.data.value);
  const statement = context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at, sync_seq)
     SELECT ?, ?, ?, ?, ${SYNC_SEQUENCE_SQL}
     WHERE NOT EXISTS (SELECT 1 FROM processed_mutations WHERE id = ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq`
  ).bind(user.id, key, JSON.stringify(value ?? null), timestamp, user.id, mutation.id);
  return { result: appliedResult(mutation, key), statements: [statement] };
}

function guardSql(): string {
  return "NOT EXISTS (SELECT 1 FROM processed_mutations WHERE id = ?)";
}

/** Soft-delete a row and, for parent entities, its children in the same batch. */
function planDelete(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): MutationPlan {
  const id = String(mutation.data.id ?? "").trim();
  if (mutation.entity === "setting") return planSetting(context, user, mutation, timestamp);
  if (!existing || existing.deleted_at) {
    return { result: appliedResult(mutation, id, existing), statements: [], ledgerMode: "always" };
  }
  const serverVersion = Number(existing.version ?? 0);
  if (
    mutation.baseVersion !== null &&
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== serverVersion
  ) {
    return conflict(mutation, "Record changed before deletion", true, existing);
  }

  const rootTombstone = (table: string, archived: boolean): D1PreparedStatement => context.env.DB.prepare(
    `UPDATE ${table}
     SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?, version = version + 1,
         ${archived ? "archived = 1," : ""} sync_seq = ${SYNC_SEQUENCE_SQL}
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL AND version = ? AND ${guardSql()}`
  ).bind(timestamp, timestamp, user.id, user.id, id, serverVersion, mutation.id);
  const childTombstone = (
    table: "tasks" | "next_ideas",
    foreignKey: "project_id" | "next_project_id",
    rootTable: "projects" | "next_projects"
  ): D1PreparedStatement => {
    const archiveAssignment = table === "tasks" ? "archived = 1," : "";
    return context.env.DB.prepare(
      `UPDATE ${table}
       SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?, version = version + 1,
           ${archiveAssignment} sync_seq = ${SYNC_SEQUENCE_SQL}
       WHERE user_id = ? AND ${foreignKey} = ? AND ${guardSql()}
         AND EXISTS (
           SELECT 1 FROM ${rootTable}
           WHERE user_id = ? AND id = ? AND sync_seq = ${SYNC_SEQUENCE_SQL} AND updated_at = ?
         )`
    ).bind(timestamp, timestamp, user.id, user.id, id, mutation.id, user.id, id, user.id, timestamp);
  };

  if (mutation.entity === "project") {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [rootTombstone("projects", true), childTombstone("tasks", "project_id", "projects")]
    };
  }
  if (mutation.entity === "task") {
    return { result: appliedResult(mutation, id, existing), statements: [rootTombstone("tasks", true)] };
  }
  if (mutation.entity === "next_project") {
    return {
      result: appliedResult(mutation, id, existing),
      statements: [rootTombstone("next_projects", true), childTombstone("next_ideas", "next_project_id", "next_projects")]
    };
  }
  return { result: appliedResult(mutation, id, existing), statements: [rootTombstone("next_ideas", false)] };
}

/** Compatibility path for old clients. Any hard delete rotates the epoch. */
function planPurge(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): MutationPlan {
  const id = String(mutation.data.id ?? "").trim();
  const guardedDelete = (table: string, idColumn = "id"): D1PreparedStatement => context.env.DB.prepare(
    `DELETE FROM ${table} WHERE user_id = ? AND ${idColumn} = ? AND ${guardSql()}`
  ).bind(user.id, id, mutation.id);

  if (mutation.entity === "project") {
    const detachMigrationSource = context.env.DB.prepare(
      `UPDATE next_projects
       SET source_project_id = NULL, updated_at = ?, version = version + 1, sync_seq = ${SYNC_SEQUENCE_SQL}
       WHERE user_id = ? AND source_project_id = ? AND ${guardSql()}`
    ).bind(timestamp, user.id, user.id, id, mutation.id);
    return {
      result: appliedResult(mutation, id),
      statements: [detachMigrationSource, guardedDelete("tasks", "project_id"), guardedDelete("projects")],
      ledgerMode: "always"
    };
  }
  if (mutation.entity === "task") {
    return { result: appliedResult(mutation, id), statements: [guardedDelete("tasks")], ledgerMode: "always" };
  }
  if (mutation.entity === "next_project") {
    return {
      result: appliedResult(mutation, id),
      statements: [guardedDelete("next_ideas", "next_project_id"), guardedDelete("next_projects")],
      ledgerMode: "always"
    };
  }
  if (mutation.entity === "next_idea") {
    return { result: appliedResult(mutation, id), statements: [guardedDelete("next_ideas")], ledgerMode: "always" };
  }
  return planSetting(context, user, { ...mutation, operation: "delete" }, timestamp);
}

export async function planMutation(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  timestamp: string,
  hints: PlanningHints = {}
): Promise<MutationPlan> {
  if (
    !["project", "task", "setting", "next_project", "next_idea"].includes(mutation.entity) ||
    !["upsert", "delete", "purge"].includes(mutation.operation)
  ) return conflict(mutation, "Unsupported mutation");
  if (typeof mutation.id !== "string" || !mutation.id.trim() || mutation.id.length > 200) {
    return conflict(mutation, "Mutation id is required");
  }
  if (!mutation.data || typeof mutation.data !== "object" || Array.isArray(mutation.data)) return conflict(mutation, "Mutation data is required");
  if (mutation.patch !== undefined && (typeof mutation.patch !== "object" || mutation.patch === null || Array.isArray(mutation.patch))) {
    return conflict(mutation, "Mutation patch must be an object");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    (!Number.isSafeInteger(mutation.baseVersion) || mutation.baseVersion < 0)
  ) return conflict(mutation, "Base version is invalid");
  const suppliedRecordId = typeof mutation.data.id === "string" ? mutation.data.id.trim() : "";
  if (mutation.entity !== "setting" && (!suppliedRecordId || suppliedRecordId.length > 128)) {
    return conflict(mutation, "Record id is required");
  }
  if (mutation.entity === "setting" && !mutation.data.key && !mutation.data.id) return conflict(mutation, "Setting key is required");
  const rawSettingKey = mutation.data.key ?? mutation.data.id;
  const settingKey = typeof rawSettingKey === "string" ? rawSettingKey.trim() : "";
  if (mutation.entity === "setting" && (!settingKey || settingKey.length > 128)) return conflict(mutation, "Setting key is invalid");
  if (
    mutation.entity === "setting" &&
    [mutation.data.key, mutation.data.id].some((value) => CLIENT_READ_ONLY_SETTING_KEYS.has(String(value ?? "").trim()))
  ) return conflict(mutation, "Reserved setting key");

  if (mutation.operation === "purge") return planPurge(context, user, mutation, timestamp);
  if (mutation.entity === "setting") return planSetting(context, user, mutation, timestamp);

  const existing = hints.existingKnown ? (hints.existing ?? null) : await findExisting(context, user, mutation);
  if (mutation.operation === "delete") return planDelete(context, user, mutation, existing, timestamp);
  if (mutation.entity === "project") return planProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task") {
    return planTask(
      context,
      user,
      mutation,
      existing,
      timestamp,
      hints.plannedProjectIds ?? new Set(),
      hints.knownProjectIds,
      hints.plannedTaskIds ?? new Set(),
      hints.knownTaskIds
    );
  }
  if (mutation.entity === "next_project") return planNextProject(context, user, mutation, existing, timestamp);
  return planNextIdea(
    context,
    user,
    mutation,
    existing,
    timestamp,
    hints.plannedNextProjectIds ?? new Set(),
    hints.knownNextProjectIds
  );
}

function isConflict(result: Applied | Conflict): result is Conflict {
  return "reason" in result;
}

async function findProcessedIds(context: AppContext, user: AuthUser, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Set();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await context.env.DB.prepare(
    `SELECT id FROM processed_mutations WHERE user_id = ? AND id IN (${placeholders})`
  ).bind(user.id, ...unique).all<{ id: string }>();
  return new Set(result.results.map((row) => row.id));
}

function existingKey(entity: Entity, id: string): string {
  return `${entity}:${id}`;
}

async function loadPlanningRows(
  context: AppContext,
  user: AuthUser,
  mutations: IncomingMutation[]
): Promise<{
  existing: Map<string, Record<string, unknown>>;
  liveProjectIds: Set<string>;
  liveTaskIds: Set<string>;
  liveNextProjectIds: Set<string>;
}> {
  const ids = new Map<Entity, Set<string>>([
    ["project", new Set()],
    ["task", new Set()],
    ["next_project", new Set()],
    ["next_idea", new Set()]
  ]);
  for (const mutation of mutations) {
    if ((mutation.operation !== "upsert" && mutation.operation !== "delete") || mutation.entity === "setting") continue;
    const id = String(mutation.data.id ?? "").trim();
    if (id) ids.get(mutation.entity)?.add(id);
    if (mutation.entity === "task") {
      const parentId = String(mutation.patch?.project_id ?? mutation.data.project_id ?? "").trim();
      if (parentId) ids.get("project")?.add(parentId);
      const rawParentTaskId = mutation.patch && hasOwn(mutation.patch, "parent_task_id")
        ? mutation.patch.parent_task_id
        : mutation.data.parent_task_id;
      const parentTaskId = typeof rawParentTaskId === "string" ? rawParentTaskId.trim() : "";
      if (parentTaskId) ids.get("task")?.add(parentTaskId);
    }
    if (mutation.entity === "next_idea") {
      const parentId = String(mutation.patch?.next_project_id ?? mutation.data.next_project_id ?? "").trim();
      if (parentId) ids.get("next_project")?.add(parentId);
    }
  }

  const tables: Array<[Exclude<Entity, "setting">, string]> = [
    ["project", "projects"],
    ["task", "tasks"],
    ["next_project", "next_projects"],
    ["next_idea", "next_ideas"]
  ];
  const labels: Array<Exclude<Entity, "setting">> = [];
  const statements: D1PreparedStatement[] = [];
  for (const [entity, table] of tables) {
    const entityIds = [...(ids.get(entity) ?? [])];
    if (entityIds.length === 0) continue;
    labels.push(entity);
    statements.push(context.env.DB.prepare(
      `SELECT * FROM ${table} WHERE user_id = ? AND id IN (${entityIds.map(() => "?").join(", ")})`
    ).bind(user.id, ...entityIds));
  }

  const existing = new Map<string, Record<string, unknown>>();
  const liveProjectIds = new Set<string>();
  const liveTaskIds = new Set<string>();
  const liveNextProjectIds = new Set<string>();
  if (statements.length === 0) return { existing, liveProjectIds, liveTaskIds, liveNextProjectIds };
  const results = await context.env.DB.batch(statements);
  for (let index = 0; index < results.length; index += 1) {
    const entity = labels[index];
    for (const row of (results[index].results ?? []) as Record<string, unknown>[]) {
      const id = String(row.id ?? "");
      existing.set(existingKey(entity, id), row);
      if (entity === "project" && !row.deleted_at) liveProjectIds.add(id);
      if (entity === "task" && !row.deleted_at) liveTaskIds.add(id);
      if (entity === "next_project" && !row.deleted_at) liveNextProjectIds.add(id);
    }
  }
  return { existing, liveProjectIds, liveTaskIds, liveNextProjectIds };
}

function recordIdFor(mutation: IncomingMutation): string {
  return mutation.entity === "setting"
    ? String(mutation.data.key ?? mutation.data.id ?? "").trim()
    : String(mutation.data.id ?? "").trim();
}

function mutationOrder(mutation: IncomingMutation): number {
  if (mutation.operation === "upsert" && (mutation.entity === "project" || mutation.entity === "next_project")) return 0;
  if (mutation.operation === "upsert") return 1;
  if (mutation.entity === "task" || mutation.entity === "next_idea") return 2;
  return 3;
}

export function orderMutationsParentFirst(mutations: IncomingMutation[]): IncomingMutation[] | null {
  const ordered = [...mutations].sort((left, right) => mutationOrder(left) - mutationOrder(right));
  const taskUpserts = ordered.filter((mutation) => mutation.entity === "task" && mutation.operation === "upsert");
  const byId = new Map<string, IncomingMutation>();
  for (const mutation of taskUpserts) {
    const id = String(mutation.data.id ?? "").trim();
    if (!id) continue;
    if (byId.has(id)) return null;
    byId.set(id, mutation);
  }

  const state = new Map<IncomingMutation, "visiting" | "done">();
  const sortedTasks: IncomingMutation[] = [];
  const visit = (mutation: IncomingMutation): boolean => {
    const current = state.get(mutation);
    if (current === "done") return true;
    if (current === "visiting") return false;
    state.set(mutation, "visiting");
    const rawParentId = mutation.patch && hasOwn(mutation.patch, "parent_task_id")
      ? mutation.patch.parent_task_id
      : mutation.data.parent_task_id;
    const parentId = typeof rawParentId === "string" ? rawParentId.trim() : "";
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent === mutation || (parent && !visit(parent))) return false;
    state.set(mutation, "done");
    sortedTasks.push(mutation);
    return true;
  };
  for (const mutation of taskUpserts) {
    if (!visit(mutation)) return null;
  }

  let taskIndex = 0;
  return ordered.map((mutation) =>
    mutation.entity === "task" && mutation.operation === "upsert"
      ? sortedTasks[taskIndex++]
      : mutation
  );
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  let body: MutationBody;
  try {
    body = await readJson<MutationBody>(context.request, 1_500_000);
  } catch {
    return apiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "Invalid mutation payload");
  const mutations = body.mutations ?? [];
  if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > MAX_MUTATIONS) {
    return apiError(400, `Mutation batch must contain 1 to ${MAX_MUTATIONS} items`);
  }
  if (mutations.some((mutation) => !mutation || typeof mutation !== "object" || Array.isArray(mutation))) {
    return apiError(400, "Each mutation must be an object");
  }
  if (mutations.some((mutation) => !mutation.data || typeof mutation.data !== "object" || Array.isArray(mutation.data))) {
    return apiError(400, "Each mutation must include an object data payload");
  }

  const timestamp = nowIso();
  const applied: Applied[] = [];
  const conflicts: Conflict[] = [];
  const processedIds = await findProcessedIds(context, user, mutations.map((mutation) => mutation.id));
  const unprocessed = mutations.filter((mutation) => {
    if (!processedIds.has(mutation.id)) return true;
    applied.push({ id: mutation.id, entity: mutation.entity, recordId: recordIdFor(mutation) });
    return false;
  });
  const fresh = orderMutationsParentFirst(unprocessed);
  if (!fresh) return apiError(400, "Task parent relationships contain a cycle or duplicate record ID");

  const plannedProjectIds = new Set(
    fresh
      .filter((mutation) => mutation.entity === "project" && mutation.operation === "upsert")
      .map((mutation) => String(mutation.data.id ?? "").trim())
      .filter(Boolean)
  );
  const plannedNextProjectIds = new Set(
    fresh
      .filter((mutation) => mutation.entity === "next_project" && mutation.operation === "upsert")
      .map((mutation) => String(mutation.data.id ?? "").trim())
      .filter(Boolean)
  );
  const plannedTaskIds = new Set(
    fresh
      .filter((mutation) => mutation.entity === "task" && mutation.operation === "upsert")
      .map((mutation) => String(mutation.data.id ?? "").trim())
      .filter(Boolean)
  );
  const planningRows = await loadPlanningRows(context, user, fresh);
  const commits: PlannedCommit[] = [];
  let hasPrimaryWrite = false;
  let hasPurge = false;

  for (let index = 0; index < fresh.length; index += 1) {
    const mutation = fresh[index];
    // A per-mutation server stamp lets the post-write ledger distinguish two
    // mutations for the same row inside one sequence transaction.
    const mutationTimestamp = new Date(Date.parse(timestamp) + index).toISOString();
    let plan: MutationPlan;
    try {
      plan = await planMutation(context, user, mutation, mutationTimestamp, {
        existingKnown: (mutation.operation === "upsert" || mutation.operation === "delete") && mutation.entity !== "setting",
        existing: planningRows.existing.get(existingKey(mutation.entity, String(mutation.data.id ?? "").trim())) ?? null,
        plannedProjectIds,
        knownProjectIds: planningRows.liveProjectIds,
        plannedTaskIds,
        knownTaskIds: planningRows.liveTaskIds,
        plannedNextProjectIds,
        knownNextProjectIds: planningRows.liveNextProjectIds
      });
    } catch (error) {
      plan = conflict(mutation, error instanceof Error ? error.message : "Mutation failed", false);
    }
    if (isConflict(plan.result)) {
      conflicts.push(plan.result);
      if (mutation.entity === "project") plannedProjectIds.delete(String(mutation.data.id ?? "").trim());
      if (mutation.entity === "task") plannedTaskIds.delete(String(mutation.data.id ?? "").trim());
      if (mutation.entity === "next_project") plannedNextProjectIds.delete(String(mutation.data.id ?? "").trim());
      continue;
    }
    commits.push({
      mutation,
      result: plan.result,
      statements: plan.statements,
      timestamp: mutationTimestamp,
      ledgerMode: plan.ledgerMode ?? "row"
    });
    hasPrimaryWrite ||= mutation.entity !== "setting" && plan.statements.length > 0;
    hasPurge ||= mutation.operation === "purge" && mutation.entity !== "setting";
  }

  if (commits.length > 0) {
    const transaction: D1PreparedStatement[] = [
      ensureSyncStateStatement(context.env, user.id),
      advanceSyncSequenceStatement(context.env, user.id)
    ];
    for (const commit of commits) {
      transaction.push(...commit.statements);
      commit.ledgerIndex = transaction.length;
      transaction.push(recordProcessed(context, user, commit.mutation, commit.timestamp, commit.ledgerMode));
    }
    if (hasPurge) {
      transaction.push(context.env.DB.prepare(
        "UPDATE sync_state SET epoch = lower(hex(randomblob(16))) WHERE user_id = ?"
      ).bind(user.id));
    }
    if (hasPrimaryWrite && excelAutosyncEnabled(context)) {
      transaction.push(markExcelDirtyStatement(context, user, timestamp));
    }

    let results: D1Result<unknown>[];
    try {
      results = await context.env.DB.batch(transaction);
    } catch (error) {
      return apiError(500, error instanceof Error ? error.message : "Mutation batch failed");
    }

    const unresolved = commits.filter((commit) => Number(results[commit.ledgerIndex!]?.meta?.changes ?? 0) === 0);
    const committedIds = unresolved.length > 0
      ? await findProcessedIds(context, user, unresolved.map((commit) => commit.mutation.id))
      : new Set<string>();
    const raced = unresolved.filter((commit) => !committedIds.has(commit.mutation.id));
    const racedRows = raced.length > 0
      ? await loadPlanningRows(context, user, raced.map((commit) => commit.mutation))
      : {
          existing: new Map<string, Record<string, unknown>>(),
          liveProjectIds: new Set<string>(),
          liveTaskIds: new Set<string>(),
          liveNextProjectIds: new Set<string>()
        };

    for (const commit of commits) {
      const ledgerApplied = Number(results[commit.ledgerIndex!]?.meta?.changes ?? 0) > 0;
      if (ledgerApplied || committedIds.has(commit.mutation.id)) {
        applied.push(commit.result);
        continue;
      }

      const current = racedRows.existing.get(
        existingKey(commit.mutation.entity, String(commit.mutation.data.id ?? "").trim())
      );
      if (commit.mutation.operation === "delete" && (!current || current.deleted_at)) {
        applied.push(commit.result);
        continue;
      }
      if (commit.mutation.operation === "upsert" && (!current || current.deleted_at)) {
        conflicts.push({
          id: commit.mutation.id,
          entity: commit.mutation.entity,
          recordId: recordIdFor(commit.mutation),
          reason: current ? "Record was deleted" : "Record no longer exists",
          permanent: true,
          serverRecord: current ?? null
        });
        continue;
      }
      conflicts.push({
        id: commit.mutation.id,
        entity: commit.mutation.entity,
        recordId: recordIdFor(commit.mutation),
        reason:
          commit.mutation.operation === "delete"
            ? "Record changed before deletion"
            : commit.mutation.baseVersion === null || commit.mutation.baseVersion === undefined
              ? "Record already exists"
              : "Version conflict",
        permanent:
          commit.mutation.operation === "delete" ||
          commit.mutation.baseVersion === null ||
          commit.mutation.baseVersion === undefined ||
          !commit.mutation.patch,
        serverRecord: current
      });
    }
  }

  return json({ ok: true, serverTime: nowIso(), applied, conflicts });
}
