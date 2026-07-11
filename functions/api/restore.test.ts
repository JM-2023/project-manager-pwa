import { describe, expect, it } from "vitest";
import type { AppContext } from "./_utils/types";
import { onRequestPost } from "./restore";

interface CapturedStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => CapturedStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
}

interface RestoreContextOptions {
  writeError?: string;
  ledgerRaceError?: string;
  completedChunk?: { projects: number; tasks: number; nextProjects: number; nextIdeas: number };
  completedAfterBatchError?: { projects: number; tasks: number; nextProjects: number; nextIdeas: number };
}

function restoreContext(body: Record<string, unknown>, options: RestoreContextOptions = {}): {
  context: AppContext;
  statements: CapturedStatement[];
  batches: CapturedStatement[][];
} {
  const statements: CapturedStatement[] = [];
  const batches: CapturedStatement[][] = [];
  const user = { id: "user-1", email: "owner@example.com", display_name: "owner" };
  let batchFailed = false;
  const prepare = (sql: string): CapturedStatement => {
    const statement: CapturedStatement = {
      sql,
      args: [],
      bind: (...args: unknown[]) => {
        statement.args = args;
        return statement;
      },
      first: async <T>() => {
        if (sql.startsWith("SELECT id, email, display_name FROM users")) return user as T;
        if (sql.includes("FROM processed_restore_chunks")) {
          return ((batchFailed ? options.completedAfterBatchError : options.completedChunk) ?? null) as T | null;
        }
        return null;
      },
      run: async () => ({ success: true, meta: { changes: 1 } })
    };
    statements.push(statement);
    return statement;
  };
  const DB = {
    prepare,
    batch: async (batch: CapturedStatement[]) => {
      batches.push(batch);
      if (options.ledgerRaceError && batch.some((statement) => statement.sql.includes("INSERT INTO processed_restore_chunks"))) {
        batchFailed = true;
        throw new Error(options.ledgerRaceError);
      }
      if (options.writeError && batch.some((statement) => statement.sql.includes("INSERT INTO tasks ("))) {
        batchFailed = true;
        throw new Error(options.writeError);
      }
      return batch.map((statement) => ({
        success: true,
        results: statement.sql.startsWith("SELECT id, user_id, deleted_at") ? [] : undefined,
        meta: { changes: 1 }
      }));
    }
  };
  const context = {
    request: new Request("https://app.example.com/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
      body: JSON.stringify(body)
    }),
    waitUntil: () => undefined,
    env: { AUTH_MODE: "none", OWNER_EMAIL: user.email, DB }
  } as unknown as AppContext;
  return { context, statements, batches };
}

describe("restore normalization", () => {
  it("restores live parent-first rows and discards tombstones and migration provenance", async () => {
    const { context, statements } = restoreContext({
      projects: [{ id: "project-1", name: "Project", sort_order: 1e308, version: 1e308, deleted_at: "forged" }],
      tasks: [
        { id: "task-child", project_id: "project-1", parent_task_id: "task-parent", title: "Child", deleted_at: "forged" },
        { id: "task-parent", project_id: "project-1", title: "Parent", deleted_at: "forged" }
      ],
      nextProjects: [{ id: "next-project-1", name: "Next", source_project_id: "foreign-project", deleted_at: "forged" }],
      nextIdeas: [{
        id: "next-idea-1",
        next_project_id: "next-project-1",
        title: "Idea",
        source_task_id: "foreign-task",
        deleted_at: "forged"
      }]
    });
    const response = await onRequestPost(context);
    const project = statements.find((statement) => statement.sql.includes("INSERT INTO projects ("))!;
    const tasks = statements.filter((statement) => statement.sql.includes("INSERT INTO tasks ("));
    const nextProject = statements.find((statement) => statement.sql.includes("INSERT INTO next_projects ("))!;
    const nextIdea = statements.find((statement) => statement.sql.includes("INSERT INTO next_ideas ("))!;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ projects: 1, tasks: 2, nextProjects: 1, nextIdeas: 1 });
    expect(tasks.map((statement) => statement.args[0])).toEqual(["task-parent", "task-child"]);
    expect(project.args[5]).toBe(0);
    expect(project.args[9]).toBeNull();
    expect(project.args[10]).toBe(1);
    expect(tasks.every((statement) => statement.args[20] === null)).toBe(true);
    expect(nextProject.args[6]).toBeNull();
    expect(nextProject.args[10]).toBeNull();
    expect(nextIdea.args[6]).toBeNull();
    expect(nextIdea.args[10]).toBeNull();
    for (const statement of [project, ...tasks, nextProject, nextIdea]) {
      expect(statement.args).toHaveLength(statement.sql.match(/\?/g)?.length ?? 0);
    }
  });

  it("reports a parent-cycle race as a restore conflict", async () => {
    const { context } = restoreContext({
      tasks: [
        { id: "task-parent", title: "Parent" },
        { id: "task-child", parent_task_id: "task-parent", title: "Child" }
      ]
    }, { writeError: "task parent cycle" });

    const response = await onRequestPost(context);
    expect(response.status).toBe(409);
  });

  it("stores the stable chunk result in the same batch before restore writes", async () => {
    const { context, batches } = restoreContext({
      restoreId: "restore-1",
      chunkIndex: 3,
      projects: [{ id: "project-1", name: "Project" }],
      tasks: [{ id: "task-1", project_id: "project-1", title: "Task" }]
    });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ projects: 1, tasks: 1, nextProjects: 0, nextIdeas: 0 });
    expect(batches).toHaveLength(2);
    const writeBatch = batches[1];
    expect(writeBatch[0].sql).toContain("INSERT INTO processed_restore_chunks");
    expect(writeBatch[0].args.slice(0, 7)).toEqual(["user-1", "restore-1", 3, 1, 1, 0, 0]);
    expect(writeBatch.findIndex((statement) => statement.sql.includes("INSERT INTO processed_restore_chunks")))
      .toBeLessThan(writeBatch.findIndex((statement) => statement.sql.includes("INSERT INTO projects (")));
  });

  it("returns a completed chunk before validating or replaying its payload", async () => {
    const completedChunk = { projects: 2, tasks: 4, nextProjects: 1, nextIdeas: 3 };
    const { context, batches } = restoreContext({
      restoreId: "restore-1",
      chunkIndex: 3,
      projects: "this retry body is ignored"
    }, { completedChunk });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(completedChunk);
    expect(batches).toHaveLength(0);
  });

  it("turns a concurrent ledger-key loss into the winner's original response", async () => {
    const completedAfterBatchError = { projects: 1, tasks: 0, nextProjects: 0, nextIdeas: 0 };
    const { context, batches } = restoreContext({
      restoreId: "restore-race",
      chunkIndex: 0,
      projects: [{ id: "project-1", name: "Project" }]
    }, { ledgerRaceError: "UNIQUE constraint failed", completedAfterBatchError });

    const response = await onRequestPost(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(completedAfterBatchError);
    expect(batches.some((batch) => batch[0]?.sql.includes("INSERT INTO processed_restore_chunks"))).toBe(true);
  });

  it("rejects a partial or malformed restore chunk identity", async () => {
    const partial = restoreContext({ restoreId: "restore-1", projects: [{ id: "project-1" }] });
    const malformed = restoreContext({ restoreId: "bad id", chunkIndex: -1, projects: [{ id: "project-1" }] });

    expect((await onRequestPost(partial.context)).status).toBe(400);
    expect((await onRequestPost(malformed.context)).status).toBe(400);
    expect(partial.batches).toHaveLength(0);
    expect(malformed.batches).toHaveLength(0);
  });
});
