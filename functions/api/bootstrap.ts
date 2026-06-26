import { authenticate, isResponse } from "./_utils/auth";
import { readSettings } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

function changedClause(since: string | null, column = "updated_at"): string {
  return since ? `AND (${column} > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))` : "";
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  const url = new URL(context.request.url);
  const since = url.searchParams.get("since");
  const serverTime = nowIso();

  const projectsQuery = `SELECT * FROM projects WHERE user_id = ? ${changedClause(since)} ORDER BY sort_order, name`;
  const tasksQuery = `SELECT * FROM tasks WHERE user_id = ? ${changedClause(since)} ORDER BY due_date, sort_order`;
  const tagsQuery = `SELECT * FROM tags WHERE user_id = ? ${changedClause(since)} ORDER BY name`;
  const taskTagsQuery = since
    ? "SELECT * FROM task_tags WHERE user_id = ? AND (created_at > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))"
    : "SELECT * FROM task_tags WHERE user_id = ?";

  const bindings = since ? [user.id, since, since] : [user.id];
  const [projects, tasks, tags, taskTags, settings] = await Promise.all([
    context.env.DB.prepare(projectsQuery).bind(...bindings).all(),
    context.env.DB.prepare(tasksQuery).bind(...bindings).all(),
    context.env.DB.prepare(tagsQuery).bind(...bindings).all(),
    since
      ? context.env.DB.prepare(taskTagsQuery).bind(user.id, since, since).all()
      : context.env.DB.prepare(taskTagsQuery).bind(user.id).all(),
    readSettings(context.env, user.id, since)
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
