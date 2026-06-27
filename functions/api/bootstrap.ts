import { authenticate, isResponse } from "./_utils/auth";
import { readSettings } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

function changedClause(since: string | null, column = "updated_at"): string {
  return since ? `AND (${column} > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))` : "";
}

// The incremental cursor is a strict `> since`. A mutation whose server
// timestamp is <= the previous bootstrap's serverTime but whose write commits
// *after* that bootstrap read would be skipped by this round and then excluded
// forever by the strict cursor. Re-scan a short overlap window so any such late
// commit is still picked up; re-sending a handful of recent rows is a no-op on
// the client (the merge is keyed by id with last-writer-wins).
const CURSOR_OVERLAP_MS = 5000;

function sinceWithOverlap(since: string | null): string | null {
  if (!since) return null;
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) return since;
  return new Date(parsed - CURSOR_OVERLAP_MS).toISOString();
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  const url = new URL(context.request.url);
  const cursor = sinceWithOverlap(url.searchParams.get("since"));
  const serverTime = nowIso();

  const projectsQuery = `SELECT * FROM projects WHERE user_id = ? ${changedClause(cursor)} ORDER BY sort_order, name`;
  const tasksQuery = `SELECT * FROM tasks WHERE user_id = ? ${changedClause(cursor)} ORDER BY due_date, sort_order`;
  const tagsQuery = `SELECT * FROM tags WHERE user_id = ? ${changedClause(cursor)} ORDER BY name`;
  const taskTagsQuery = cursor
    ? "SELECT * FROM task_tags WHERE user_id = ? AND (created_at > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))"
    : "SELECT * FROM task_tags WHERE user_id = ?";

  const bindings = cursor ? [user.id, cursor, cursor] : [user.id];
  const [projects, tasks, tags, taskTags, settings] = await Promise.all([
    context.env.DB.prepare(projectsQuery).bind(...bindings).all(),
    context.env.DB.prepare(tasksQuery).bind(...bindings).all(),
    context.env.DB.prepare(tagsQuery).bind(...bindings).all(),
    cursor
      ? context.env.DB.prepare(taskTagsQuery).bind(user.id, cursor, cursor).all()
      : context.env.DB.prepare(taskTagsQuery).bind(user.id).all(),
    readSettings(context.env, user.id, cursor)
  ]);

  return json({
    serverTime,
    projects: projects.results,
    tasks: tasks.results,
    tags: tags.results,
    taskTags: taskTags.results,
    settings
  });
}
