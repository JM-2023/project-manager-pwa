import { authenticate, isResponse } from "./_utils/auth";
import {
  advanceSyncSequenceIfTouchedStatement,
  ensureSyncStateStatement,
  markExcelDirtyForOperationStatement,
  NEXT_SYNC_SEQUENCE_SQL
} from "./_utils/db";
import { apiError, json, readJson, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext, AuthUser } from "./_utils/types";
import { asIntFlag, normalizeDate, normalizePriority, normalizeStatus, nullableText, safeJsonString } from "./_utils/validation";

/**
 * Resumable merge restore. The browser sends parent-first chunks of at most 20
 * rows. Every chunk and its durable response ledger commit in one D1
 * transaction, so retrying after a lost response cannot replay an old backup
 * over newer edits.
 */

interface RestoreBody {
  projects?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  nextProjects?: Record<string, unknown>[];
  nextIdeas?: Record<string, unknown>[];
  restoreId?: string;
  chunkIndex?: number;
}

type RestoreEntity = "projects" | "tasks" | "nextProjects" | "nextIdeas";

interface TaggedStatement {
  entity: RestoreEntity;
  statement: D1PreparedStatement;
}

const MAX_ROWS_PER_REQUEST = 20;

interface RestoreChunkIdentity {
  restoreId: string;
  chunkIndex: number;
}

interface RestoreCounts {
  projects: number;
  tasks: number;
  nextProjects: number;
  nextIdeas: number;
}

async function completedRestoreChunk(
  context: AppContext,
  userId: string,
  identity: RestoreChunkIdentity
): Promise<RestoreCounts | null> {
  return context.env.DB.prepare(
    `SELECT
       projects_count AS projects,
       tasks_count AS tasks,
       next_projects_count AS "nextProjects",
       next_ideas_count AS "nextIdeas"
     FROM processed_restore_chunks
     WHERE user_id = ? AND restore_id = ? AND chunk_index = ?`
  )
    .bind(userId, identity.restoreId, identity.chunkIndex)
    .first<RestoreCounts>();
}

function restoreChunkIdentity(body: RestoreBody): RestoreChunkIdentity | null | undefined {
  const hasRestoreId = body.restoreId !== undefined;
  const hasChunkIndex = body.chunkIndex !== undefined;
  if (!hasRestoreId && !hasChunkIndex) return null;
  if (!hasRestoreId || !hasChunkIndex) return undefined;
  const restoreId = body.restoreId;
  const chunkIndex = body.chunkIndex;
  if (typeof restoreId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(restoreId)) return undefined;
  if (typeof chunkIndex !== "number" || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 1_000_000) return undefined;
  return { restoreId, chunkIndex };
}

function rowId(row: Record<string, unknown>): string | null {
  const id = String(row.id ?? "").trim();
  return /^[A-Za-z0-9:_-]{1,128}$/.test(id) ? id : null;
}

function safeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function positiveVersion(value: unknown): number {
  return Math.max(1, safeInteger(value, 1));
}

function restoreRowIsBounded(row: Record<string, unknown>): boolean {
  for (const value of Object.values(row)) {
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (typeof value === "string" && value.length > 250_000) return false;
  }
  try {
    return JSON.stringify(row).length <= 500_000;
  } catch {
    return false;
  }
}

function restoreProject(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
    `INSERT INTO projects (
       id, user_id, name, description, color, sort_order, archived,
       created_at, updated_at, deleted_at, version, sync_seq
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SYNC_SEQUENCE_SQL})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       color = excluded.color,
       sort_order = excluded.sort_order,
       archived = excluded.archived,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       version = projects.version + 1,
       sync_seq = excluded.sync_seq
     WHERE projects.user_id = excluded.user_id AND (
       projects.name IS NOT excluded.name OR
       projects.description IS NOT excluded.description OR
       projects.color IS NOT excluded.color OR
       projects.sort_order IS NOT excluded.sort_order OR
       projects.archived IS NOT excluded.archived OR
       projects.deleted_at IS NOT excluded.deleted_at
     )`
  ).bind(
    id,
    user.id,
    nullableText(row.name) ?? "Untitled project",
    nullableText(row.description),
    nullableText(row.color),
    safeInteger(row.sort_order, 0),
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    // Exported backups contain live records. Ignore a forged/stale tombstone so
    // restore always restores a usable parent graph.
    null,
    positiveVersion(row.version),
    user.id
  );
}

function restoreTask(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
    `INSERT INTO tasks (
       id, user_id, project_id, title, description, status, priority, due_date, start_date, completed_at,
       next_action, notes, sort_order, parent_task_id, source, external_key, extra_json, archived,
       created_at, updated_at, deleted_at, version, sync_seq
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SYNC_SEQUENCE_SQL})
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
       version = tasks.version + 1,
       sync_seq = excluded.sync_seq
     WHERE tasks.user_id = excluded.user_id AND (
       tasks.project_id IS NOT excluded.project_id OR tasks.title IS NOT excluded.title OR
       tasks.description IS NOT excluded.description OR tasks.status IS NOT excluded.status OR
       tasks.priority IS NOT excluded.priority OR tasks.due_date IS NOT excluded.due_date OR
       tasks.start_date IS NOT excluded.start_date OR tasks.completed_at IS NOT excluded.completed_at OR
       tasks.next_action IS NOT excluded.next_action OR tasks.notes IS NOT excluded.notes OR
       tasks.sort_order IS NOT excluded.sort_order OR tasks.parent_task_id IS NOT excluded.parent_task_id OR
       tasks.source IS NOT excluded.source OR tasks.external_key IS NOT excluded.external_key OR
       tasks.extra_json IS NOT excluded.extra_json OR tasks.archived IS NOT excluded.archived OR
       tasks.deleted_at IS NOT excluded.deleted_at
     )`
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
    safeInteger(row.sort_order, 0),
    nullableText(row.parent_task_id),
    nullableText(row.source) ?? "app",
    nullableText(row.external_key),
    safeJsonString(row.extra_json),
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    null,
    positiveVersion(row.version),
    user.id
  );
}

function restoreNextProject(context: AppContext, user: AuthUser, row: Record<string, unknown>, id: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
    `INSERT INTO next_projects (
       id, user_id, name, description, color, sort_order, source_project_id,
       archived, created_at, updated_at, deleted_at, version, sync_seq
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SYNC_SEQUENCE_SQL})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       color = excluded.color,
       sort_order = excluded.sort_order,
       source_project_id = excluded.source_project_id,
       archived = excluded.archived,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       version = next_projects.version + 1,
       sync_seq = excluded.sync_seq
     WHERE next_projects.user_id = excluded.user_id AND (
       next_projects.name IS NOT excluded.name OR
       next_projects.description IS NOT excluded.description OR
       next_projects.color IS NOT excluded.color OR
       next_projects.sort_order IS NOT excluded.sort_order OR
       next_projects.source_project_id IS NOT excluded.source_project_id OR
       next_projects.archived IS NOT excluded.archived OR
       next_projects.deleted_at IS NOT excluded.deleted_at
     )`
  ).bind(
    id,
    user.id,
    nullableText(row.name) ?? "New idea group",
    nullableText(row.description),
    nullableText(row.color),
    safeInteger(row.sort_order, 0),
    // Migration provenance is not a live relation. Backups intentionally omit
    // deleted formal projects, so carrying this legacy foreign key into a
    // fresh database can make an otherwise valid restore fail.
    null,
    asIntFlag(row.archived),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    null,
    positiveVersion(row.version),
    user.id
  );
}

function restoreNextIdea(
  context: AppContext,
  user: AuthUser,
  row: Record<string, unknown>,
  id: string,
  timestamp: string
): D1PreparedStatement | null {
  const nextProjectId = String(row.next_project_id ?? "").trim();
  if (!nextProjectId) return null;
  return context.env.DB.prepare(
    `INSERT INTO next_ideas (
       id, user_id, next_project_id, title, note, sort_order, source_task_id,
       extra_json, created_at, updated_at, deleted_at, version, sync_seq
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SYNC_SEQUENCE_SQL})
     ON CONFLICT(id) DO UPDATE SET
       next_project_id = excluded.next_project_id,
       title = excluded.title,
       note = excluded.note,
       sort_order = excluded.sort_order,
       source_task_id = excluded.source_task_id,
       extra_json = excluded.extra_json,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at,
       version = next_ideas.version + 1,
       sync_seq = excluded.sync_seq
     WHERE next_ideas.user_id = excluded.user_id AND (
       next_ideas.next_project_id IS NOT excluded.next_project_id OR
       next_ideas.title IS NOT excluded.title OR next_ideas.note IS NOT excluded.note OR
       next_ideas.sort_order IS NOT excluded.sort_order OR
       next_ideas.source_task_id IS NOT excluded.source_task_id OR
       next_ideas.extra_json IS NOT excluded.extra_json OR
       next_ideas.deleted_at IS NOT excluded.deleted_at
     )`
  ).bind(
    id,
    user.id,
    nextProjectId,
    typeof row.title === "string" ? row.title.trim() : "",
    nullableText(row.note),
    safeInteger(row.sort_order, 0),
    // Migration provenance is not a live relation and may refer to a task that
    // is absent from this backup or belongs to another database.
    null,
    safeJsonString(row.extra_json),
    nullableText(row.created_at) ?? timestamp,
    timestamp,
    null,
    positiveVersion(row.version),
    user.id
  );
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

interface RestoreInputRows {
  projects: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  nextProjects: Record<string, unknown>[];
  nextIdeas: Record<string, unknown>[];
}

function parentFirstTaskRows(rows: Record<string, unknown>[]): Record<string, unknown>[] | null {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = rowId(row);
    if (!id || byId.has(id)) return null;
    byId.set(id, row);
  }

  const state = new Map<string, "visiting" | "done">();
  const ordered: Record<string, unknown>[] = [];
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "done") return true;
    if (current === "visiting") return false;
    const row = byId.get(id);
    if (!row) return true;
    state.set(id, "visiting");
    const parentId = nullableText(row.parent_task_id);
    if (parentId === id || (parentId && byId.has(parentId) && !visit(parentId))) return false;
    state.set(id, "done");
    ordered.push(row);
    return true;
  };

  for (const id of byId.keys()) {
    if (!visit(id)) return null;
  }
  return ordered;
}

interface OwnedRow {
  id: string;
  user_id: string;
  deleted_at?: string | null;
}

async function restoreOwnershipConflict(
  context: AppContext,
  user: AuthUser,
  input: RestoreInputRows
): Promise<boolean> {
  const inputProjectIds = new Set(input.projects.map(rowId).filter((id): id is string => Boolean(id)));
  const inputNextProjectIds = new Set(input.nextProjects.map(rowId).filter((id): id is string => Boolean(id)));
  const inputTaskIds = new Set(input.tasks.map(rowId).filter((id): id is string => Boolean(id)));
  const taskProjectIds = input.tasks.map((row) => nullableText(row.project_id)).filter((id): id is string => Boolean(id));
  const taskParentIds = input.tasks.map((row) => nullableText(row.parent_task_id)).filter((id): id is string => Boolean(id));
  const ideaProjectIds = input.nextIdeas.map((row) => nullableText(row.next_project_id)).filter((id): id is string => Boolean(id));
  if ([...taskProjectIds, ...taskParentIds, ...ideaProjectIds].some((id) => !/^[A-Za-z0-9:_-]{1,128}$/.test(id))) return true;
  if (input.tasks.some((row) => nullableText(row.parent_task_id) === rowId(row))) return true;

  const idsByTable = new Map<string, Set<string>>([
    ["projects", new Set([...inputProjectIds, ...taskProjectIds])],
    ["tasks", new Set([...inputTaskIds, ...taskParentIds])],
    ["next_projects", new Set([...inputNextProjectIds, ...ideaProjectIds])],
    ["next_ideas", new Set(input.nextIdeas.map(rowId).filter((id): id is string => Boolean(id)))]
  ]);
  const tables: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const [table, ids] of idsByTable) {
    if (ids.size === 0) continue;
    tables.push(table);
    statements.push(
      context.env.DB.prepare(
        `SELECT id, user_id, deleted_at FROM ${table} WHERE id IN (${[...ids].map(() => "?").join(", ")})`
      ).bind(...ids)
    );
  }

  const owners = new Map<string, OwnedRow>();
  if (statements.length > 0) {
    const results = await context.env.DB.batch(statements);
    for (let index = 0; index < results.length; index += 1) {
      for (const row of (results[index].results ?? []) as unknown as OwnedRow[]) {
        if (row.user_id !== user.id) return true;
        owners.set(`${tables[index]}:${row.id}`, row);
      }
    }
  }

  for (const projectId of taskProjectIds) {
    const existing = owners.get(`projects:${projectId}`);
    if (!inputProjectIds.has(projectId) && (!existing || existing.deleted_at)) return true;
  }
  for (const parentTaskId of taskParentIds) {
    const existing = owners.get(`tasks:${parentTaskId}`);
    if (!inputTaskIds.has(parentTaskId) && (!existing || existing.deleted_at)) return true;
  }
  for (const projectId of ideaProjectIds) {
    const existing = owners.get(`next_projects:${projectId}`);
    if (!inputNextProjectIds.has(projectId) && (!existing || existing.deleted_at)) return true;
  }
  return false;
}

function excelAutosyncEnabled(context: AppContext): boolean {
  return (context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS)) || context.env.ENABLE_D1_EXCEL_STATE === "true";
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  let body: RestoreBody;
  try {
    body = await readJson<RestoreBody>(context.request, 2_000_000);
  } catch {
    return apiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "Invalid restore payload");
  const chunkIdentity = restoreChunkIdentity(body);
  if (chunkIdentity === undefined) return apiError(400, "Invalid restore chunk identity");
  if (chunkIdentity) {
    const completed = await completedRestoreChunk(context, user.id, chunkIdentity);
    if (completed) return json({ ok: true, ...completed });
  }
  for (const key of ["projects", "tasks", "nextProjects", "nextIdeas"] as const) {
    const value = body[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row)))) {
      return apiError(400, "Invalid restore payload");
    }
  }

  const input: RestoreInputRows = {
    projects: asRows(body.projects),
    tasks: asRows(body.tasks),
    nextProjects: asRows(body.nextProjects),
    nextIdeas: asRows(body.nextIdeas)
  };
  const inputGroups: Record<string, unknown>[][] = [input.projects, input.tasks, input.nextProjects, input.nextIdeas];
  const total = inputGroups.reduce((sum, rows) => sum + rows.length, 0);
  if (total === 0) return apiError(400, "Backup chunk contains no records");
  if (total > MAX_ROWS_PER_REQUEST) {
    return apiError(400, `Restore request must contain up to ${MAX_ROWS_PER_REQUEST} rows`);
  }
  if (inputGroups.some((rows) => rows.some((row) => !restoreRowIsBounded(row)))) {
    return apiError(400, "Backup chunk contains an invalid or oversized record");
  }
  if (inputGroups.some((rows) => rows.some((row) => !rowId(row)))) {
    return apiError(400, "Backup chunk contains an invalid record ID");
  }
  const orderedTasks = parentFirstTaskRows(input.tasks);
  if (!orderedTasks) {
    return apiError(400, "Backup task parents contain a cycle or duplicate record ID");
  }
  input.tasks = orderedTasks;
  if (input.nextIdeas.some((row) => !nullableText(row.next_project_id))) {
    return apiError(400, "Backup idea is missing its parent project");
  }
  if (await restoreOwnershipConflict(context, user, input)) {
    return apiError(409, "Backup IDs or parent relationships conflict with the current owner");
  }

  const timestamp = nowIso();
  const tagged: TaggedStatement[] = [];
  for (const row of input.projects) {
    const id = rowId(row);
    if (id) tagged.push({ entity: "projects", statement: restoreProject(context, user, row, id, timestamp) });
  }
  for (const row of input.tasks) {
    const id = rowId(row);
    if (id) tagged.push({ entity: "tasks", statement: restoreTask(context, user, row, id, timestamp) });
  }
  for (const row of input.nextProjects) {
    const id = rowId(row);
    if (id) tagged.push({ entity: "nextProjects", statement: restoreNextProject(context, user, row, id, timestamp) });
  }
  for (const row of input.nextIdeas) {
    const id = rowId(row);
    if (!id) continue;
    const statement = restoreNextIdea(context, user, row, id, timestamp);
    if (statement) tagged.push({ entity: "nextIdeas", statement });
  }
  if (tagged.length === 0) return apiError(400, "Backup chunk contains no valid records");

  const operationId = crypto.randomUUID();
  const counts: RestoreCounts = { projects: 0, tasks: 0, nextProjects: 0, nextIdeas: 0 };
  for (const item of tagged) counts[item.entity] += 1;
  const statements: D1PreparedStatement[] = [];
  if (chunkIdentity) {
    // Keep this as a plain INSERT at the front of the transaction. Concurrent
    // delivery of the same chunk hits the composite primary key and rolls the
    // entire D1 batch back before any restore write can replay.
    statements.push(context.env.DB.prepare(
      `INSERT INTO processed_restore_chunks (
         user_id, restore_id, chunk_index, projects_count, tasks_count,
         next_projects_count, next_ideas_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id,
      chunkIdentity.restoreId,
      chunkIdentity.chunkIndex,
      counts.projects,
      counts.tasks,
      counts.nextProjects,
      counts.nextIdeas,
      timestamp
    ));
  }
  statements.push(
    ensureSyncStateStatement(context.env, user.id),
    ...tagged.map((item) => item.statement),
    advanceSyncSequenceIfTouchedStatement(context.env, user.id, timestamp, operationId)
  );
  if (excelAutosyncEnabled(context)) {
    statements.push(markExcelDirtyForOperationStatement(context.env, user.id, timestamp, operationId));
  }

  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    // Two requests can both miss the optimistic read. D1 serializes their
    // batches; the loser rolls back on the ledger primary key, then returns the
    // response committed by the winner.
    if (chunkIdentity) {
      const completed = await completedRestoreChunk(context, user.id, chunkIdentity);
      if (completed) return json({ ok: true, ...completed });
    }
    const message = error instanceof Error ? error.message : "Restore failed";
    if (/owner mismatch|parent cycle/.test(message)) {
      return apiError(409, "Backup parent relationships conflict with the current data");
    }
    return apiError(500, message);
  }

  return json({ ok: true, ...counts });
}
