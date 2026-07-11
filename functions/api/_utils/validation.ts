export const TASK_STATUSES = ["inbox", "todo", "doing", "waiting", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function nullableText(value: unknown): string | null {
  const text = asText(value);
  return text || null;
}

export function asIntFlag(value: unknown): number {
  return value === 1 || value === true || value === "1" ? 1 : 0;
}

export function normalizeStatus(value: unknown): TaskStatus {
  const text = asText(value, "todo").toLowerCase();
  return TASK_STATUSES.includes(text as TaskStatus) ? (text as TaskStatus) : "todo";
}

export function normalizePriority(value: unknown): TaskPriority {
  const text = asText(value, "medium").toLowerCase();
  return TASK_PRIORITIES.includes(text as TaskPriority) ? (text as TaskPriority) : "medium";
}

export function assertUuidish(value: unknown): string {
  const text = asText(value);
  if (!text || text.length > 128) {
    return crypto.randomUUID();
  }
  return text;
}

export function normalizeDate(value: unknown): string | null {
  const text = asText(value);
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const exact = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(exact.getTime()) && exact.toISOString().slice(0, 10) === text ? text : null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function safeJsonString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(value);
}
