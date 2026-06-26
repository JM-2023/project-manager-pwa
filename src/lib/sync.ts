import type { BootstrapResponse, Project, Tag, Task, TaskTag } from "./types";

const INTERNAL_SETTING_KEYS = new Set(["cloud_excel_latest"]);

export function sanitizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...settings };
  for (const key of INTERNAL_SETTING_KEYS) {
    delete clean[key];
  }
  return clean;
}

function mergeById<T extends { id: string; updated_at?: string }>(local: T[], incoming: T[]): T[] {
  const records = new Map(local.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = records.get(record.id);
    if (!existing || String(record.updated_at ?? "") >= String(existing.updated_at ?? "")) {
      records.set(record.id, record);
    }
  }
  return [...records.values()];
}

function taskTagId(tag: TaskTag): string {
  return `${tag.task_id}:${tag.tag_id}`;
}

function mergeTaskTags(local: TaskTag[], incoming: TaskTag[]): TaskTag[] {
  const records = new Map(local.map((record) => [taskTagId(record), record]));
  for (const record of incoming) {
    records.set(taskTagId(record), record);
  }
  return [...records.values()];
}

export function mergeBootstrap(
  current: Pick<BootstrapResponse, "projects" | "tasks" | "tags" | "taskTags" | "settings">,
  incoming: BootstrapResponse
): BootstrapResponse {
  return {
    serverTime: incoming.serverTime,
    projects: mergeById<Project>(current.projects, incoming.projects),
    tasks: mergeById<Task>(current.tasks, incoming.tasks),
    tags: mergeById<Tag>(current.tags, incoming.tags),
    taskTags: mergeTaskTags(current.taskTags, incoming.taskTags),
    settings: sanitizeSettings({ ...current.settings, ...incoming.settings })
  };
}

export function visibleTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.deleted_at && task.archived === 0);
}

export function visibleProjects(projects: Project[]): Project[] {
  return projects.filter((project) => !project.deleted_at && project.archived === 0);
}
