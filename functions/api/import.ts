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
  extra_json?: Record<string, unknown>;
}

interface ImportBody {
  filename?: string;
  mode?: "create_or_update";
  rows?: ImportRow[];
}

interface ProjectPlan {
  id: string;
  statement: D1PreparedStatement | null;
}

interface TaskPlan {
  statement: D1PreparedStatement | null;
  created: boolean;
}

interface PlannedWrite {
  statement: D1PreparedStatement;
  task?: { created: boolean };
}

const MAX_ROWS_PER_REQUEST = 5;

async function stableImportId(prefix: "project" | "task", parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  const hex = [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `import-${prefix}:${hex}`;
}

function validImportedId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9:_-]{1,128}$/.test(id) ? id : null;
}

function importRowIsBounded(row: unknown): row is ImportRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const value = row as Record<string, unknown>;
  const limits: Record<string, number> = {
    id: 128,
    external_key: 256,
    source: 64,
    project: 250,
    title: 1_000,
    status: 32,
    priority: 32,
    due_date: 64,
    start_date: 64,
    next_action: 100_000,
    notes: 100_000,
    description: 100_000
  };
  for (const [key, limit] of Object.entries(limits)) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== "string") return false;
    if (typeof field === "string" && field.length > limit) return false;
  }
  if (value.extra_json !== undefined) {
    if (!value.extra_json || typeof value.extra_json !== "object" || Array.isArray(value.extra_json)) return false;
    if (JSON.stringify(value.extra_json).length > 100_000) return false;
  }
  return true;
}

function excelAutosyncEnabled(context: AppContext): boolean {
  return (context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS)) || context.env.ENABLE_D1_EXCEL_STATE === "true";
}

async function planProject(
  context: AppContext,
  user: AuthUser,
  name: string,
  timestamp: string,
  cache: Map<string, ProjectPlan>
): Promise<ProjectPlan> {
  const clean = name.trim();
  if (!clean) return { id: "", statement: null };
  const cached = cache.get(clean);
  if (cached) return cached;

  const deterministicId = await stableImportId("project", [user.id, clean]);
  const existing = await context.env.DB.prepare(
    `SELECT id, name, archived, deleted_at, created_at
     FROM projects
     WHERE user_id = ?
       AND ((name = ? AND deleted_at IS NULL) OR id = ?)
     ORDER BY CASE WHEN name = ? AND deleted_at IS NULL THEN 0 ELSE 1 END
     LIMIT 1`
  )
    .bind(user.id, clean, deterministicId, clean)
    .first<{ id: string; name: string; archived: number; deleted_at: string | null; created_at: string }>();

  const id = existing?.id ?? deterministicId;
  const needsWrite = !existing || existing.name !== clean || Number(existing.archived) !== 0 || Boolean(existing.deleted_at);
  const plan: ProjectPlan = {
    id,
    statement: needsWrite ? context.env.DB.prepare(
      `INSERT INTO projects (
         id, user_id, name, description, color, sort_order, archived,
         created_at, updated_at, deleted_at, version, sync_seq
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SYNC_SEQUENCE_SQL})
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         archived = 0,
         deleted_at = NULL,
         updated_at = excluded.updated_at,
         version = projects.version + 1,
         sync_seq = excluded.sync_seq
       WHERE projects.user_id = excluded.user_id AND (
         projects.name IS NOT excluded.name OR
         projects.archived <> 0 OR
         projects.deleted_at IS NOT NULL
       )`
    ).bind(id, user.id, clean, null, null, 0, 0, existing?.created_at ?? timestamp, timestamp, null, 1, user.id)
      : null
  };
  cache.set(clean, plan);
  return plan;
}

async function findImportTask(
  context: AppContext,
  user: AuthUser,
  row: ImportRow,
  projectId: string | null
): Promise<Record<string, unknown> | null> {
  if (row.id) {
    const byId = await context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND id = ?")
      .bind(user.id, row.id)
      .first<Record<string, unknown>>();
    if (byId) return byId;
  }
  if (row.external_key) {
    const byExternalKey = await context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND external_key = ?")
      .bind(user.id, row.external_key)
      .first<Record<string, unknown>>();
    if (byExternalKey) return byExternalKey;
  }

  const title = nullableText(row.title);
  if (!title) return null;
  const startDate = normalizeDate(row.start_date);
  const dueDate = normalizeDate(row.due_date);
  const source = nullableText(row.source) ?? "excel";
  return context.env.DB.prepare(
    `SELECT * FROM tasks
     WHERE user_id = ?
       AND source = ?
       AND title = ?
       AND project_id IS ?
       AND start_date IS ?
       AND due_date IS ?
       AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`
  )
    .bind(user.id, source, title, projectId, startDate, dueDate)
    .first<Record<string, unknown>>();
}

async function planTask(
  context: AppContext,
  user: AuthUser,
  row: ImportRow,
  projectId: string | null,
  timestamp: string
): Promise<TaskPlan> {
  const existing = await findImportTask(context, user, row, projectId);
  const source = nullableText(row.source ?? existing?.source) ?? "excel";
  const externalKey = nullableText(row.external_key);
  const id = existing
    ? String(existing.id)
    : validImportedId(row.id) ?? await stableImportId(
      "task",
      externalKey
        ? [user.id, "external", externalKey]
        : [user.id, "identity", source, nullableText(row.title), projectId, normalizeDate(row.start_date), normalizeDate(row.due_date)]
    );
  const createdAt = String(existing?.created_at ?? timestamp);
  const status = normalizeStatus(row.status ?? existing?.status ?? "todo");
  const completedAt = status === "done" ? String(existing?.completed_at ?? timestamp) : null;
  const nextValues: Record<string, unknown> = {
    project_id: projectId,
    title: nullableText(row.title) ?? "Imported task",
    description: nullableText(row.description),
    status,
    priority: normalizePriority(row.priority ?? existing?.priority ?? "medium"),
    due_date: normalizeDate(row.due_date),
    start_date: normalizeDate(row.start_date),
    completed_at: completedAt,
    next_action: nullableText(row.next_action),
    notes: nullableText(row.notes),
    source,
    external_key: nullableText(row.external_key ?? row.id),
    extra_json: safeJsonString(row.extra_json),
    archived: 0,
    deleted_at: null
  };

  if (existing) {
    const unchanged = Object.entries(nextValues).every(([key, value]) => String(existing[key] ?? "") === String(value ?? ""));
    if (unchanged) return { statement: null, created: false };
  }

  const statement = context.env.DB.prepare(
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
       source = excluded.source,
       external_key = excluded.external_key,
       extra_json = excluded.extra_json,
       archived = 0,
       deleted_at = NULL,
       updated_at = excluded.updated_at,
       version = tasks.version + 1,
       sync_seq = excluded.sync_seq
     WHERE tasks.user_id = excluded.user_id AND (
       tasks.project_id IS NOT excluded.project_id OR tasks.title IS NOT excluded.title OR
       tasks.description IS NOT excluded.description OR tasks.status IS NOT excluded.status OR
       tasks.priority IS NOT excluded.priority OR tasks.due_date IS NOT excluded.due_date OR
       tasks.start_date IS NOT excluded.start_date OR tasks.completed_at IS NOT excluded.completed_at OR
       tasks.next_action IS NOT excluded.next_action OR tasks.notes IS NOT excluded.notes OR
       tasks.source IS NOT excluded.source OR tasks.external_key IS NOT excluded.external_key OR
       tasks.extra_json IS NOT excluded.extra_json OR tasks.archived IS NOT excluded.archived OR
       tasks.deleted_at IS NOT excluded.deleted_at
     )`
  ).bind(
    id,
    user.id,
    nextValues.project_id,
    nextValues.title,
    nextValues.description,
    nextValues.status,
    nextValues.priority,
    nextValues.due_date,
    nextValues.start_date,
    nextValues.completed_at,
    nextValues.next_action,
    nextValues.notes,
    Number(existing?.sort_order ?? 0),
    null,
    nextValues.source,
    nextValues.external_key,
    nextValues.extra_json,
    0,
    createdAt,
    timestamp,
    null,
    1,
    user.id
  );
  return { statement, created: !existing };
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  let body: ImportBody;
  try {
    body = await readJson<ImportBody>(context.request, 1_000_000);
  } catch {
    return apiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "Invalid import payload");

  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_REQUEST) {
    return apiError(400, `Import request must contain up to ${MAX_ROWS_PER_REQUEST} rows`);
  }
  if (!rows.every(importRowIsBounded)) return apiError(400, "Import contains an invalid or oversized row");
  if (body.mode !== undefined && body.mode !== "create_or_update") return apiError(400, "Unsupported import mode");
  if (body.filename !== undefined && (typeof body.filename !== "string" || body.filename.length > 250)) {
    return apiError(400, "Import filename is invalid");
  }

  const batchId = crypto.randomUUID();
  const timestamp = nowIso();
  let skipped = 0;
  const writes: PlannedWrite[] = [];
  const projectCache = new Map<string, ProjectPlan>();

  for (const row of rows) {
    if (!nullableText(row.title)) {
      skipped += 1;
      continue;
    }
    const project = await planProject(context, user, row.project ?? "", timestamp, projectCache);
    if (project.statement && !writes.some((write) => write.statement === project.statement)) {
      writes.push({ statement: project.statement });
    }
    const task = await planTask(context, user, row, project.id || null, timestamp);
    if (task.statement) writes.push({ statement: task.statement, task: { created: task.created } });
  }

  if (writes.length === 0) {
    return json({ ok: true, batchId, created: 0, updated: 0, skipped });
  }

  const operationId = crypto.randomUUID();
  const statements = [
    ensureSyncStateStatement(context.env, user.id),
    ...writes.map((write) => write.statement),
    advanceSyncSequenceIfTouchedStatement(context.env, user.id, timestamp, operationId)
  ];
  if (excelAutosyncEnabled(context)) {
    statements.push(markExcelDirtyForOperationStatement(context.env, user.id, timestamp, operationId));
  }

  let results: D1Result<unknown>[];
  try {
    results = await context.env.DB.batch(statements);
  } catch (error) {
    return apiError(500, error instanceof Error ? error.message : "Import failed");
  }

  let created = 0;
  let updated = 0;
  for (let index = 0; index < writes.length; index += 1) {
    const task = writes[index].task;
    if (!task) continue;
    if (Number(results[index + 1]?.meta?.changes ?? 0) === 0) {
      skipped += 1;
    } else if (task.created) {
      created += 1;
    } else {
      updated += 1;
    }
  }

  return json({ ok: true, batchId, created, updated, skipped });
}
