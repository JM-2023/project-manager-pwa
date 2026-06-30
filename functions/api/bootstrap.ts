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
  // task_tags now carries updated_at (migration 0003), stamped on every add /
  // remove / re-add. A single `updated_at > cursor` therefore catches re-links
  // that the old created_at/deleted_at cursor silently dropped.
  const taskTagsQuery = cursor
    ? "SELECT * FROM task_tags WHERE user_id = ? AND updated_at > ?"
    : "SELECT * FROM task_tags WHERE user_id = ?";

  // Next data is small and uses hard deletes (no tombstones), so we always
  // return the full live set — never the incremental cursor — so a delete on one
  // device propagates as a clean absence on the next bootstrap everywhere.
  const nextProjectsQuery =
    "SELECT * FROM next_projects WHERE user_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY sort_order, name";
  const nextIdeasQuery = "SELECT * FROM next_ideas WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at";

  const bindings = cursor ? [user.id, cursor, cursor] : [user.id];
  const [projects, tasks, tags, taskTags, nextProjects, nextIdeas, settings] = await Promise.all([
    context.env.DB.prepare(projectsQuery).bind(...bindings).all(),
    context.env.DB.prepare(tasksQuery).bind(...bindings).all(),
    context.env.DB.prepare(tagsQuery).bind(...bindings).all(),
    cursor
      ? context.env.DB.prepare(taskTagsQuery).bind(user.id, cursor).all()
      : context.env.DB.prepare(taskTagsQuery).bind(user.id).all(),
    context.env.DB.prepare(nextProjectsQuery).bind(user.id).all(),
    context.env.DB.prepare(nextIdeasQuery).bind(user.id).all(),
    readSettings(context.env, user.id, cursor)
  ]);

  return json({
    serverTime,
    projects: projects.results,
    tasks: tasks.results,
    tags: tags.results,
    taskTags: taskTags.results,
    nextProjects: nextProjects.results,
    nextIdeas: nextIdeas.results,
    settings
  });
}
