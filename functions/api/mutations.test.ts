import { describe, expect, it } from "vitest";
import type { AppContext, AuthUser } from "./_utils/types";
import { orderMutationsParentFirst, planMutation, type IncomingMutation } from "./mutations";

// Minimal D1 stub: prepare().bind() returns an inspectable statement whose
// first() resolves to null (no existing row), which is all planMutation needs.
interface StubStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => StubStatement;
  first: () => Promise<Record<string, unknown> | null>;
}

function stubContext(existing: Record<string, unknown> | null = null): AppContext {
  const prepare = (sql: string): StubStatement => {
    const statement: StubStatement = {
      sql,
      args: [],
      bind: (...args: unknown[]) => ({ ...statement, args }),
      first: async () => existing
    };
    return statement;
  };
  return { env: { DB: { prepare } } } as unknown as AppContext;
}

const user: AuthUser = { id: "user-1", email: "owner@example.com", display_name: "owner" };
const timestamp = "2026-07-07T00:00:00.000Z";

function settingMutation(operation: IncomingMutation["operation"], data: Record<string, unknown>): IncomingMutation {
  return { id: `mutation-${operation}-${JSON.stringify(data)}`, entity: "setting", operation, data };
}

function expectAllPlaceholdersBound(statements: StubStatement[]): void {
  for (const statement of statements) {
    expect(statement.args).toHaveLength(statement.sql.match(/\?/g)?.length ?? 0);
  }
}

describe("internal settings keys are not writable through sync", () => {
  const reservedKeys = ["local_password_hash", "session_generation", "cloud_excel_latest", "cloud_excel_metadata", "excel_dirty_at"];

  it("rejects upserts targeting a reserved key as permanent conflicts", async () => {
    for (const key of reservedKeys) {
      const plan = await planMutation(stubContext(), user, settingMutation("upsert", { key, value: "x" }), timestamp);
      expect(plan.result).toMatchObject({ reason: "Reserved setting key", permanent: true });
      expect(plan.statements).toHaveLength(0);
    }
  });

  it("rejects deletes targeting a reserved key as permanent conflicts", async () => {
    for (const key of reservedKeys) {
      const plan = await planMutation(stubContext(), user, settingMutation("delete", { id: key }), timestamp);
      expect(plan.result).toMatchObject({ reason: "Reserved setting key", permanent: true });
      expect(plan.statements).toHaveLength(0);
    }
  });

  it("rejects a delete that hides the reserved key in `id` behind a harmless `key`", async () => {
    // planDelete resolves the row from data.id, so a mismatched pair must not
    // slip past a guard that only checks data.key.
    const plan = await planMutation(stubContext(), user, settingMutation("delete", { key: "theme", id: "local_password_hash" }), timestamp);
    expect(plan.result).toMatchObject({ reason: "Reserved setting key", permanent: true });
    expect(plan.statements).toHaveLength(0);
  });

  it("still applies ordinary setting upserts and deletes", async () => {
    const upsert = await planMutation(stubContext(), user, settingMutation("upsert", { key: "theme", value: "dark" }), timestamp);
    expect(upsert.result).toMatchObject({ recordId: "theme" });
    expect(upsert.statements).toHaveLength(1);
    expect((upsert.statements[0] as unknown as { args: unknown[] }).args).toContain("theme");

    const remove = await planMutation(stubContext(), user, settingMutation("delete", { id: "theme" }), timestamp);
    expect(remove.result).toMatchObject({ recordId: "theme" });
    expect(remove.statements).toHaveLength(1);
  });
});

describe("convergent mutation plans", () => {
  it("updates only fields named by a patch when the base version matches", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-task-patch",
      entity: "task",
      operation: "upsert",
      baseVersion: 4,
      data: { id: "task-1", title: "Local title", description: "stale description" },
      patch: { title: "Local title" }
    };
    const plan = await planMutation(
      stubContext({ id: "task-1", version: 4, deleted_at: null }),
      user,
      mutation,
      timestamp
    );
    const statement = plan.statements[0] as unknown as StubStatement;

    expect(plan.result).toMatchObject({ recordId: "task-1", rebased: false, serverVersion: 4 });
    expect(statement.sql).toContain("title = ?");
    expect(statement.sql).not.toContain("description = ?");
    expect(statement.sql).toContain("version = version + 1");
    expect(statement.sql).toContain("NOT EXISTS (SELECT 1 FROM processed_mutations");
    expectAllPlaceholdersBound([statement]);
  });

  it("validates unchanged relations from the server row instead of stale optimistic data", async () => {
    const task = await planMutation(
      stubContext({ id: "task-1", version: 4, deleted_at: null, project_id: "server-project" }),
      user,
      {
        id: "mutation-task-stale-project",
        entity: "task",
        operation: "upsert",
        baseVersion: 4,
        data: { id: "task-1", project_id: "stale-project", title: "Local title" },
        patch: { title: "Local title" }
      },
      timestamp,
      { knownProjectIds: new Set() }
    );
    const idea = await planMutation(
      stubContext({ id: "idea-1", version: 2, deleted_at: null, next_project_id: "server-next-project" }),
      user,
      {
        id: "mutation-idea-stale-project",
        entity: "next_idea",
        operation: "upsert",
        baseVersion: 2,
        data: { id: "idea-1", next_project_id: "stale-next-project", title: "Local idea" },
        patch: { title: "Local idea" }
      },
      timestamp,
      { knownNextProjectIds: new Set() }
    );
    const taskStatement = task.statements[0] as unknown as StubStatement;
    const ideaStatement = idea.statements[0] as unknown as StubStatement;

    expect(task.result).toMatchObject({ recordId: "task-1" });
    expect(taskStatement.args).toContain("server-project");
    expect(taskStatement.args).not.toContain("stale-project");
    expect(idea.result).toMatchObject({ recordId: "idea-1" });
    expect(ideaStatement.args).toContain("server-next-project");
    expect(ideaStatement.args).not.toContain("stale-next-project");
    expectAllPlaceholdersBound([taskStatement, ideaStatement]);
  });

  it("returns a retryable conflict before a stale patch can overwrite a newer value", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-stale-task-patch",
      entity: "task",
      operation: "upsert",
      baseVersion: 2,
      data: { id: "task-1", title: "Stale title" },
      patch: { title: "Stale title" }
    };
    const plan = await planMutation(
      stubContext({ id: "task-1", version: 4, deleted_at: null, title: "Current title" }),
      user,
      mutation,
      timestamp
    );

    expect(plan.result).toMatchObject({ reason: "Version conflict", permanent: false });
    expect(plan.statements).toHaveLength(0);
  });

  it("does not replay a delayed original create over a newer same-id row", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-delayed-create",
      entity: "project",
      operation: "upsert",
      baseVersion: null,
      data: { id: "project-1", name: "Old name", version: 1 }
    };
    const plan = await planMutation(
      stubContext({ id: "project-1", version: 3, deleted_at: null, name: "New name" }),
      user,
      mutation,
      timestamp
    );

    expect(plan.result).toMatchObject({ reason: "Record already exists", permanent: true });
    expect(plan.statements).toHaveLength(0);
  });

  it("allows a compacted local create with a newer local version to continue once", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-compacted-create",
      entity: "project",
      operation: "upsert",
      baseVersion: null,
      data: { id: "project-1", name: "Locally edited", version: 2 }
    };
    const plan = await planMutation(
      stubContext({ id: "project-1", version: 1, deleted_at: null, name: "Initial" }),
      user,
      mutation,
      timestamp
    );
    const statement = plan.statements[0] as unknown as StubStatement;

    expect(plan.result).toMatchObject({ recordId: "project-1" });
    expect(statement.sql).toContain("excluded.version > projects.version");
    expect(statement.args).toContain(2);
    expectAllPlaceholdersBound([statement]);
  });

  it("accepts a Next idea whose parent is created in the same request", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-next-idea",
      entity: "next_idea",
      operation: "upsert",
      baseVersion: null,
      data: { id: "idea-1", next_project_id: "next-project-1", title: "Idea" }
    };
    const plan = await planMutation(stubContext(), user, mutation, timestamp, {
      existingKnown: true,
      existing: null,
      plannedNextProjectIds: new Set(["next-project-1"]),
      knownNextProjectIds: new Set()
    });

    expect(plan.result).toMatchObject({ recordId: "idea-1" });
    expect(plan.statements).toHaveLength(1);
    expectAllPlaceholdersBound(plan.statements as unknown as StubStatement[]);
  });

  it("accepts a task whose formal project is created in the same request", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-task-with-new-parent",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: { id: "task-1", project_id: "project-1", title: "Task" }
    };
    const plan = await planMutation(stubContext(), user, mutation, timestamp, {
      existingKnown: true,
      existing: null,
      plannedProjectIds: new Set(["project-1"]),
      knownProjectIds: new Set()
    });

    expect(plan.result).toMatchObject({ recordId: "task-1" });
    expect(plan.statements).toHaveLength(1);
    expectAllPlaceholdersBound(plan.statements as unknown as StubStatement[]);
  });

  it("rejects a task upsert when its project is absent", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-task-orphan",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: { id: "task-1", project_id: "missing-project", title: "Task" }
    };
    const plan = await planMutation(stubContext(), user, mutation, timestamp, {
      existingKnown: true,
      existing: null,
      plannedProjectIds: new Set(),
      knownProjectIds: new Set()
    });

    expect(plan.result).toMatchObject({ reason: "Project not found", permanent: true });
    expect(plan.statements).toHaveLength(0);
  });

  it("accepts a task whose parent task is created later in the same request", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-child-task",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: { id: "task-child", parent_task_id: "task-parent", title: "Child" }
    };
    const plan = await planMutation(stubContext(), user, mutation, timestamp, {
      existingKnown: true,
      existing: null,
      plannedTaskIds: new Set(["task-parent", "task-child"]),
      knownTaskIds: new Set()
    });

    expect(plan.result).toMatchObject({ recordId: "task-child" });
    expect(plan.statements).toHaveLength(1);
    expect((plan.statements[0] as unknown as StubStatement).sql).toContain("WITH RECURSIVE ancestors");
    expectAllPlaceholdersBound(plan.statements as unknown as StubStatement[]);
  });

  it("rejects missing and self-referential task parents", async () => {
    const missing = await planMutation(stubContext(), user, {
      id: "mutation-missing-parent",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: { id: "task-child", parent_task_id: "task-missing", title: "Child" }
    }, timestamp, {
      existingKnown: true,
      existing: null,
      plannedTaskIds: new Set(),
      knownTaskIds: new Set()
    });
    const self = await planMutation(stubContext(), user, {
      id: "mutation-self-parent",
      entity: "task",
      operation: "upsert",
      baseVersion: null,
      data: { id: "task-self", parent_task_id: "task-self", title: "Self" }
    }, timestamp, {
      existingKnown: true,
      existing: null,
      plannedTaskIds: new Set(["task-self"]),
      knownTaskIds: new Set()
    });

    expect(missing.result).toMatchObject({ reason: "Parent task not found", permanent: true });
    expect(self.result).toMatchObject({ reason: "Task cannot be its own parent", permanent: true });
  });

  it("sorts same-batch task upserts parent first and rejects cycles", () => {
    const parent: IncomingMutation = {
      id: "mutation-parent",
      entity: "task",
      operation: "upsert",
      data: { id: "task-parent", title: "Parent" }
    };
    const child: IncomingMutation = {
      id: "mutation-child",
      entity: "task",
      operation: "upsert",
      data: { id: "task-child", parent_task_id: "task-parent", title: "Child" }
    };
    expect(orderMutationsParentFirst([child, parent])?.map((mutation) => mutation.data.id)).toEqual([
      "task-parent",
      "task-child"
    ]);

    const cycle = orderMutationsParentFirst([
      { ...parent, data: { ...parent.data, parent_task_id: "task-child" } },
      child
    ]);
    expect(cycle).toBeNull();
  });

  it("uses tombstones for Next parent deletes", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-next-delete",
      entity: "next_project",
      operation: "delete",
      baseVersion: 1,
      data: { id: "next-project-1" }
    };
    const plan = await planMutation(
      stubContext({ id: "next-project-1", version: 1, deleted_at: null }),
      user,
      mutation,
      timestamp
    );
    const statements = plan.statements as unknown as StubStatement[];

    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.sql.trimStart().startsWith("UPDATE"))).toBe(true);
    expect(statements.every((statement) => statement.sql.includes("sync_seq"))).toBe(true);
    expectAllPlaceholdersBound(statements);
  });

  it("rejects a stale delete so a delayed pagehide request cannot remove newer work", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-stale-delete",
      entity: "task",
      operation: "delete",
      baseVersion: 2,
      data: { id: "task-1" }
    };
    const plan = await planMutation(
      stubContext({ id: "task-1", version: 5, deleted_at: null, title: "Newer task" }),
      user,
      mutation,
      timestamp
    );

    expect(plan.result).toMatchObject({ reason: "Record changed before deletion", permanent: true });
    expect(plan.statements).toHaveLength(0);
  });

  it("detaches migration metadata before purging a formal project", async () => {
    const mutation: IncomingMutation = {
      id: "mutation-project-purge",
      entity: "project",
      operation: "purge",
      data: { id: "project-1" }
    };
    const plan = await planMutation(stubContext(), user, mutation, timestamp);
    const statements = plan.statements as unknown as StubStatement[];

    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("source_project_id = NULL");
    expect(statements[1].sql).toContain("DELETE FROM tasks");
    expect(statements[2].sql).toContain("DELETE FROM projects");
    expectAllPlaceholdersBound(statements);
  });
});
