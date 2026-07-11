import { describe, expect, it } from "vitest";
import type { AppContext } from "./types";
import { reserveAuthAttempt } from "./rateLimit";

const now = Date.parse("2026-07-11T00:00:00.000Z");

function contextWithRateLimitRows(activeBlock: boolean): { context: AppContext; sql: string[]; binds: unknown[][] } {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const prepare = (query: string) => {
    sql.push(query);
    return {
      bind: (...args: unknown[]) => {
        binds.push(args);
        return {
          first: async () => {
            if (query.includes("SELECT key, attempts")) {
              return activeBlock
                ? {
                    key: "blocked",
                    attempts: 5,
                    blocked_until: "2026-07-11T00:01:00.000Z",
                    last_reservation_id: "earlier"
                  }
                : null;
            }
            if (query.includes("INSERT INTO auth_rate_limits")) {
              return { attempts: 1, blocked_until: null, last_reservation_id: String(args[3]) };
            }
            return null;
          },
          run: async () => ({ success: true, meta: { changes: 0 } })
        };
      }
    };
  };
  const context = {
    request: new Request("https://app.example.com/api/auth/login", {
      headers: { "CF-Connecting-IP": "192.0.2.1" }
    }),
    waitUntil: () => undefined,
    env: { OWNER_EMAIL: "owner@example.com", DB: { prepare } }
  } as unknown as AppContext;
  return { context, sql, binds };
}

describe("durable authentication rate limiting", () => {
  it("uses only a read when either key is already blocked", async () => {
    const { context, sql } = contextWithRateLimitRows(true);
    const result = await reserveAuthAttempt(context, "login", now);

    expect(result).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("blocked_until > ?");
    expect(sql[0]).not.toContain("INSERT");
    expect(sql[0]).not.toContain("DELETE");
  });

  it("binds every placeholder for both atomic reservations", async () => {
    const { context, sql, binds } = contextWithRateLimitRows(false);
    const result = await reserveAuthAttempt(context, "login", now);
    const inserts = sql
      .map((query, index) => ({ query, args: binds[index] }))
      .filter(({ query }) => query.includes("INSERT INTO auth_rate_limits"));

    expect(result.allowed).toBe(true);
    expect(inserts).toHaveLength(2);
    for (const { query, args } of inserts) {
      expect(args).toHaveLength(query.match(/\?/g)?.length ?? 0);
    }
  });
});
