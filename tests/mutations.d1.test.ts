import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../functions/api/_utils/types";
import { onRequestPost, type IncomingMutation } from "../functions/api/mutations";

const BASE_SCHEMA = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1,
    sync_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1, sync_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE next_projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1, sync_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE next_ideas (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, next_project_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1,
    sync_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE app_settings (
    user_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, sync_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE processed_mutations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE sync_state (
    user_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
    last_operation_id TEXT
  )`
];

interface MutationResponse {
  ok: boolean;
  applied: Array<{ id: string; recordId: string; version?: number }>;
  conflicts: Array<{ id: string; recordId: string; reason: string; permanent?: boolean }>;
}

async function baseDatabase(): Promise<{ miniflare: Miniflare; database: D1Database }> {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-06-22",
    d1Databases: { DB: "mutation-delete-guard-test" }
  });
  const database = await miniflare.getD1Database("DB") as unknown as D1Database;
  for (const statement of BASE_SCHEMA) {
    await database.prepare(statement.replace(/\s+/g, " ")).run();
  }
  return { miniflare, database };
}

async function applyDeletionGuardMigration(database: D1Database): Promise<void> {
  const migration = await readFile(new URL("../migrations/0006_record_deletion_guards.sql", import.meta.url), "utf8");
  const statements = migration
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  for (const statement of statements) await database.prepare(statement).run();
}

async function postMutation(database: D1Database, mutation: IncomingMutation): Promise<MutationResponse> {
  const request = new Request("https://app.example.com/api/mutations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
    body: JSON.stringify({ clientId: "d1-test-client", mutations: [mutation] })
  });
  const background: Promise<unknown>[] = [];
  const response = await onRequestPost({
    request,
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
    env: {
      DB: database,
      AUTH_MODE: "none",
      OWNER_EMAIL: "owner@example.com"
    }
  } as unknown as AppContext);
  expect(response.status).toBe(200);
  const body = await response.json() as MutationResponse;
  await Promise.all(background);
  return body;
}

describe("D1 record deletion guards", () => {
  let miniflare: Miniflare | undefined;

  afterEach(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  it("keeps a missing row deleted when an older create with another mutation id arrives later", async () => {
    const setup = await baseDatabase();
    miniflare = setup.miniflare;
    await applyDeletionGuardMigration(setup.database);
    const recordId = "project-delete-before-create";

    const deletion = await postMutation(setup.database, {
      id: "mutation-delete-newer",
      entity: "project",
      operation: "delete",
      baseVersion: null,
      data: { id: recordId }
    });
    expect(deletion.applied).toEqual([
      expect.objectContaining({ id: "mutation-delete-newer", recordId })
    ]);
    expect(deletion.conflicts).toEqual([]);

    const delayedCreate = await postMutation(setup.database, {
      id: "mutation-create-older",
      entity: "project",
      operation: "upsert",
      baseVersion: null,
      data: { id: recordId, name: "Must not be resurrected", version: 1 }
    });
    expect(delayedCreate.applied).toEqual([]);
    expect(delayedCreate.conflicts).toEqual([
      expect.objectContaining({
        id: "mutation-create-older",
        recordId,
        reason: "Record no longer exists",
        permanent: true
      })
    ]);

    const project = await setup.database.prepare("SELECT id FROM projects WHERE id = ?").bind(recordId).first();
    const guard = await setup.database.prepare(
      "SELECT entity, record_id, last_mutation_id FROM record_deletion_guards WHERE entity = 'project' AND record_id = ?"
    ).bind(recordId).first<{ entity: string; record_id: string; last_mutation_id: string }>();
    const delayedLedger = await setup.database.prepare(
      "SELECT id FROM processed_mutations WHERE id = 'mutation-create-older'"
    ).first();

    expect(project).toBeNull();
    expect(guard).toEqual({
      entity: "project",
      record_id: recordId,
      last_mutation_id: "mutation-delete-newer"
    });
    expect(delayedLedger).toBeNull();
  });

  it("does not acknowledge a live-row delete whose version guard loses a planning race", async () => {
    const setup = await baseDatabase();
    miniflare = setup.miniflare;
    await applyDeletionGuardMigration(setup.database);
    const userId = "race-user";
    const recordId = "project-live-race";
    await setup.database.prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, "owner@example.com", "owner", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z").run();
    await setup.database.prepare(
      "INSERT INTO sync_state (user_id, epoch, seq, last_operation_id) VALUES (?, 'epoch-1', 0, NULL)"
    ).bind(userId).run();
    await setup.database.prepare(
      `INSERT INTO projects (
         id, user_id, name, sort_order, archived, created_at, updated_at, deleted_at, version, sync_seq
       ) VALUES (?, ?, ?, 0, 0, ?, ?, NULL, 1, 0)`
    ).bind(
      recordId,
      userId,
      "Version one",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    ).run();

    let batchCalls = 0;
    const racingDatabase = {
      prepare: setup.database.prepare.bind(setup.database),
      batch: async (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          await setup.database.prepare(
            "UPDATE projects SET name = 'Concurrent edit', version = 2 WHERE id = ?"
          ).bind(recordId).run();
        }
        return setup.database.batch(statements);
      }
    } as unknown as D1Database;

    const deletion = await postMutation(racingDatabase, {
      id: "mutation-stale-live-delete",
      entity: "project",
      operation: "delete",
      baseVersion: 1,
      data: { id: recordId }
    });
    expect(deletion.applied).toEqual([]);
    expect(deletion.conflicts).toEqual([
      expect.objectContaining({
        id: "mutation-stale-live-delete",
        recordId,
        reason: "Record changed before deletion",
        permanent: true
      })
    ]);

    const project = await setup.database.prepare(
      "SELECT name, version, deleted_at FROM projects WHERE id = ?"
    ).bind(recordId).first();
    const guard = await setup.database.prepare(
      "SELECT record_id FROM record_deletion_guards WHERE entity = 'project' AND record_id = ?"
    ).bind(recordId).first();
    const ledger = await setup.database.prepare(
      "SELECT id FROM processed_mutations WHERE id = 'mutation-stale-live-delete'"
    ).first();
    expect(project).toEqual({ name: "Concurrent edit", version: 2, deleted_at: null });
    expect(guard).toBeNull();
    expect(ledger).toBeNull();
  });

  it("prunes ledger rows past the retention window after a committed batch", async () => {
    const setup = await baseDatabase();
    miniflare = setup.miniflare;
    await applyDeletionGuardMigration(setup.database);
    const fresh = new Date().toISOString();
    await setup.database.prepare(
      "INSERT INTO processed_mutations (id, user_id, created_at) VALUES ('mutation-ancient', 'user-old', '2026-01-01T00:00:00.000Z')"
    ).run();
    await setup.database.prepare(
      "INSERT INTO processed_mutations (id, user_id, created_at) VALUES (?, 'user-old', ?)"
    ).bind("mutation-recent", fresh).run();

    const created = await postMutation(setup.database, {
      id: "mutation-create-current",
      entity: "project",
      operation: "upsert",
      baseVersion: null,
      data: { id: "project-retention", name: "Current", version: 1 }
    });
    expect(created.applied).toEqual([
      expect.objectContaining({ id: "mutation-create-current", recordId: "project-retention" })
    ]);

    const remaining = await setup.database.prepare(
      "SELECT id FROM processed_mutations ORDER BY id"
    ).all<{ id: string }>();
    expect(remaining.results.map((row) => row.id)).toEqual(["mutation-create-current", "mutation-recent"]);
  });

  it("backfills guards for tombstones that predate the migration", async () => {
    const setup = await baseDatabase();
    miniflare = setup.miniflare;
    const userId = "migration-user";
    await setup.database.prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, "migration@example.com", "migration", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z").run();

    await setup.database.prepare(
      `INSERT INTO projects (
         id, user_id, name, sort_order, archived, created_at, updated_at, deleted_at, version, sync_seq
       ) VALUES (?, ?, ?, 0, 1, ?, ?, ?, 2, 0)`
    ).bind(
      "pre-migration-project",
      userId,
      "Deleted project",
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z"
    ).run();
    await applyDeletionGuardMigration(setup.database);

    const guard = await setup.database.prepare(
      "SELECT entity, record_id, deleted_at FROM record_deletion_guards WHERE user_id = ? AND record_id = ?"
    ).bind(userId, "pre-migration-project").first();
    expect(guard).toEqual({
      entity: "project",
      record_id: "pre-migration-project",
      deleted_at: "2026-07-02T00:00:00.000Z"
    });
  });
});

describe("D1 applied versions", () => {
  let miniflare: Miniflare | undefined;

  afterEach(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  it("reports the version each committed write produced, so a later delete can use it", async () => {
    const setup = await baseDatabase();
    miniflare = setup.miniflare;
    await applyDeletionGuardMigration(setup.database);
    const id = "11111111-1111-4111-8111-111111111111";
    const now = "2026-07-01T00:00:00.000Z";
    const record = { id, name: "A", description: null, color: null, sort_order: 0, archived: 0, created_at: now, updated_at: now, deleted_at: null, version: 1 };

    const created = await postMutation(setup.database, { id: "v-create", entity: "project", operation: "upsert", baseVersion: null, data: record });
    expect(created.applied).toEqual([expect.objectContaining({ id: "v-create", version: 1 })]);

    // Two local edits compacted: optimistic version 3, one server increment.
    const edit: IncomingMutation = { id: "v-edit", entity: "project", operation: "upsert", baseVersion: 1, data: { ...record, name: "C", version: 3 }, patch: { name: "C" } };
    const edited = await postMutation(setup.database, edit);
    expect(edited.applied).toEqual([expect.objectContaining({ id: "v-edit", version: 2 })]);

    // A replay answered from the ledger cannot vouch for the current version.
    const replayed = await postMutation(setup.database, edit);
    expect(replayed.applied).toHaveLength(1);
    expect(replayed.applied[0].version).toBeUndefined();

    const deleted = await postMutation(setup.database, { id: "v-delete", entity: "project", operation: "delete", baseVersion: 2, data: { id } });
    expect(deleted.conflicts).toEqual([]);
    expect(deleted.applied).toEqual([expect.objectContaining({ id: "v-delete" })]);
  });
});
