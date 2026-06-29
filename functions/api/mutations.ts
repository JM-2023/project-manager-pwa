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

type Entity = "project" | "task" | "tag" | "task_tag" | "setting" | "next_project" | "next_idea";
type Operation = "upsert" | "delete" | "purge";

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
  // A permanent conflict can never succeed on retry (unsupported/malformed
  // mutation), so the client drops it from the queue instead of re-sending it
  // forever. Conflicts without this flag are treated as transient and retried.
  permanent?: boolean;
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

/**
 * Conflict-free sync model:
 *   - The server NEVER rejects a mutation, so the client queue always drains
 *     (no stuck "pending changes", no reverted edits).
 *   - It is last-writer-wins: whatever syncs is applied and stamped with the
 *     server's clock. `updated_at` stays a server-monotonic value so the
 *     incremental bootstrap cursor (`updated_at > since`) never misses a change
 *     regardless of device clock skew.
 *   - Ordinary "delete" operations are tombstones. Explicit "purge" operations
 *     are hard deletes for records that the product treats as removable rows:
 *     formal projects/tasks and Next projects/ideas.
 */
function nextVersion(existing: Record<string, unknown> | null): number {
  return existing ? Number(existing.version ?? 0) + 1 : 1;
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
    next_project: "next_projects",
    next_idea: "next_ideas",
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

async function applyNextProject(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  await context.env.DB.prepare(
    `INSERT INTO next_projects (
      id, user_id, name, description, color, sort_order, source_project_id,
      archived, created_at, updated_at, deleted_at, version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      nullableText(data.name) ?? "New idea group",
      nullableText(data.description),
      nullableText(data.color),
      Number(data.sort_order ?? existing?.sort_order ?? 0),
      nullableText(existing?.source_project_id),
      asIntFlag(data.archived),
      createdAt,
      timestamp,
      nullableText(data.deleted_at),
      version
    )
    .run();
  return { id: mutation.id, entity: "next_project", recordId: id, version, updated_at: timestamp };
}

async function assertNextProjectOwner(context: AppContext, user: AuthUser, nextProjectId: string): Promise<void> {
  const parent = await context.env.DB.prepare("SELECT id FROM next_projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(user.id, nextProjectId)
    .first<{ id: string }>();
  if (!parent) {
    throw new Error("Next project not found");
  }
}

async function applyNextIdea(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const nextProjectId = String(data.next_project_id ?? existing?.next_project_id ?? "");
  if (!nextProjectId) {
    throw new Error("Next idea requires next_project_id");
  }
  await assertNextProjectOwner(context, user, nextProjectId);
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const title = typeof data.title === "string" ? data.title.trim() : String(existing?.title ?? "");
  await context.env.DB.prepare(
    `INSERT INTO next_ideas (
      id, user_id, next_project_id, title, note, sort_order, source_task_id,
      extra_json, created_at, updated_at, deleted_at, version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      next_project_id = excluded.next_project_id,
      title = excluded.title,
      note = excluded.note,
      sort_order = excluded.sort_order,
      extra_json = excluded.extra_json,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      version = excluded.version`
  )
    .bind(
      id,
      user.id,
      nextProjectId,
      title,
      nullableText(data.note),
      Number(data.sort_order ?? existing?.sort_order ?? 0),
      nullableText(existing?.source_task_id),
      safeJsonString(data.extra_json),
      createdAt,
      timestamp,
      nullableText(data.deleted_at),
      version
    )
    .run();
  return { id: mutation.id, entity: "next_idea", recordId: id, version, updated_at: timestamp };
}

async function applyProject(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): Promise<Applied> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = nextVersion(existing);
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
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const title = typeof data.title === "string" ? data.title.trim() : String(existing?.title ?? "");
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
      title,
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
  const name = nullableText(data.name) ?? "Tag";

  // tags carries UNIQUE(user_id, name). When two devices create the same-named
  // tag offline they mint different ids; the second insert would otherwise hit
  // the name constraint, throw, and get re-queued as a transient conflict
  // forever (a poisoned queue that never drains). If this is a fresh tag (no row
  // by id) but the name already exists, adopt that existing tag instead of
  // inserting a duplicate, so the mutation resolves cleanly.
  if (!existing) {
    const byName = await context.env.DB.prepare("SELECT * FROM tags WHERE user_id = ? AND name = ?")
      .bind(user.id, name)
      .first<Record<string, unknown>>();
    if (byName && String(byName.id) !== id) {
      if (byName.deleted_at) {
        await context.env.DB.prepare("UPDATE tags SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE user_id = ? AND id = ?")
          .bind(timestamp, user.id, String(byName.id))
          .run();
      }
      return {
        id: mutation.id,
        entity: "tag",
        recordId: String(byName.id),
        version: Number(byName.version ?? 1) + (byName.deleted_at ? 1 : 0),
        updated_at: timestamp
      };
    }
  }

  const version = nextVersion(existing);
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
    .bind(id, user.id, name, nullableText(data.color), createdAt, timestamp, nullableText(data.deleted_at), version)
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

/** Deletes are tombstones (soft delete) so they converge like any other edit. */
async function applyDelete(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied> {
  if (mutation.entity === "task_tag") {
    const taskId = String(mutation.data.task_id ?? "");
    const tagId = String(mutation.data.tag_id ?? "");
    await context.env.DB.prepare("UPDATE task_tags SET deleted_at = ? WHERE user_id = ? AND task_id = ? AND tag_id = ?")
      .bind(timestamp, user.id, taskId, tagId)
      .run();
    return { id: mutation.id, entity: mutation.entity, recordId: `${taskId}:${tagId}`, updated_at: timestamp };
  }

  const id = String(mutation.data.id ?? "");
  if (mutation.entity === "setting") {
    await context.env.DB.prepare("DELETE FROM app_settings WHERE user_id = ? AND key = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
  }

  if (mutation.entity === "next_project") {
    await context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND next_project_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM next_projects WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "next_project", recordId: id, updated_at: timestamp };
  }

  if (mutation.entity === "next_idea") {
    await context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "next_idea", recordId: id, updated_at: timestamp };
  }

  const table = { project: "projects", task: "tasks", tag: "tags" }[mutation.entity];
  if (!table) {
    return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
  }
  const archivedColumn = mutation.entity === "task" || mutation.entity === "project" ? ", archived = 1" : "";
  await context.env.DB.prepare(
    `UPDATE ${table} SET deleted_at = ?, updated_at = ?, version = version + 1${archivedColumn} WHERE user_id = ? AND id = ?`
  )
    .bind(timestamp, timestamp, user.id, id)
    .run();
  return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
}

/**
 * Hard delete — the one place this server removes rows instead of tombstoning.
 * A project purge cascades to its tasks and their tag links. This trades the
 * tombstone convergence guarantee for a real delete, so other live devices only
 * catch up on their next full-replace bootstrap (which they run on app start).
 */
async function applyPurge(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied | Conflict> {
  const id = String(mutation.data.id ?? "");
  if (!id) {
    return { id: mutation.id, entity: mutation.entity, reason: "Record id is required", permanent: true };
  }

  if (mutation.entity === "project") {
    await context.env.DB.prepare(
      "DELETE FROM task_tags WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE user_id = ? AND project_id = ?)"
    )
      .bind(user.id, user.id, id)
      .run();
    await context.env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND project_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM projects WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "project", recordId: id, updated_at: timestamp };
  }

  if (mutation.entity === "task") {
    await context.env.DB.prepare("DELETE FROM task_tags WHERE user_id = ? AND task_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "task", recordId: id, updated_at: timestamp };
  }

  if (mutation.entity === "next_project") {
    await context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND next_project_id = ?").bind(user.id, id).run();
    await context.env.DB.prepare("DELETE FROM next_projects WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "next_project", recordId: id, updated_at: timestamp };
  }

  if (mutation.entity === "next_idea") {
    await context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND id = ?").bind(user.id, id).run();
    return { id: mutation.id, entity: "next_idea", recordId: id, updated_at: timestamp };
  }

  const table = { tag: "tags" }[mutation.entity as "tag"];
  if (table) {
    await context.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).bind(user.id, id).run();
  }
  return { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp };
}

async function applyMutation(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<Applied | Conflict> {
  if (
    !["project", "task", "tag", "task_tag", "setting", "next_project", "next_idea"].includes(mutation.entity) ||
    !["upsert", "delete", "purge"].includes(mutation.operation)
  ) {
    return { id: mutation.id, entity: mutation.entity, reason: "Unsupported mutation", permanent: true };
  }

  // Reject malformed mutations up front so they surface as *permanent* conflicts
  // the client can drop, rather than throwing into the transient-error path and
  // poisoning the queue (re-sent on every sync, never draining).
  if (mutation.entity === "task_tag" && (!mutation.data.task_id || !mutation.data.tag_id)) {
    return { id: mutation.id, entity: mutation.entity, reason: "Task tag requires task_id and tag_id", permanent: true };
  }
  if (mutation.entity === "setting" && !mutation.data.key && !mutation.data.id) {
    return { id: mutation.id, entity: mutation.entity, reason: "Setting key is required", permanent: true };
  }
  if (mutation.entity === "next_idea" && mutation.operation === "upsert" && !mutation.data.next_project_id) {
    return { id: mutation.id, entity: mutation.entity, reason: "Next idea requires next_project_id", permanent: true };
  }

  if (mutation.operation === "purge") {
    return applyPurge(context, user, mutation, timestamp);
  }

  if (mutation.operation === "delete") {
    return applyDelete(context, user, mutation, timestamp);
  }

  // Soft-deleted / archived rows are ordinary tombstone upserts — they must be
  // stored (not removed) so every device converges to the deleted/archived state.
  const existing = await findExisting(context, user, mutation);
  if (mutation.entity === "project") return applyProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task") return applyTask(context, user, mutation, existing, timestamp);
  if (mutation.entity === "tag") return applyTag(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task_tag") return applyTaskTag(context, user, mutation, timestamp);
  if (mutation.entity === "next_project") return applyNextProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "next_idea") return applyNextIdea(context, user, mutation, existing, timestamp);
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
