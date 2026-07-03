import { authenticate, isResponse } from "./_utils/auth";
import { readSettings } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  const [projects, tasks, nextProjects, nextIdeas, settings] = await Promise.all([
    context.env.DB.prepare("SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, name").bind(user.id).all(),
    context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY due_date, sort_order").bind(user.id).all(),
    context.env.DB.prepare("SELECT * FROM next_projects WHERE user_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY sort_order, name").bind(user.id).all(),
    context.env.DB.prepare("SELECT * FROM next_ideas WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at").bind(user.id).all(),
    readSettings(context.env, user.id, null)
  ]);

  return json({
    exportedAt: nowIso(),
    serverTime: nowIso(),
    projects: projects.results,
    tasks: tasks.results,
    nextProjects: nextProjects.results,
    nextIdeas: nextIdeas.results,
    settings
  });
}
