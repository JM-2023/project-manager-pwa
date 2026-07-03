import { authenticate, isResponse } from "./_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext, AuthUser } from "./_utils/types";
import { asIntFlag, normalizeDate, normalizePriority, normalizeStatus, nullableText, safeJsonString } from "./_utils/validation";

/**
 * Full-fidelity restore from a JSON backup (the /api/export-data payload).
 * Every row is upserted by id: new ids insert, existing ids are overwritten
 * and get their version bumped past the current one. Nothing is deleted —
 * restore is a merge, not a wipe — so it is safe to run against live data.
 */

interface RestoreBody {
  projects?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  nextProjects?: Record<string, unknown>[];
  nextIdeas?: Record<string, unknown>[];
}

const MAX_TOTAL_ROWS = 20_000;
const BATCH_CHUNK = 80;
const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";

function rowId(row: Record<string, unknown>): string | null {
  const id = String(row.id ?? "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

function restoreProject(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
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
       version = projects.version + 1`
  ).bind(
    id,
    user.id,
    nullableText(row.name) ?? "Untitled project",
    nullableText(row.description),
    nullableText(row.color),
    Number(row.sort_order ?? 0),
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    nullableText(row.deleted_at),
    Number(row.version ?? 1)
  );
}

function restoreTask(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
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
      version = tasks.version + 1`
  ).bind(
    id,
    user.id,
    nullableText(row.project_id),
    typeof row.title === "string" ? row.title.trim() : "Restored task",
    nullableText(row.description),
    normalizeStatus(row.status),
    normalizePriority(row.priority),
    normalizeDate(row.due_date),
    normalizeDate(row.start_date),
    nullableText(row.completed_at),
    nullableText(row.next_action),
    nullableText(row.notes),
    Number(row.sort_order ?? 0),
    nullableText(row.parent_task_id),
    nullableText(row.source) ?? "app",
    nullableText(row.external_key),
    safeJsonString(row.extra_json),
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    nullableText(row.deleted_at),
    Number(row.version ?? 1)
  );
}

function restoreNextProject(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
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
      version = next_projects.version + 1`
  ).bind(
    id,
    user.id,
    nullableText(row.name) ?? "New idea group",
    nullableText(row.description),
    nullableText(row.color),
    Number(row.sort_order ?? 0),
    nullableText(row.source_project_id),
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    nullableText(row.deleted_at),
    Number(row.version ?? 1)
  );
}

function restoreNextIdea(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement | null {
  const nextProjectId = String(row.next_project_id ?? "").trim();
  if (!nextProjectId) {
    return null;
  }
  return context.env.DB.prepare(
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
      version = next_ideas.version + 1`
  ).bind(
    id,
    user.id,
    nextProjectId,
    typeof row.title === "string" ? row.title.trim() : "",
    nullableText(row.note),
    Number(row.sort_order ?? 0),
    nullableText(row.source_task_id),
    safeJsonString(row.extra_json),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    nullableText(row.deleted_at),
    Number(row.version ?? 1)
  );
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  let body: RestoreBody;
  try {
    body = await readJson<RestoreBody>(context.request, 25_000_000);
  } catch {
    return apiError(400, "Invalid JSON");
  }

  const projects = asRows(body.projects);
  const tasks = asRows(body.tasks);
  const nextProjects = asRows(body.nextProjects);
  const nextIdeas = asRows(body.nextIdeas);
  const total = projects.length + tasks.length + nextProjects.length + nextIdeas.length;
  if (total === 0) {
    return apiError(400, "Backup file contains no records");
  }
  if (total > MAX_TOTAL_ROWS) {
    return apiError(400, `Backup exceeds ${MAX_TOTAL_ROWS} rows`);
  }

  const timestamp = nowIso();
  const counts = { projects: 0, tasks: 0, nextProjects: 0, nextIdeas: 0 };
  const statements: D1PreparedStatement[] = [];

  // Parents before children so foreign keys resolve within the run.
  for (const row of projects) {
    const id = rowId(row);
    if (!id) continue;
    statements.push(restoreProject(context, user, row, id, timestamp));
    counts.projects += 1;
  }
  for (const row of tasks) {
    const id = rowId(row);
    if (!id) continue;
    statements.push(restoreTask(context, user, row, id, timestamp));
    counts.tasks += 1;
  }
  for (const row of nextProjects) {
    const id = rowId(row);
    if (!id) continue;
    statements.push(restoreNextProject(context, user, row, id, timestamp));
    counts.nextProjects += 1;
  }
  for (const row of nextIdeas) {
    const id = rowId(row);
    if (!id) continue;
    const statement = restoreNextIdea(context, user, row, id, timestamp);
    if (!statement) continue;
    statements.push(statement);
    counts.nextIdeas += 1;
  }

  try {
    for (let index = 0; index < statements.length; index += BATCH_CHUNK) {
      await context.env.DB.batch(statements.slice(index, index + BATCH_CHUNK));
    }
  } catch (error) {
    return apiError(500, error instanceof Error ? error.message : "Restore failed");
  }

  await context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(user.id, EXCEL_DIRTY_SETTING_KEY, JSON.stringify(timestamp), timestamp)
    .run();

  return json({ ok: true, ...counts });
}
