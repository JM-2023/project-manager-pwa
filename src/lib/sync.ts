import type { Project, Task } from "./types";

const INTERNAL_SETTING_KEYS = new Set([
  "cloud_excel_latest",
  "cloud_excel_metadata",
  "local_password_hash",
  "session_generation"
]);

export function sanitizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...settings };
  for (const key of INTERNAL_SETTING_KEYS) {
    delete clean[key];
  }
  return clean;
}

export function visibleTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.deleted_at && task.archived === 0);
}

export function visibleProjects(projects: Project[]): Project[] {
  return projects.filter((project) => !project.deleted_at && project.archived === 0);
}
