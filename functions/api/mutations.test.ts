import { describe, expect, it } from "vitest";
import type { AppContext, AuthUser } from "./_utils/types";
import { planMutation, type IncomingMutation } from "./mutations";

// Minimal D1 stub: prepare().bind() returns an inspectable statement whose
// first() resolves to null (no existing row), which is all planMutation needs.
interface StubStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => StubStatement;
  first: () => Promise<null>;
}

function stubContext(): AppContext {
  const prepare = (sql: string): StubStatement => {
    const statement: StubStatement = {
      sql,
      args: [],
      bind: (...args: unknown[]) => ({ ...statement, args }),
      first: async () => null
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

describe("internal settings keys are not writable through sync", () => {
  const reservedKeys = ["local_password_hash", "session_generation", "cloud_excel_latest"];

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
