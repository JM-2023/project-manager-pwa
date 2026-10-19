import { describe, expect, it } from "vitest";
import { isBlankTask, summarizeProgress } from "./progress";
import type { Task } from "./types";

function task(overrides: Partial<Task> = {}, extra: Record<string, unknown> = {}): Task {
  return {
    id: "task",
    title: "",
    status: "todo",
    priority: "medium",
    start_date: "2026-10-19",
    sort_order: 0,
    source: "app",
    extra_json: JSON.stringify({ importance: 2, progress_percent: 0, ...extra }),
    archived: 0,
    created_at: "2026-10-19T09:00:00.000Z",
    updated_at: "2026-10-19T09:00:00.000Z",
    version: 1,
    ...overrides
  };
}

describe("isBlankTask", () => {
  it("is a task nobody has written anything into", () => {
    expect(isBlankTask(task())).toBe(true);
    expect(isBlankTask(task({ title: "   " }))).toBe(true);
  });

  it("is not blank once any field or the progress has something", () => {
    expect(isBlankTask(task({ title: "Write report" }))).toBe(false);
    expect(isBlankTask(task({ notes: "call back" }))).toBe(false);
    expect(isBlankTask(task({ next_action: "draft" }))).toBe(false);
    expect(isBlankTask(task({}, { daily_output: "outline" }))).toBe(false);
    expect(isBlankTask(task({}, { blocker: "waiting on Lin" }))).toBe(false);
    expect(isBlankTask(task({}, { progress_percent: 25 }))).toBe(false);
  });
});

describe("summarizeProgress", () => {
  it("leaves blank leftovers out of the count and the weighted progress", () => {
    const summary = summarizeProgress([task({ id: "a" }), task({ id: "b", title: "Ship pricing page" }, { progress_percent: 50 })]);
    expect(summary.taskCount).toBe(1);
    expect(summary.weightedPercent).toBe(50);
  });
});
