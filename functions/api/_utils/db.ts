import { nowIso } from "./time";
import type { AppEnv, AuthUser } from "./types";

const INTERNAL_SETTING_KEYS = new Set(["cloud_excel_latest", "local_password_hash"]);

export async function getOrCreateUser(env: AppEnv, email: string): Promise<AuthUser> {
  const existing = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE email = ?").bind(email).first<AuthUser>();
  if (existing) {
    return existing;
  }

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, email, email.split("@")[0], timestamp, timestamp)
    .run();

  return { id, email, display_name: email.split("@")[0] };
}

export async function readSettings(env: AppEnv, userId: string, since: string | null): Promise<Record<string, unknown>> {
  const query = since
    ? "SELECT key, value_json FROM app_settings WHERE user_id = ? AND updated_at > ?"
    : "SELECT key, value_json FROM app_settings WHERE user_id = ?";
  const result = since
    ? await env.DB.prepare(query).bind(userId, since).all<{ key: string; value_json: string }>()
    : await env.DB.prepare(query).bind(userId).all<{ key: string; value_json: string }>();

  return Object.fromEntries(
    result.results.filter((row) => !INTERNAL_SETTING_KEYS.has(row.key)).map((row) => {
      try {
        return [row.key, JSON.parse(row.value_json)];
      } catch {
        return [row.key, null];
      }
    })
  );
}
