import { authenticate, isResponse } from "./_utils/auth";
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

type Entity = "project" | "task" | "tag" | "task_tag" | "setting";
type Operation = "upsert" | "delete";

interface IncomingMutation {
  id: string;
  entity: Entity;
  operation: Operation;
  baseVersion?: number | null;
  data: Record<string, unknown>;
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
}

interface Conflict {
  id: string;
  entity: Entity;
  recordId?: string;
  reason: string;
  serverRecord?: unknown;
}

const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";

function excelAutosyncEnabled(context: AppContext): boolean {
  return (context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS)) || context.env.ENABLE_D1_EXCEL_STATE === "true";
}

async function markExcelDirty(context: AppContext, user: AuthUser, timestamp: string): Promise<void> {
  if (!excelAutosyncEnabled(context)) {
    return;
  }
  await context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(user.id, EXCEL_DIRTY_SETTING_KEY, JSON.stringify(timestamp), timestamp)
    .run();
}

function isStaleTextConflict(mutation: IncomingMutation, existing: Record<string, unknown> | null): boolean {
  if (!existing || mutation.baseVersion === null || mutation.baseVersion === undefined) {
    return false;
  }
  const existingVersion = Number(existing.version ?? 0);
  if (existingVersion <= mutation.baseVersion) {
    return false;
  }
  if (mutation.entity !== "task") {
    return false;
  }
  for (const field of ["title", "description", "notes", "next_action"]) {
    if (field in mutation.data && String(mutation.data[field] ?? "") !== String(existing[field] ?? "")) {
      return true;
    }
  }
  return false;
}

async function findExisting(context: AppContext, user: AuthUser, mutation: IncomingMutation): Promise<Record<string, unknown> | null> {
  const id = String(mutation.data.id ?? mutation.data.task_id ?? "");
  if (mutation.entity === "task_tag") {
    return context.env.DB.prepare("SELECT * FROM task_tags WHERE user_id = ? AND task_id = ? AND tag_id = ?")
      .bind(user.id, mutation.data.task_id, mutation.data.tag_id)
      .first<Record<string, unknown>>();
  }
  if (!id) {
    return null;
  }
  const table = {
    project: "projects",
    task: "tasks",
    tag: "tags",
    setting: "app_settings"
  }[mutation.entity];
  if (!table) {
    return null;
  }
  if (mutation.entity === "setting") {
    return context.env.DB.prepare("SELECT * FROM app_settings WHERE user_id = ? AND key = ?").bind(user.id, id).first<Record<string, unknown>>();
  }
  return context.env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND id = ?`).bind(user.id, id).first<Record<string, unknown>>();
}

async function applyProject(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  await context.env.DB.prepare(
    `INSERT INTO projects (id, user_id, name, description, color, sort_order, archived, created_at, updated_at, deleted_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       color = excluded.color,
       sort_order = excluded.sort_order,
       archived = excluded.archived,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       version = excluded.version`
  )
    .bind(
      id,
      user.id,
      nullableText(data.name) ?? "Untitled project",
      nullableText(data.description),
      nullableText(data.color),
      Number(data.sort_order ?? existing?.sort_order ?? 0),
      asIntFlag(data.archived),
      createdAt,
      timestamp,
      nullableText(data.deleted_at),
      version
    )
    .run();
  return { id: mutation.id, entity: "project", recordId: id, version, updated_at: timestamp };
}

async function applyTask(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  await context.env.DB.prepare(
    `INSERT INTO tasks (
      id, user_id, project_id, title, description, status, priority, due_date, start_date, completed_at,
      next_action, notes, sort_order, parent_task_id, source, external_key, extra_json, archived,
      created_at, updated_at, deleted_at, version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      due_date = excluded.due_date,
      start_date = excluded.start_date,
      completed_at = excluded.completed_at,
      next_action = excluded.next_action,
      notes = excluded.notes,
      sort_order = excluded.sort_order,
      parent_task_id = excluded.parent_task_id,
      source = excluded.source,
      external_key = excluded.external_key,
      extra_json = excluded.extra_json,
      archived = excluded.archived,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      version = excluded.version`
  )
    .bind(
      id,
      user.id,
      nullableText(data.project_id),
      nullableText(data.title) ?? "Untitled task",
      nullableText(data.description),
      normalizeStatus(data.status),
      normalizePriority(data.priority),
      normalizeDate(data.due_date),
      normalizeDate(data.start_date),
      nullableText(data.completed_at),
      nullableText(data.next_action),
      nullableText(data.notes),
      Number(data.sort_order ?? existing?.sort_order ?? 0),
      nullableText(data.parent_task_id),
      nullableText(data.source) ?? "app",
      nullableText(data.external_key),
      safeJsonString(data.extra_json),
      asIntFlag(data.archived),
      createdAt,
      timestamp,
      nullableText(data.deleted_at),
      version
    )
    .run();

  return { id: mutation.id, entity: "task", recordId: id, version, updated_at: timestamp };
}

async function applyTag(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  await context.env.DB.prepare(
    `INSERT INTO tags (id, user_id, name, color, created_at, updated_at, deleted_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       color = excluded.color,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       version = excluded.version`
  )
    .bind(id, user.id, nullableText(data.name) ?? "Tag", nullableText(data.color), createdAt, timestamp, nullableText(data.deleted_at), version)
    .run();
  return { id: mutation.id, entity: "tag", recordId: id, version, updated_at: timestamp };
}

async function applyTaskTag(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied> {
  const taskId = String(mutation.data.task_id ?? "");
  const tagId = String(mutation.data.tag_id ?? "");
  if (!taskId || !tagId) {
    throw new Error("Task tag requires task_id and tag_id");
  }
  await context.env.DB.prepare(
    `INSERT INTO task_tags (task_id, tag_id, user_id, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id, tag_id) DO UPDATE SET deleted_at = excluded.deleted_at`
  )
    .bind(taskId, tagId, user.id, String(mutation.data.created_at ?? timestamp), nullableText(mutation.data.deleted_at))
    .run();
  return { id: mutation.id, entity: "task_tag", recordId: `${taskId}:${tagId}`, updated_at: timestamp };
}

async function applySetting(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied> {
  const key = String(mutation.data.key ?? mutation.data.id ?? "");
  if (!key) {
    throw new Error("Setting key is required");
  }
  await context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(user.id, key, JSON.stringify(mutation.data.value ?? null), timestamp)
    .run();
  return { id: mutation.id, entity: "setting", recordId: key, updated_at: timestamp };
}

async function applyDelete(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied> {
  if (mutation.entity === "task_tag") {
    const taskId = String(mutation.data.task_id ?? "");
    const tagId = String(mutation.data.tag_id ?? "");
    await context.env.DB.prepare("DELETE FROM task_tags WHERE user_id = ? AND task_id = ? AND tag_id = ?")
      .bind(user.id, taskId, tagId)
      .run();
    return { id: mutation.id, entity: mutation.entity, recordId: `${taskId}:${tagId}`, updated_at: timestamp };
  }

  const table = { project: "projects", task: "tasks", tag: "tags", setting: "app_settings" }[mutation.entity];
  const id = String(mutation.data.id ?? "");
  if (mutation.entity === "setting") {
    await context.env.DB.prepare("DELETE FROM app_settings WHERE user_id = ? AND key = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
  }
  if (mutation.entity === "task") {
    await context.env.DB.prepare("DELETE FROM task_tags WHERE user_id = ? AND task_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM task_events WHERE user_id = ? AND task_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").bind(user.id, id).run();
  } else if (mutation.entity === "tag") {
    await context.env.DB.prepare("DELETE FROM task_tags WHERE user_id = ? AND tag_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM tags WHERE user_id = ? AND id = ?").bind(user.id, id).run();
  } else {
    await context.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).bind(user.id, id).run();
  }
  return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
}

async function applyMutation(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied | Conflict> {
  if (!["project", "task", "tag", "task_tag", "setting"].includes(mutation.entity) || !["upsert", "delete"].includes(mutation.operation)) {
    return { id: mutation.id, entity: mutation.entity, reason: "Unsupported mutation" };
  }

  const existing = await findExisting(context, user, mutation);
  if (isStaleTextConflict(mutation, existing)) {
    return {
      id: mutation.id,
      entity: mutation.entity,
      recordId: String(mutation.data.id ?? ""),
      reason: "Text fields changed on the server before this edit was synced.",
      serverRecord: existing
    };
  }

  if (
    mutation.operation === "delete" ||
    (mutation.entity === "task" && (mutation.data.deleted_at || Number(mutation.data.archived ?? 0) !== 0))
  ) {
    return applyDelete(context, user, mutation, timestamp);
  }

  if (mutation.entity === "project") return applyProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task") return applyTask(context, user, mutation, existing, timestamp);
  if (mutation.entity === "tag") return applyTag(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task_tag") return applyTaskTag(context, user, mutation, timestamp);
  return applySetting(context, user, mutation, timestamp);
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

  const mutations = body.mutations ?? [];
  if (!Array.isArray(mutations) || mutations.length > 200) {
    return apiError(400, "Mutation batch must contain 1 to 200 items");
  }

  const applied: Applied[] = [];
  const conflicts: Conflict[] = [];
  const timestamp = nowIso();

  for (const mutation of mutations) {
    try {
      const result = await applyMutation(context, user, mutation, timestamp);
      if ("reason" in result) conflicts.push(result);
      else applied.push(result);
    } catch (error) {
      conflicts.push({
        id: mutation.id,
        entity: mutation.entity,
        recordId: String(mutation.data?.id ?? ""),
        reason: error instanceof Error ? error.message : "Mutation failed"
      });
    }
  }

  if (applied.length > 0) {
    await markExcelDirty(context, user, timestamp);
  }

  return json({ ok: true, serverTime: timestamp, applied, conflicts });
}
