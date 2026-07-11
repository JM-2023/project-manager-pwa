import { describe, expect, it } from "vitest";
import type { AppContext } from "../_utils/types";
import { onRequestPost } from "./setup";

interface StubEnvOptions {
  sessionSecret?: string;
  setupToken?: string;
  storedSettings?: Map<string, string>;
}

// D1 stub routed on SQL shape: user lookup, settings lookup, and writes. Writes
// are recorded so tests can assert what was (or was not) persisted.
function stubContext(options: StubEnvOptions = {}): { context: AppContext; writes: string[]; settings: Map<string, string> } {
  const settings = options.storedSettings ?? new Map<string, string>();
  const writes: string[] = [];
  const user = { id: "user-1", email: "owner@example.com", display_name: "owner" };

  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes("INSERT INTO auth_rate_limits")) {
          return { attempts: 1, blocked_until: null, last_reservation_id: String(args[3]) };
        }
        if (sql.includes("FROM users")) return user;
        if (sql.includes("FROM app_settings")) {
          const key = String(args[1]);
          const value = settings.get(key);
          return value === undefined ? null : { value_json: value };
        }
        return null;
      },
      run: async () => {
        writes.push(sql);
        let changes = 1;
        if (sql.includes("INTO app_settings")) {
          const key = String(args[1]);
          if (sql.includes("DO NOTHING") && settings.has(key)) {
            changes = 0;
          } else {
            settings.set(key, String(args[2]));
          }
        }
        return { success: true, meta: { changes } };
      }
    })
  });

  const request = new Request("https://app.example.com/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
    body: JSON.stringify({ password: "0802", setupToken: options.setupToken ?? "test-setup-token" })
  });

  const context = {
    request,
    waitUntil: () => undefined,
    env: {
      OWNER_EMAIL: "owner@example.com",
      SESSION_SECRET: options.sessionSecret,
      SETUP_TOKEN: options.setupToken ?? "test-setup-token",
      DB: { prepare }
    }
  } as unknown as AppContext;

  return { context, writes, settings };
}

describe("first-run passcode setup", () => {
  it("reports a missing SESSION_SECRET as a readable error instead of crashing", async () => {
    const { context, writes } = stubContext({ sessionSecret: undefined });
    const response = await onRequestPost(context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "SESSION_SECRET is missing" });
    expect(writes).toHaveLength(0);
  });

  it("stores the hash and signs in when configuration is complete", async () => {
    const { context, settings } = stubContext({ sessionSecret: "test-secret" });
    const response = await onRequestPost(context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("pm_session=");
    const stored = JSON.parse(settings.get("local_password_hash") ?? "null") as { hash?: string };
    expect(stored?.hash).toMatch(/^pbkdf2_sha256\$100000\$/);
  });

  it("requires the deploy-time setup token", async () => {
    const { context, writes } = stubContext({ sessionSecret: "test-secret", setupToken: "expected-setup-token" });
    (context as unknown as { request: Request }).request = new Request("https://app.example.com/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
      body: JSON.stringify({ password: "0802", setupToken: "wrong-token" })
    });
    const response = await onRequestPost(context);
    expect(response.status).toBe(403);
    expect(writes.some((sql) => sql.includes("INTO app_settings"))).toBe(false);
  });

  it("refuses to overwrite an already configured passcode", async () => {
    const storedSettings = new Map([["local_password_hash", JSON.stringify({ hash: "pbkdf2_sha256$100000$salt$digest" })]]);
    const { context } = stubContext({ sessionSecret: "test-secret", storedSettings });
    const response = await onRequestPost(context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Passcode already configured" });
  });

  it("surfaces unexpected persistence failures as JSON errors, without saving first", async () => {
    const { context, settings } = stubContext({ sessionSecret: "test-secret" });
    const env = (context as unknown as { env: { DB: { prepare: (sql: string) => unknown } } }).env;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      if (sql.includes("INTO app_settings")) throw new Error("no such table: app_settings");
      return prepare(sql);
    };
    const response = await onRequestPost(context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "no such table: app_settings" });
    expect(settings.has("local_password_hash")).toBe(false);
  });
});
