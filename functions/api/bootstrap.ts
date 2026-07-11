import { authenticate, isResponse } from "./_utils/auth";
import { ensureSyncStateStatement, INTERNAL_SETTING_KEYS, parseSettingsRows } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext, AuthUser } from "./_utils/types";

interface SyncStateRow {
  epoch: string;
  seq: number;
}

interface SettingRow {
  key: string;
  value_json: string;
}

interface Snapshot {
  state: SyncStateRow;
  projects: unknown[];
  tasks: unknown[];
  nextProjects: unknown[];
  nextIdeas: unknown[];
  settings: Record<string, unknown>;
}

function rows<T>(result: D1Result<unknown>): T[] {
  return (result.results ?? []) as T[];
}

function parseCursor(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readSnapshot(context: AppContext, user: AuthUser, full: boolean, cursor: number): Promise<Snapshot> {
  const changed = full ? "AND deleted_at IS NULL" : "AND sync_seq > ?";
  const entityBindings = full ? [user.id] : [user.id, cursor];
  const reserved = [...INTERNAL_SETTING_KEYS];
  const reservedPlaceholders = reserved.map(() => "?").join(", ");
  const settingsQuery = full
    ? `SELECT key, value_json FROM app_settings
       WHERE user_id = ? AND key NOT IN (${reservedPlaceholders})`
    : `SELECT key, value_json FROM app_settings
       WHERE user_id = ? AND sync_seq > ? AND key NOT IN (${reservedPlaceholders})`;
  const settingsBindings = full ? [user.id, ...reserved] : [user.id, cursor, ...reserved];

  // D1 executes a batch sequentially as one transaction. Reading the sequence
  // and all five datasets in this batch gives the response one consistent
  // snapshot even while another device is writing.
  const results = await context.env.DB.batch([
    context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?").bind(user.id),
    context.env.DB.prepare(
      `SELECT * FROM projects WHERE user_id = ? ${changed} ORDER BY sort_order, name`
    ).bind(...entityBindings),
    context.env.DB.prepare(
      `SELECT * FROM tasks WHERE user_id = ? ${changed} ORDER BY due_date, sort_order`
    ).bind(...entityBindings),
    context.env.DB.prepare(
      `SELECT * FROM next_projects WHERE user_id = ? ${changed} ORDER BY sort_order, name`
    ).bind(...entityBindings),
    context.env.DB.prepare(
      `SELECT * FROM next_ideas WHERE user_id = ? ${changed} ORDER BY sort_order, created_at`
    ).bind(...entityBindings),
    context.env.DB.prepare(settingsQuery).bind(...settingsBindings)
  ]);

  const state = rows<SyncStateRow>(results[0])[0];
  if (!state) {
    throw new Error("Synchronization state is missing");
  }

  return {
    state: { epoch: state.epoch, seq: Number(state.seq) },
    projects: rows(results[1]),
    tasks: rows(results[2]),
    nextProjects: rows(results[3]),
    nextIdeas: rows(results[4]),
    settings: parseSettingsRows(rows<SettingRow>(results[5]))
  };
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  await ensureSyncStateStatement(context.env, user.id).run();

  const url = new URL(context.request.url);
  const requestedEpoch = url.searchParams.get("epoch")?.trim() || null;
  const requestedCursor = parseCursor(url.searchParams.get("cursor"));
  let full = !requestedEpoch || requestedCursor === null;
  let snapshot = await readSnapshot(context, user, full, requestedCursor ?? 0);

  // An epoch mismatch means that the server dataset was replaced or rolled
  // back. A cursor ahead of the server has the same recovery requirement.
  if (!full && (snapshot.state.epoch !== requestedEpoch || requestedCursor! > snapshot.state.seq)) {
    full = true;
    snapshot = await readSnapshot(context, user, true, 0);
  }

  return json({
    serverTime: nowIso(),
    syncEpoch: snapshot.state.epoch,
    syncCursor: snapshot.state.seq,
    full,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    nextProjects: snapshot.nextProjects,
    nextIdeas: snapshot.nextIdeas,
    settings: snapshot.settings
  });
}
