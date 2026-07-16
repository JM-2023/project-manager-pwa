import { INTERNAL_SETTING_KEYS } from "./db";

// Every collection needs at least one query and Workers Free permits only 50
// D1 queries per invocation. A 1,000-row page bounds each result allocation
// while keeping tens of thousands of personal records within that ceiling.
const DEFAULT_PAGE_SIZE = 1_000;
const encoder = new TextEncoder();

const ENTITY_COLLECTIONS = [
  ["projects", "projects"],
  ["tasks", "tasks"],
  ["nextProjects", "next_projects"],
  ["nextIdeas", "next_ideas"]
] as const;
type EntityTable = (typeof ENTITY_COLLECTIONS)[number][1];

interface EntityRow extends Record<string, unknown> {
  id: string;
}

interface SettingRow {
  key: string;
  value_json: string;
}

export interface SnapshotStreamOptions {
  db: D1Database;
  userId: string;
  serverTime: string;
  syncEpoch: string;
  syncCursor: number;
  full: boolean;
  cursor: number;
  exportedAt?: string;
  /** Test override. Production uses a page size chosen for D1's Free query cap. */
  pageSize?: number;
}

function stringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Snapshot contains a value that cannot be serialized as JSON");
  }
  return serialized;
}

function pageSize(value: number | undefined): number {
  const normalized = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RangeError("Snapshot page size must be a positive safe integer");
  }
  return normalized;
}

function parseSettingValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readEntityPage(
  options: SnapshotStreamOptions,
  table: EntityTable,
  afterId: string | null,
  limit: number
): Promise<EntityRow[]> {
  let query = `SELECT * FROM ${table} WHERE user_id = ?`;
  const bindings: unknown[] = [options.userId];

  if (options.full) {
    query += " AND deleted_at IS NULL";
  } else {
    query += " AND sync_seq > ?";
    bindings.push(options.cursor);
  }
  if (afterId !== null) {
    query += " AND id > ?";
    bindings.push(afterId);
  }
  query += " ORDER BY id LIMIT ?";
  bindings.push(limit);

  const result = await options.db.prepare(query).bind(...bindings).all<EntityRow>();
  return result.results ?? [];
}

async function readSettingsPage(
  options: SnapshotStreamOptions,
  afterKey: string | null,
  limit: number
): Promise<SettingRow[]> {
  const reserved = [...INTERNAL_SETTING_KEYS];
  const placeholders = reserved.map(() => "?").join(", ");
  let query = `SELECT key, value_json FROM app_settings
    WHERE user_id = ?`;
  const bindings: unknown[] = [options.userId];

  if (!options.full) {
    query += " AND sync_seq > ?";
    bindings.push(options.cursor);
  }
  query += ` AND key NOT IN (${placeholders})`;
  bindings.push(...reserved);
  if (afterKey !== null) {
    query += " AND key > ?";
    bindings.push(afterKey);
  }
  query += " ORDER BY key LIMIT ?";
  bindings.push(limit);

  const result = await options.db.prepare(query).bind(...bindings).all<SettingRow>();
  return result.results ?? [];
}

async function* entityRows(
  options: SnapshotStreamOptions,
  table: EntityTable,
  size: number
): AsyncGenerator<EntityRow> {
  let afterId: string | null = null;

  while (true) {
    // Fetch one look-ahead row so an exact-size final page does not spend a
    // second D1 query merely to discover that it is finished.
    const rows = await readEntityPage(options, table, afterId, size + 1);
    const emitted = Math.min(rows.length, size);
    for (let index = 0; index < emitted; index += 1) {
      yield rows[index];
    }
    if (rows.length <= size) return;

    const nextId = rows[emitted - 1]?.id;
    if (typeof nextId !== "string" || nextId === afterId) {
      throw new Error(`Invalid pagination key returned from ${table}`);
    }
    afterId = nextId;
  }
}

async function* settingRows(options: SnapshotStreamOptions, size: number): AsyncGenerator<SettingRow> {
  let afterKey: string | null = null;

  while (true) {
    const rows = await readSettingsPage(options, afterKey, size + 1);
    const emitted = Math.min(rows.length, size);
    for (let index = 0; index < emitted; index += 1) {
      yield rows[index];
    }
    if (rows.length <= size) return;

    const nextKey = rows[emitted - 1]?.key;
    if (typeof nextKey !== "string" || nextKey === afterKey) {
      throw new Error("Invalid pagination key returned from app_settings");
    }
    afterKey = nextKey;
  }
}

async function* snapshotJson(options: SnapshotStreamOptions): AsyncGenerator<string> {
  const size = pageSize(options.pageSize);
  let prefix = "{";
  if (options.exportedAt !== undefined) {
    prefix += `"exportedAt":${stringify(options.exportedAt)},`;
  }
  prefix +=
    `"serverTime":${stringify(options.serverTime)},` +
    `"syncEpoch":${stringify(options.syncEpoch)},` +
    `"syncCursor":${stringify(options.syncCursor)},` +
    `"full":${stringify(options.full)}`;
  yield prefix;

  for (const [jsonKey, table] of ENTITY_COLLECTIONS) {
    yield `,\"${jsonKey}\":[`;
    let first = true;
    for await (const row of entityRows(options, table, size)) {
      yield `${first ? "" : ","}${stringify(row)}`;
      first = false;
    }
    yield "]";
  }

  yield ',"settings":{';
  let firstSetting = true;
  for await (const row of settingRows(options, size)) {
    yield `${firstSetting ? "" : ","}${stringify(row.key)}:${stringify(parseSettingValue(row.value_json))}`;
    firstSetting = false;
  }
  yield "}}";
}

function streamFrom(iterator: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(next.value));
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return(reason);
    }
  });
}

/**
 * Stream the existing bootstrap/export JSON contract while retaining only one
 * D1 page and one encoded JSON chunk at a time. The pull source is deliberate:
 * it lets response backpressure stop both serialization and further D1 reads.
 */
export function streamSnapshotResponse(options: SnapshotStreamOptions): Response {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(streamFrom(snapshotJson(options)), { headers });
}
