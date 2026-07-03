import { toDateInput } from "./dates";
import {
  getTaskImportance,
  isProjectCacheTask,
  summarizeProgress,
  taskWeight,
  worklogBlocker,
  worklogOutput,
  type TaskImportance
} from "./progress";
import type { Project, Task } from "./types";

export type CompletionMetric = "weighted" | "done";

/** Completion target used to tint days as on-track in the calendar views. */
export const COMPLETION_GOAL = 70;

export interface PeriodStats {
  taskCount: number;
  doneCount: number;
  /** Binary done / total ratio, 0-100. */
  doneRate: number;
  /** Importance-weighted progress, 0-100 (the app's headline metric). */
  weightedPercent: number;
  outputCount: number;
  blockedCount: number;
}

export const EMPTY_STATS: PeriodStats = {
  taskCount: 0,
  doneCount: 0,
  doneRate: 0,
  weightedPercent: 0,
  outputCount: 0,
  blockedCount: 0
};

/** The day a task is recorded against (its worklog date). */
export function taskRecordDate(task: Task): string {
  return toDateInput(task.start_date);
}

/** Same predicate the Today page uses to decide which tasks count toward a day. */
export function isCalendarTask(task: Task): boolean {
  if (task.deleted_at || task.archived || task.status === "cancelled") {
    return false;
  }
  if (isProjectCacheTask(task)) {
    return false;
  }
  return Boolean(taskRecordDate(task));
}

export function bucketTasksByDay(tasks: Task[]): Map<string, Task[]> {
  const buckets = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!isCalendarTask(task)) {
      continue;
    }
    const date = taskRecordDate(task);
    const existing = buckets.get(date);
    if (existing) {
      existing.push(task);
    } else {
      buckets.set(date, [task]);
    }
  }
  return buckets;
}

export function statsForTasks(tasks: Task[]): PeriodStats {
  if (tasks.length === 0) {
    return EMPTY_STATS;
  }
  const summary = summarizeProgress(tasks);
  const doneCount = tasks.filter((task) => task.status === "done").length;
  return {
    taskCount: summary.taskCount,
    doneCount,
    doneRate: summary.taskCount > 0 ? Math.round((doneCount / summary.taskCount) * 100) : 0,
    weightedPercent: summary.weightedPercent,
    outputCount: summary.outputCount,
    blockedCount: summary.blockedCount
  };
}

/** Flatten the buckets for every day in `dates` into one task list. */
export function tasksForDays(buckets: Map<string, Task[]>, dates: string[]): Task[] {
  const tasks: Task[] = [];
  for (const date of dates) {
    const dayTasks = buckets.get(date);
    if (dayTasks) {
      tasks.push(...dayTasks);
    }
  }
  return tasks;
}

/** Aggregate the buckets for every day in `dates`. */
export function statsForDays(buckets: Map<string, Task[]>, dates: string[]): PeriodStats {
  return statsForTasks(tasksForDays(buckets, dates));
}

export interface ProjectFocus {
  id: string;
  name: string;
  color: string | null;
  stats: PeriodStats;
  /** This project's share of the period's importance weight, 0-100. */
  weightShare: number;
}

/** UI-language fallback names for rows without a (known) project. */
export interface ProjectFocusLabels {
  noProject: string;
  unknownProject: string;
}

/** Per-project effort split for a period, heaviest weight share first. */
export function projectFocusForDays(
  buckets: Map<string, Task[]>,
  dates: string[],
  projects: Project[],
  labels: ProjectFocusLabels = { noProject: "No project", unknownProject: "Unknown project" }
): ProjectFocus[] {
  const tasks = tasksForDays(buckets, dates);
  if (tasks.length === 0) {
    return [];
  }
  const byProject = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.project_id ?? "";
    const existing = byProject.get(key);
    if (existing) {
      existing.push(task);
    } else {
      byProject.set(key, [task]);
    }
  }
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const totalWeight = tasks.reduce((total, task) => total + taskWeight(task), 0);
  const rows = Array.from(byProject.entries(), ([id, list]) => {
    const project = projectById.get(id);
    const weight = list.reduce((total, task) => total + taskWeight(task), 0);
    return {
      id: id || "none",
      name: project?.name ?? (id ? labels.unknownProject : labels.noProject),
      color: project?.color ?? null,
      stats: statsForTasks(list),
      weightShare: totalWeight > 0 ? (weight / totalWeight) * 100 : 0
    };
  });
  return rows.sort((a, b) => b.weightShare - a.weightShare || b.stats.taskCount - a.stats.taskCount || a.name.localeCompare(b.name));
}

export interface ImportanceBand {
  importance: TaskImportance;
  taskCount: number;
  /** Share of the period's tasks in this band, 0-100 (unrounded). */
  countShare: number;
  stats: PeriodStats;
}

export const IMPORTANCE_BANDS: TaskImportance[] = [1, 2, 3, 4];

/** How the period's tasks split across importance 1-4. */
export function importanceMixForDays(buckets: Map<string, Task[]>, dates: string[]): ImportanceBand[] {
  const tasks = tasksForDays(buckets, dates);
  return IMPORTANCE_BANDS.map((importance) => {
    const bandTasks = tasks.filter((task) => getTaskImportance(task) === importance);
    return {
      importance,
      taskCount: bandTasks.length,
      countShare: tasks.length > 0 ? (bandTasks.length / tasks.length) * 100 : 0,
      stats: statsForTasks(bandTasks)
    };
  });
}

export interface WorklogEntry {
  date: string;
  task: Task;
  /** The recorded output / blocker text. */
  text: string;
}

/** 今日产出 / 卡点 notes recorded across the period, most recent day first. */
export function worklogEntriesForDays(buckets: Map<string, Task[]>, dates: string[], kind: "output" | "blocker"): WorklogEntry[] {
  const read = kind === "output" ? worklogOutput : worklogBlocker;
  const entries: WorklogEntry[] = [];
  for (const date of [...dates].reverse()) {
    const dayTasks = buckets.get(date);
    if (!dayTasks) {
      continue;
    }
    const dayEntries = dayTasks
      .map((task) => ({ date, task, text: read(task) }))
      .filter((entry) => entry.text)
      .sort((a, b) => taskWeight(b.task) - taskWeight(a.task));
    entries.push(...dayEntries);
  }
  return entries;
}

export function completionValue(stats: PeriodStats, metric: CompletionMetric): number {
  return metric === "done" ? stats.doneRate : stats.weightedPercent;
}

export interface StreakInfo {
  current: number;
  longest: number;
}

/**
 * Walk an ascending list of days and measure runs where `isActive` holds.
 * `current` is the streak ending on the last entry (typically up to today).
 */
export function streakInfo(entries: Array<{ date: string; stats: PeriodStats }>, isActive: (stats: PeriodStats) => boolean): StreakInfo {
  let longest = 0;
  let running = 0;
  let current = 0;
  for (const entry of entries) {
    if (isActive(entry.stats)) {
      running += 1;
      longest = Math.max(longest, running);
      current = running;
    } else {
      running = 0;
      current = 0;
    }
  }
  return { current, longest };
}
