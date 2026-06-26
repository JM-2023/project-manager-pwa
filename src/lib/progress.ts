import type { Task, TaskPriority, TaskStatus } from "./types";

export type TaskProgress = 0 | 25 | 50 | 75 | 100;
export type TaskImportance = 1 | 2 | 3 | 4;

const PROGRESS_VALUES: TaskProgress[] = [0, 25, 50, 75, 100];

export interface ProgressSummary {
  taskCount: number;
  totalWeight: number;
  weightedPoints: number;
  weightedPercent: number;
  simplePercent: number;
  corePercent: number;
  outputCount: number;
  blockedCount: number;
  judgement: string;
}

export interface WorklogOverview {
  recordDays: number;
  taskCount: number;
  averageProgress: number;
  outputDays: number;
  firstDate: string | null;
  lastDate: string | null;
}

export function normalizeProgressPercent(value: unknown): TaskProgress | null {
  const text = String(value ?? "").trim().replace("%", "");
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return PROGRESS_VALUES.reduce((best, candidate) => (Math.abs(candidate - percent) < Math.abs(best - percent) ? candidate : best), 0);
}

export function parseTaskExtra(task: Pick<Task, "extra_json">): Record<string, unknown> {
  if (!task.extra_json) {
    return {};
  }
  try {
    const parsed = JSON.parse(task.extra_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isProjectCacheTask(task: Pick<Task, "source" | "extra_json" | "start_date">): boolean {
  const extra = parseTaskExtra(task);
  return task.source === "project_cache" || extra.cache_item === true || extra.source_sheet === "项目缓存";
}

export function isWorklogTask(task: Task): boolean {
  return !task.deleted_at && task.archived === 0 && !isProjectCacheTask(task) && Boolean(task.title);
}

export function stringifyTaskExtra(extra: Record<string, unknown>): string | null {
  const clean = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined && value !== ""));
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

export function normalizeImportance(value: unknown): TaskImportance | null {
  const numeric = Number(String(value ?? "").trim());
  if (numeric === 1 || numeric === 2 || numeric === 3 || numeric === 4) {
    return numeric;
  }
  return null;
}

export function progressFromStatus(status: TaskStatus): TaskProgress {
  if (status === "done") return 100;
  if (status === "doing") return 50;
  if (status === "waiting" || status === "blocked") return 25;
  return 0;
}

export function getTaskProgress(task: Task): TaskProgress {
  const extra = parseTaskExtra(task);
  const fromExtra =
    normalizeProgressPercent(extra.progress_percent) ??
    normalizeProgressPercent(extra.progressPercent) ??
    normalizeProgressPercent(extra.Progress) ??
    normalizeProgressPercent(extra.progress) ??
    normalizeProgressPercent(extra["进度"]) ??
    normalizeProgressPercent(extra["核心任务进度"]);
  return fromExtra ?? progressFromStatus(task.status);
}

export function hasExplicitProgress(task: Task): boolean {
  const extra = parseTaskExtra(task);
  return (
    normalizeProgressPercent(extra.progress_percent) !== null ||
    normalizeProgressPercent(extra.progressPercent) !== null ||
    normalizeProgressPercent(extra.Progress) !== null ||
    normalizeProgressPercent(extra.progress) !== null ||
    normalizeProgressPercent(extra["进度"]) !== null ||
    normalizeProgressPercent(extra["核心任务进度"]) !== null
  );
}

export function getTaskImportance(task: Task): TaskImportance {
  const extra = parseTaskExtra(task);
  const fromExtra =
    normalizeImportance(extra.importance) ??
    normalizeImportance(extra["重要程度"]) ??
    normalizeImportance(extra.priority_number) ??
    normalizeImportance(extra.priorityNumber);
  if (fromExtra) {
    return fromExtra;
  }
  const fallback: Record<TaskPriority, TaskImportance> = {
    urgent: 1,
    high: 1,
    medium: 2,
    low: 3
  };
  return fallback[task.priority];
}

export function importancePriority(importance: TaskImportance): TaskPriority {
  const mapping: Record<TaskImportance, TaskPriority> = {
    1: "urgent",
    2: "high",
    3: "medium",
    4: "low"
  };
  return mapping[importance];
}

export function progressStatus(progress: TaskProgress): TaskStatus {
  if (progress === 100) return "done";
  if (progress === 0) return "todo";
  return "doing";
}

export function priorityBand(priority: TaskPriority): "low" | "medium" | "high" {
  return priority === "low" ? "low" : priority === "medium" ? "medium" : "high";
}

export function importanceWeight(importance: TaskImportance): number {
  return {
    1: 3,
    2: 2,
    3: 1,
    4: 0.5
  }[importance];
}

export function taskWeight(task: Task): number {
  return importanceWeight(getTaskImportance(task));
}

export function worklogOutput(task: Task): string {
  const extra = parseTaskExtra(task);
  return String(extra.daily_output ?? extra.output ?? extra["今日产出"] ?? "").trim();
}

export function worklogBlocker(task: Task): string {
  const extra = parseTaskExtra(task);
  return String(extra.blocker ?? extra.blocked ?? extra["卡住的地方"] ?? "").trim();
}

export function progressLabel(progress: number): string {
  return `${Math.round(progress)}%`;
}

export function summarizeProgress(tasks: Task[]): ProgressSummary {
  const activeTasks = tasks.filter((task) => !task.deleted_at && task.archived === 0 && task.status !== "cancelled");
  const totalWeight = activeTasks.reduce((total, task) => total + taskWeight(task), 0);
  const weightedPoints = activeTasks.reduce((total, task) => total + taskWeight(task) * getTaskProgress(task), 0);
  const simplePoints = activeTasks.reduce((total, task) => total + getTaskProgress(task), 0);
  const coreTasks = activeTasks.filter((task) => getTaskImportance(task) === 1);
  const corePoints = coreTasks.reduce((total, task) => total + getTaskProgress(task), 0);
  const outputCount = activeTasks.filter((task) => worklogOutput(task)).length;
  const blockedCount = activeTasks.filter((task) => worklogBlocker(task)).length;
  const corePercent = coreTasks.length > 0 ? Math.round(corePoints / coreTasks.length) : 0;
  const weightedPercent = totalWeight > 0 ? Math.round(weightedPoints / totalWeight) : 0;
  return {
    taskCount: activeTasks.length,
    totalWeight,
    weightedPoints,
    weightedPercent,
    simplePercent: activeTasks.length > 0 ? Math.round(simplePoints / activeTasks.length) : 0,
    corePercent,
    outputCount,
    blockedCount,
    judgement:
      blockedCount > 0
        ? "有卡点"
        : (activeTasks.length > 0 && coreTasks.length === 0) || corePercent >= 75
          ? "核心推进好"
          : outputCount > 0
            ? "有产出"
            : "低推进"
  };
}

function daysBetweenInclusive(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
    return 0;
  }
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
}

export function summarizeWorklogOverview(tasks: Task[]): WorklogOverview {
  const worklogTasks = tasks.filter(isWorklogTask);
  const datedTasks = worklogTasks.filter((task) => task.start_date);
  const dates = datedTasks.map((task) => task.start_date as string).sort();
  const firstDate = dates[0] ?? null;
  const lastDate = dates[dates.length - 1] ?? null;
  const progressedTasks = worklogTasks.filter(hasExplicitProgress);
  const averageProgress =
    progressedTasks.length > 0
      ? Math.round(progressedTasks.reduce((total, task) => total + getTaskProgress(task), 0) / progressedTasks.length)
      : 0;
  const outputDates = new Set(datedTasks.filter((task) => worklogOutput(task)).map((task) => task.start_date as string));

  return {
    recordDays: firstDate && lastDate ? daysBetweenInclusive(firstDate, lastDate) : 0,
    taskCount: worklogTasks.length,
    averageProgress,
    outputDays: outputDates.size,
    firstDate,
    lastDate
  };
}
