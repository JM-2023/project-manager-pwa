import { authenticate, isResponse } from "./_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext, AuthUser } from "./_utils/types";
import { normalizeDate, normalizePriority, normalizeStatus, nullableText, safeJsonString } from "./_utils/validation";

interface ImportRow {
  id?: string;
  external_key?: string;
  source?: string;
  project?: string;
  title?: string;
  status?: string;
  priority?: string;
  due_date?: string | null;
  start_date?: string | null;
  next_action?: string | null;
  notes?: string | null;
  description?: string | null;
  tags?: string[];
  extra_json?: Record<string, unknown>;
}

interface ImportBody {
  filename?: string;
  mode?: "create_or_update";
  rows?: ImportRow[];
}

async function getOrCreateProject(context: AppContext, user: AuthUser, name: string, timestamp: string): Promise<string | null> {
  const clean = name.trim();
  if (!clean) {
    return null;
  }
  const existing = await context.env.DB.prepare("SELECT id, archived FROM projects WHERE user_id = ? AND name = ? AND deleted_at IS NULL")
    .bind(user.id, clean)
    .first<{ id: string; archived: number }>();
  if (existing) {
    if (Number(existing.archived) !== 0) {
      await context.env.DB.prepare("UPDATE projects SET archived = 0, updated_at = ?, version = version + 1 WHERE user_id = ? AND id = ?")
        .bind(timestamp, user.id, existing.id)
        .run();
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  await context.env.DB.prepare(
    "INSERT INTO projects (id, user_id, name, description, color, sort_order, archived, created_at, updated_at, deleted_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, clean, null, null, 0, 0, timestamp, timestamp, null, 1)
    .run();
  return id;
}

async function getOrCreateTag(context: AppContext, user: AuthUser, name: string, timestamp: string): Promise<string | null> {
  const clean = name.trim();
  if (!clean) {
    return null;
  }
  const existing = await context.env.DB.prepare("SELECT id FROM tags WHERE user_id = ? AND name = ? AND deleted_at IS NULL")
    .bind(user.id, clean)
    .first<{ id: string }>();
  if (existing) {
    return existing.id;
  }
  const id = crypto.randomUUID();
  await context.env.DB.prepare("INSERT INTO tags (id, user_id, name, color, created_at, updated_at, deleted_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, clean, null, timestamp, timestamp, null, 1)
    .run();
  return id;
}

async function findImportTask(context: AppContext, user: AuthUser, row: ImportRow, projectId: string | null): Promise<Record<string, unknown> | null> {
  if (row.id) {
    const byId = await context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND id = ?").bind(user.id, row.id).first<Record<string, unknown>>();
    if (byId) return byId;
  }
  if (row.external_key) {
    const byExternalKey = await context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND external_key = ?")
      .bind(user.id, row.external_key)
      .first<Record<string, unknown>>();
    if (byExternalKey) return byExternalKey;
  }

  const title = nullableText(row.title);
  if (!title) {
    return null;
  }

  const startDate = normalizeDate(row.start_date);
  const dueDate = normalizeDate(row.due_date);
  const source = nullableText(row.source) ?? "excel";
  return context.env.DB.prepare(
    `SELECT * FROM tasks
     WHERE user_id = ?
       AND source = ?
       AND title = ?
       AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
       AND ((start_date IS NULL AND ? IS NULL) OR start_date = ?)
       AND ((due_date IS NULL AND ? IS NULL) OR due_date = ?)
       AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`
  )
    .bind(user.id, source, title, projectId, projectId, startDate, startDate, dueDate, dueDate)
    .first<Record<string, unknown>>();
}

async function upsertTask(context: AppContext, user: AuthUser, row: ImportRow, projectId: string | null, timestamp: string): Promise<{ id: string; created: boolean }> {
  const existing = await findImportTask(context, user, row, projectId);
  const id = existing ? String(existing.id) : row.id || crypto.randomUUID();
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;
  const createdAt = String(existing?.created_at ?? timestamp);
  const status = normalizeStatus(row.status ?? existing?.status ?? "todo");
  const completedAt = status === "done" ? String(existing?.completed_at ?? timestamp) : null;
  const source = nullableText(row.source ?? existing?.source) ?? "excel";

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
      source = excluded.source,
      external_key = excluded.external_key,
      extra_json = excluded.extra_json,
      updated_at = excluded.updated_at,
      version = excluded.version`
  )
    .bind(
      id,
      user.id,
      projectId,
      nullableText(row.title) ?? "Imported task",
      nullableText(row.description),
      status,
      normalizePriority(row.priority ?? existing?.priority ?? "medium"),
      normalizeDate(row.due_date),
      normalizeDate(row.start_date),
      completedAt,
      nullableText(row.next_action),
      nullableText(row.notes),
      Number(existing?.sort_order ?? 0),
      null,
      source,
      nullableText(row.external_key ?? row.id),
      safeJsonString(row.extra_json),
      0,
      createdAt,
      timestamp,
      null,
      version
    )
    .run();

  return { id, created: !existing };
}

async function attachTags(context: AppContext, user: AuthUser, taskId: string, tags: string[] | undefined, timestamp: string): Promise<void> {
  for (const tagName of tags ?? []) {
    const tagId = await getOrCreateTag(context, user, tagName, timestamp);
    if (!tagId) continue;
    await context.env.DB.prepare(
      `INSERT INTO task_tags (task_id, tag_id, user_id, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id, tag_id) DO UPDATE SET deleted_at = NULL`
    )
      .bind(taskId, tagId, user.id, timestamp, null)
      .run();
  }
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  let body: ImportBody;
  try {
    body = await readJson<ImportBody>(context.request, 4_000_000);
  } catch {
    return apiError(400, "Invalid JSON");
  }

  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || rows.length > 5_000) {
    return apiError(400, "Import must contain up to 5000 rows");
  }

  const batchId = crypto.randomUUID();
  const timestamp = nowIso();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!nullableText(row.title)) {
      skipped += 1;
      continue;
    }
    const projectId = await getOrCreateProject(context, user, row.project ?? "", timestamp);
    const task = await upsertTask(context, user, row, projectId, timestamp);
    await attachTags(context, user, task.id, row.tags, timestamp);
    if (task.created) created += 1;
    else updated += 1;
  }

  return json({ ok: true, batchId, created, updated, skipped });
}
