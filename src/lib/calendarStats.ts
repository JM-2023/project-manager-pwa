import { toDateInput } from "./dates";
import { isProjectCacheTask, summarizeProgress } from "./progress";
import type { Task } from "./types";

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

/** Aggregate the buckets for every day in `dates`. */
export function statsForDays(buckets: Map<string, Task[]>, dates: string[]): PeriodStats {
  const tasks: Task[] = [];
  for (const date of dates) {
    const dayTasks = buckets.get(date);
    if (dayTasks) {
      tasks.push(...dayTasks);
    }
  }
  return statsForTasks(tasks);
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
