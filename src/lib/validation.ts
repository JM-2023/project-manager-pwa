import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "./types";

export function normalizeStatus(value: unknown): TaskStatus {
  const text = String(value ?? "").trim().toLowerCase();
  const statusMap: Record<string, TaskStatus> = {
    inbox: "inbox",
    todo: "todo",
    "to do": "todo",
    待办: "todo",
    doing: "doing",
    "in progress": "doing",
    进行中: "doing",
    waiting: "waiting",
    等待: "waiting",
    blocked: "blocked",
    卡住: "blocked",
    done: "done",
    complete: "done",
    completed: "done",
    完成: "done",
    cancelled: "cancelled",
    canceled: "cancelled",
    取消: "cancelled"
  };

  if (TASK_STATUSES.includes(text as TaskStatus)) {
    return text as TaskStatus;
  }

  return statusMap[text] ?? "todo";
}

export function normalizePriority(value: unknown): TaskPriority {
  const text = String(value ?? "").trim().toLowerCase();
  const priorityMap: Record<string, TaskPriority> = {
    low: "low",
    低: "low",
    medium: "medium",
    normal: "medium",
    中: "medium",
    high: "high",
    高: "high",
    urgent: "urgent",
    紧急: "urgent",
    "1": "urgent",
    "2": "high",
    "3": "medium",
    "4": "low"
  };

  if (TASK_PRIORITIES.includes(text as TaskPriority)) {
    return text as TaskPriority;
  }

  return priorityMap[text] ?? "medium";
}

export function statusFromProgress(progress: unknown, blocker?: unknown): TaskStatus {
  if (String(blocker ?? "").trim()) {
    return "blocked";
  }

  if (typeof progress === "number") {
    if (progress >= 1) return "done";
    if (progress > 0) return "doing";
    return "todo";
  }

  const text = String(progress ?? "").trim().replace("%", "");
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    const normalized = numeric > 1 ? numeric / 100 : numeric;
    if (normalized >= 1) return "done";
    if (normalized > 0) return "doing";
  }

  return "todo";
}

export function priorityLabel(priority: TaskPriority): string {
  return {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent"
  }[priority];
}

export function statusLabel(status: TaskStatus): string {
  return {
    inbox: "Inbox",
    todo: "To do",
    doing: "Doing",
    waiting: "Waiting",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled"
  }[status];
}

export function priorityScore(priority: TaskPriority): number {
  return {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3
  }[priority];
}
