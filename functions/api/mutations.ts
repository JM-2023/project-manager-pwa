import { authenticate, isResponse } from "./_utils/auth";
import { INTERNAL_SETTING_KEYS } from "./_utils/db";
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

// A plan is the work for one mutation computed up front (reads done, writes
// deferred). The deferred writes from the whole batch run in a single atomic
// D1 transaction (see onRequestPost), so a mid-batch failure can never leave a
// half-applied state (e.g. a project purge that dropped tasks but not the
// project). Conflicts and already-idempotent mutations carry no statements.
interface MutationPlan {
  result: Applied | Conflict;
  statements: D1PreparedStatement[];
}

const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";

// The idempotency ledger only needs to cover redelivery windows (a keepalive
// beacon followed by the next sync), so entries older than this are dead weight
// and get pruned opportunistically after each write batch.
const PROCESSED_MUTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Records a client mutation id as processed so a re-delivered batch is a no-op. */
function recordProcessed(context: AppContext, userId: string, mutationId: string, timestamp: string): D1PreparedStatement {
  return context.env.DB.prepare(
    "INSERT INTO processed_mutations (id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING"
  ).bind(mutationId, userId, timestamp);
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
  const id = String(mutation.data.id ?? "");
  if (!id) {
    return null;
  }
  const table = {
    project: "projects",
    task: "tasks",
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

function planNextProject(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): MutationPlan {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const statement = context.env.DB.prepare(
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
  ).bind(
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
  );
  return {
    result: { id: mutation.id, entity: "next_project", recordId: id, version, updated_at: timestamp },
    statements: [statement]
  };
}

async function nextProjectExists(context: AppContext, user: AuthUser, nextProjectId: string): Promise<boolean> {
  const parent = await context.env.DB.prepare("SELECT id FROM next_projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(user.id, nextProjectId)
    .first<{ id: string }>();
  return Boolean(parent);
}

async function planNextIdea(
  context: AppContext,
  user: AuthUser,
  mutation: IncomingMutation,
  existing: Record<string, unknown> | null,
  timestamp: string
): Promise<MutationPlan> {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const nextProjectId = String(data.next_project_id ?? existing?.next_project_id ?? "");
  // A missing parent is a *permanent* conflict. The parent was purged through
  // a hard delete, so retrying this idea upsert can never succeed. Returning
  // permanent lets the client drop it and keeps the queue clean.
  if (!nextProjectId) {
    return { result: { id: mutation.id, entity: "next_idea", recordId: id, reason: "Next idea requires next_project_id", permanent: true }, statements: [] };
  }
  if (!(await nextProjectExists(context, user, nextProjectId))) {
    return { result: { id: mutation.id, entity: "next_idea", recordId: id, reason: "Next project not found", permanent: true }, statements: [] };
  }
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const title = typeof data.title === "string" ? data.title.trim() : String(existing?.title ?? "");
  const statement = context.env.DB.prepare(
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
  ).bind(
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
  );
  return { result: { id: mutation.id, entity: "next_idea", recordId: id, version, updated_at: timestamp }, statements: [statement] };
}

function planProject(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): MutationPlan {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const statement = context.env.DB.prepare(
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
  ).bind(
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
  );
  return { result: { id: mutation.id, entity: "project", recordId: id, version, updated_at: timestamp }, statements: [statement] };
}

function planTask(context: AppContext, user: AuthUser, mutation: IncomingMutation, existing: Record<string, unknown> | null, timestamp: string): MutationPlan {
  const data = mutation.data;
  const id = assertUuidish(data.id);
  const version = nextVersion(existing);
  const createdAt = String(existing?.created_at ?? data.created_at ?? timestamp);
  const title = typeof data.title === "string" ? data.title.trim() : String(existing?.title ?? "");
  const statement = context.env.DB.prepare(
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
  ).bind(
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
  );
  return { result: { id: mutation.id, entity: "task", recordId: id, version, updated_at: timestamp }, statements: [statement] };
}

function planSetting(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): MutationPlan {
  const key = String(mutation.data.key ?? mutation.data.id ?? "");
  const statement = context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).bind(user.id, key, JSON.stringify(mutation.data.value ?? null), timestamp);
  return { result: { id: mutation.id, entity: "setting", recordId: key, updated_at: timestamp }, statements: [statement] };
}

/** Deletes are tombstones (soft delete) so they converge like any other edit. */
function planDelete(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): MutationPlan {
  const id = String(mutation.data.id ?? "");
  if (mutation.entity === "setting") {
    const statement = context.env.DB.prepare("DELETE FROM app_settings WHERE user_id = ? AND key = ?").bind(user.id, id);
    return { result: { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp }, statements: [statement] };
  }

  if (mutation.entity === "next_project") {
    return {
      result: { id: mutation.id, entity: "next_project", recordId: id, updated_at: timestamp },
      statements: [
        context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND next_project_id = ?").bind(user.id, id),
        context.env.DB.prepare("DELETE FROM next_projects WHERE user_id = ? AND id = ?").bind(user.id, id)
      ]
    };
  }

  if (mutation.entity === "next_idea") {
    const statement = context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND id = ?").bind(user.id, id);
    return { result: { id: mutation.id, entity: "next_idea", recordId: id, updated_at: timestamp }, statements: [statement] };
  }

  const table = { project: "projects", task: "tasks" }[mutation.entity];
  if (!table) {
    return { result: { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp }, statements: [] };
  }
  const statement = context.env.DB.prepare(
    `UPDATE ${table} SET deleted_at = ?, updated_at = ?, version = version + 1, archived = 1 WHERE user_id = ? AND id = ?`
  ).bind(timestamp, timestamp, user.id, id);
  return { result: { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp }, statements: [statement] };
}

/**
 * Hard delete — the one place this server removes rows instead of tombstoning.
 * A project purge cascades to its tasks. This trades the tombstone convergence
 * guarantee for a real delete, so other live devices only catch up on their
 * next full-replace bootstrap (which they run on app start). Cascade statements
 * are ordered so child rows go before parents and all run in the same atomic
 * batch.
 */
function planPurge(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): MutationPlan {
  const id = String(mutation.data.id ?? "");
  if (!id) {
    return { result: { id: mutation.id, entity: mutation.entity, reason: "Record id is required", permanent: true }, statements: [] };
  }

  if (mutation.entity === "project") {
    return {
      result: { id: mutation.id, entity: "project", recordId: id, updated_at: timestamp },
      statements: [
        context.env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND project_id = ?").bind(user.id, id),
        context.env.DB.prepare("DELETE FROM projects WHERE user_id = ? AND id = ?").bind(user.id, id)
      ]
    };
  }

  if (mutation.entity === "task") {
    const statement = context.env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").bind(user.id, id);
    return { result: { id: mutation.id, entity: "task", recordId: id, updated_at: timestamp }, statements: [statement] };
  }

  if (mutation.entity === "next_project") {
    return {
      result: { id: mutation.id, entity: "next_project", recordId: id, updated_at: timestamp },
      statements: [
        context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND next_project_id = ?").bind(user.id, id),
        context.env.DB.prepare("DELETE FROM next_projects WHERE user_id = ? AND id = ?").bind(user.id, id)
      ]
    };
  }

  if (mutation.entity === "next_idea") {
    const statement = context.env.DB.prepare("DELETE FROM next_ideas WHERE user_id = ? AND id = ?").bind(user.id, id);
    return { result: { id: mutation.id, entity: "next_idea", recordId: id, updated_at: timestamp }, statements: [statement] };
  }

  return { result: { id: mutation.id, entity: mutation.entity, recordId: id, updated_at: timestamp }, statements: [] };
}

/** Exported for tests. */
export async function planMutation(context: AppContext, user: AuthUser, mutation: IncomingMutation, timestamp: string): Promise<MutationPlan> {
  // "tag" / "task_tag" are gone (feature removed); a stale client still sending
  // them gets a permanent conflict so its queue drains cleanly.
  if (
    !["project", "task", "setting", "next_project", "next_idea"].includes(mutation.entity) ||
    !["upsert", "delete", "purge"].includes(mutation.operation)
  ) {
    return { result: { id: mutation.id, entity: mutation.entity, reason: "Unsupported mutation", permanent: true }, statements: [] };
  }

  // Reject malformed mutations up front as *permanent* conflicts the client can
  // drop. That keeps them out of the transient-error path where they would be
  // re-sent on every sync.
  if (mutation.entity === "setting" && !mutation.data.key && !mutation.data.id) {
    return { result: { id: mutation.id, entity: mutation.entity, reason: "Setting key is required", permanent: true }, statements: [] };
  }
  // Server-owned settings (passcode hash, session generation, cloud Excel
  // pointer) are invisible to clients — readSettings never returns them — so a
  // mutation naming one is crafted, not organic sync traffic. Check both `key`
  // and `id`: planSetting resolves the row from either, planDelete from `id`.
  if (
    mutation.entity === "setting" &&
    [mutation.data.key, mutation.data.id].some((value) => INTERNAL_SETTING_KEYS.has(String(value ?? "")))
  ) {
    return { result: { id: mutation.id, entity: mutation.entity, reason: "Reserved setting key", permanent: true }, statements: [] };
  }
  if (mutation.entity === "next_idea" && mutation.operation === "upsert" && !mutation.data.next_project_id) {
    return { result: { id: mutation.id, entity: mutation.entity, reason: "Next idea requires next_project_id", permanent: true }, statements: [] };
  }

  if (mutation.operation === "purge") {
    return planPurge(context, user, mutation, timestamp);
  }

  if (mutation.operation === "delete") {
    return planDelete(context, user, mutation, timestamp);
  }

  // Soft-deleted / archived rows are ordinary tombstone upserts — they must be
  // stored (not removed) so every device converges to the deleted/archived state.
  const existing = await findExisting(context, user, mutation);
  if (mutation.entity === "project") return planProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "task") return planTask(context, user, mutation, existing, timestamp);
  if (mutation.entity === "next_project") return planNextProject(context, user, mutation, existing, timestamp);
  if (mutation.entity === "next_idea") return planNextIdea(context, user, mutation, existing, timestamp);
  return planSetting(context, user, mutation, timestamp);
}

function isConflict(result: Applied | Conflict): result is Conflict {
  return "reason" in result;
}

/** Looks up which of the incoming mutation ids the server already applied. */
async function findProcessedIds(context: AppContext, user: AuthUser, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) {
    return new Set();
  }
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await context.env.DB.prepare(
    `SELECT id FROM processed_mutations WHERE user_id = ? AND id IN (${placeholders})`
  )
    .bind(user.id, ...unique)
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

function recordIdFor(mutation: IncomingMutation): string {
  if (mutation.entity === "setting") {
    return String(mutation.data.key ?? mutation.data.id ?? "");
  }
  return String(mutation.data.id ?? "");
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

  const timestamp = nowIso();
  const applied: Applied[] = [];
  const conflicts: Conflict[] = [];
  const writes: D1PreparedStatement[] = [];

  // Idempotency: skip any mutation id the server already applied in an earlier
  // delivery (e.g. a keepalive beacon followed by the next-load sync). Those are
  // reported back as applied so the client drains them, but emit no writes.
  const processedIds = await findProcessedIds(context, user, mutations.map((mutation) => mutation.id));
  const fresh = mutations.filter((mutation) => {
    if (processedIds.has(mutation.id)) {
      applied.push({ id: mutation.id, entity: mutation.entity, recordId: recordIdFor(mutation), updated_at: timestamp });
      return false;
    }
    return true;
  });

  // Build every plan up front (reads run concurrently), then commit all writes
  // in a single atomic D1 transaction so a mid-batch failure rolls everything
  // back instead of leaving a half-applied cascade.
  const plans = await Promise.all(
    fresh.map(async (mutation) => {
      try {
        return await planMutation(context, user, mutation, timestamp);
      } catch (error) {
        const conflict: Conflict = {
          id: mutation.id,
          entity: mutation.entity,
          recordId: String(mutation.data?.id ?? ""),
          reason: error instanceof Error ? error.message : "Mutation failed"
        };
        return { result: conflict, statements: [] } satisfies MutationPlan;
      }
    })
  );

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (isConflict(plan.result)) {
      conflicts.push(plan.result);
      continue;
    }
    applied.push(plan.result);
    writes.push(...plan.statements, recordProcessed(context, user.id, fresh[index].id, timestamp));
  }

  if (writes.length > 0) {
    try {
      await context.env.DB.batch(writes);
    } catch (error) {
      return apiError(500, error instanceof Error ? error.message : "Mutation batch failed");
    }
    // Only real writes mark the cloud Excel dirty; an idempotent re-delivery
    // (already-processed mutations, no writes) must not bounce the snapshot.
    await markExcelDirty(context, user, timestamp);

    // Prune expired idempotency entries without delaying the response.
    const cutoff = new Date(Date.parse(timestamp) - PROCESSED_MUTATION_TTL_MS).toISOString();
    context.waitUntil(
      context.env.DB.prepare("DELETE FROM processed_mutations WHERE created_at < ?").bind(cutoff).run()
    );
  }

  return json({ ok: true, serverTime: timestamp, applied, conflicts });
}
