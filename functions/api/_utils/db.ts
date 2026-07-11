import { nowIso } from "./time";
import type { AppEnv, AuthUser } from "./types";

// Server-owned settings rows: never exposed by readSettings and never
// writable through the sync mutations endpoint.
export const INTERNAL_SETTING_KEYS = new Set([
  "cloud_excel_latest",
  "cloud_excel_metadata",
  "local_password_hash",
  "session_generation"
]);

export const SYNC_SEQUENCE_SQL = "(SELECT seq FROM sync_state WHERE user_id = ?)";
export const NEXT_SYNC_SEQUENCE_SQL = "(SELECT seq + 1 FROM sync_state WHERE user_id = ?)";

export function ensureSyncStateStatement(env: AppEnv, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO sync_state (user_id, epoch, seq) VALUES (?, lower(hex(randomblob(16))), 0)"
  ).bind(userId);
}

export function advanceSyncSequenceStatement(env: AppEnv, userId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE sync_state SET seq = seq + 1, last_operation_id = NULL WHERE user_id = ?").bind(userId);
}

/**
 * Import/restore writes first use NEXT_SYNC_SEQUENCE_SQL. This advances the
 * cursor only if at least one conditional upsert actually changed a row.
 */
export function advanceSyncSequenceIfTouchedStatement(
  env: AppEnv,
  userId: string,
  timestamp: string,
  operationId: string
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE sync_state
     SET seq = seq + 1, last_operation_id = ?
     WHERE user_id = ? AND (
       EXISTS (SELECT 1 FROM projects WHERE user_id = ? AND updated_at = ? AND sync_seq = sync_state.seq + 1) OR
       EXISTS (SELECT 1 FROM tasks WHERE user_id = ? AND updated_at = ? AND sync_seq = sync_state.seq + 1) OR
       EXISTS (SELECT 1 FROM next_projects WHERE user_id = ? AND updated_at = ? AND sync_seq = sync_state.seq + 1) OR
       EXISTS (SELECT 1 FROM next_ideas WHERE user_id = ? AND updated_at = ? AND sync_seq = sync_state.seq + 1)
     )`
  ).bind(
    operationId,
    userId,
    userId,
    timestamp,
    userId,
    timestamp,
    userId,
    timestamp,
    userId,
    timestamp
  );
}

export function markExcelDirtyForOperationStatement(
  env: AppEnv,
  userId: string,
  timestamp: string,
  operationId: string
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at, sync_seq)
     SELECT ?, 'excel_dirty_at', ?, ?, ${SYNC_SEQUENCE_SQL}
     WHERE EXISTS (SELECT 1 FROM sync_state WHERE user_id = ? AND last_operation_id = ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq`
  ).bind(userId, JSON.stringify(timestamp), timestamp, userId, userId, operationId);
}

export async function getOrCreateUser(env: AppEnv, email: string): Promise<AuthUser> {
  const existing = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE email = ?").bind(email).first<AuthUser>();
  if (existing) {
    return existing;
  }

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, email, email.split("@")[0], timestamp, timestamp)
    .run();

  // Another request may have won the insert after our first SELECT. Resolve
  // the canonical id before creating its synchronization state.
  const created = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE email = ?")
    .bind(email)
    .first<AuthUser>();
  if (!created) {
    throw new Error("Failed to create user");
  }
  await ensureSyncStateStatement(env, created.id).run();

  return created;
}

export function parseSettingsRows(rows: Array<{ key: string; value_json: string }>): Record<string, unknown> {
  return Object.fromEntries(
    rows.map((row) => {
      try {
        return [row.key, JSON.parse(row.value_json)];
      } catch {
        return [row.key, null];
      }
    })
  );
}

/**
 * Reads only client-visible settings. Filtering in SQL is intentional: the
 * cloud workbook pointer can contain a large D1-backed payload and must never
 * be fetched merely to discard it in JavaScript.
 */
export async function readSettings(env: AppEnv, userId: string, cursor: number | null): Promise<Record<string, unknown>> {
  const reserved = [...INTERNAL_SETTING_KEYS];
  const placeholders = reserved.map(() => "?").join(", ");
  const query = cursor === null
    ? `SELECT key, value_json FROM app_settings WHERE user_id = ? AND key NOT IN (${placeholders})`
    : `SELECT key, value_json FROM app_settings WHERE user_id = ? AND sync_seq > ? AND key NOT IN (${placeholders})`;
  const result = cursor === null
    ? await env.DB.prepare(query).bind(userId, ...reserved).all<{ key: string; value_json: string }>()
    : await env.DB.prepare(query).bind(userId, cursor, ...reserved).all<{ key: string; value_json: string }>();

  return parseSettingsRows(result.results);
}
