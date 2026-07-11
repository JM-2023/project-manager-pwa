import { authenticate, isResponse } from "./_utils/auth";
import { ensureSyncStateStatement, INTERNAL_SETTING_KEYS, parseSettingsRows } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

interface SyncStateRow {
  epoch: string;
  seq: number;
}

function rows<T>(result: D1Result<unknown>): T[] {
  return (result.results ?? []) as T[];
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;
  await ensureSyncStateStatement(context.env, user.id).run();

  const reserved = [...INTERNAL_SETTING_KEYS];
  const placeholders = reserved.map(() => "?").join(", ");
  const results = await context.env.DB.batch([
    context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?").bind(user.id),
    context.env.DB.prepare("SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, name").bind(user.id),
    context.env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY due_date, sort_order").bind(user.id),
    // A backup must retain archived parents because live ideas may still refer
    // to them. Excel presentation filters archived projects later.
    context.env.DB.prepare("SELECT * FROM next_projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, name").bind(user.id),
    context.env.DB.prepare("SELECT * FROM next_ideas WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at").bind(user.id),
    context.env.DB.prepare(
      `SELECT key, value_json FROM app_settings WHERE user_id = ? AND key NOT IN (${placeholders})`
    ).bind(user.id, ...reserved)
  ]);

  const state = rows<SyncStateRow>(results[0])[0] ?? { epoch: "", seq: 0 };
  const timestamp = nowIso();
  return json({
    exportedAt: timestamp,
    serverTime: timestamp,
    syncEpoch: state.epoch,
    syncCursor: Number(state.seq),
    full: true,
    projects: rows(results[1]),
    tasks: rows(results[2]),
    nextProjects: rows(results[3]),
    nextIdeas: rows(results[4]),
    settings: parseSettingsRows(rows(results[5]))
  });
}
