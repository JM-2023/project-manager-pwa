import { authenticate, isResponse } from "./_utils/auth";
import { apiError, json, readBodyBytes, RequestBodyTooLargeError, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

const LATEST_EXCEL_KEY = "latest/project-manager-latest.xlsx";
const D1_EXCEL_STATE_KEY = "cloud_excel_latest";
const D1_EXCEL_METADATA_KEY = "cloud_excel_metadata";
const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const AUTOSYNC_R2_PREFIX = "autosync";
const AUTOSYNC_R2_HISTORY_LIMIT = 5;
const AUTOSYNC_R2_DELETE_LIMIT = 1_000;

interface D1ExcelState {
  dataBase64?: string;
  r2Key?: string;
  etag: string;
  filename: string;
  updatedAt: string;
  size: number;
  sourceSyncEpoch: string;
  sourceSyncCursor: number;
}

function r2ExcelStateEnabled(context: AppContext): boolean {
  return context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS);
}

function d1ExcelStateEnabled(context: AppContext): boolean {
  return context.env.ENABLE_D1_EXCEL_STATE === "true";
}

function excelStateEnabled(context: AppContext): boolean {
  return r2ExcelStateEnabled(context) || d1ExcelStateEnabled(context);
}

function autosyncUserPrefix(userId: string): string {
  return `${AUTOSYNC_R2_PREFIX}/${encodeURIComponent(userId)}/`;
}

export function autosyncObjectKey(userId: string, epoch: string, sourceSyncCursor: number): string {
  const cursor = String(sourceSyncCursor).padStart(16, "0");
  return `${autosyncUserPrefix(userId)}${encodeURIComponent(epoch)}/${cursor}.xlsx`;
}

interface AutosyncObjectRevision {
  epoch: string;
  cursor: number;
}

function autosyncObjectRevision(key: string, userId: string): AutosyncObjectRevision | null {
  const prefix = autosyncUserPrefix(userId);
  if (!key.startsWith(prefix)) return null;
  const match = /^([^/]+)\/(\d{16})\.xlsx$/.exec(key.slice(prefix.length));
  if (!match) return null;
  const cursor = Number(match[2]);
  if (!Number.isSafeInteger(cursor)) return null;
  return { epoch: match[1], cursor };
}

interface AutosyncRetentionState {
  recentOlderKeys: string[];
}

/**
 * R2 lists keys lexicographically. Zero-padded cursors therefore let us keep
 * the four nearest predecessors without loading an unbounded history into the
 * Worker. Objects at the current or a higher cursor are protected because a
 * concurrent request may have uploaded them before committing its D1 pointer.
 */
export function autosyncRetentionDeletes(
  objects: Array<Pick<R2Object, "key" | "uploaded">>,
  userId: string,
  currentEpoch: string,
  currentCursor: number,
  currentUploadedAt: Date,
  state: AutosyncRetentionState
): string[] {
  const encodedEpoch = encodeURIComponent(currentEpoch);
  const deletes: string[] = [];
  for (const object of objects) {
    const revision = autosyncObjectRevision(object.key, userId);
    if (!revision) continue;
    if (revision.epoch !== encodedEpoch) {
      // A future epoch can only be uploaded after the current object. Preserve
      // it; older epochs are no longer reachable after this pointer succeeds.
      if (object.uploaded.getTime() < currentUploadedAt.getTime()) deletes.push(object.key);
      continue;
    }
    if (revision.cursor >= currentCursor) continue;
    state.recentOlderKeys.push(object.key);
    if (state.recentOlderKeys.length >= AUTOSYNC_R2_HISTORY_LIMIT) {
      deletes.push(state.recentOlderKeys.shift()!);
    }
  }
  return deletes;
}

async function collectStaleAutosyncKeys(
  bucket: Pick<R2Bucket, "list">,
  userId: string,
  currentEpoch: string,
  currentCursor: number,
  currentUploadedAt: Date
): Promise<string[]> {
  const state: AutosyncRetentionState = { recentOlderKeys: [] };
  const staleKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: autosyncUserPrefix(userId), limit: 1_000, ...(cursor ? { cursor } : {}) });
    const pageDeletes = autosyncRetentionDeletes(
      page.objects,
      userId,
      currentEpoch,
      currentCursor,
      currentUploadedAt,
      state
    );
    staleKeys.push(...pageDeletes.slice(0, AUTOSYNC_R2_DELETE_LIMIT - staleKeys.length));
    if (staleKeys.length >= AUTOSYNC_R2_DELETE_LIMIT || !page.truncated) break;
    cursor = page.cursor;
  } while (cursor);

  return staleKeys;
}

export function isLegacyAutosyncObject(
  object: Pick<R2Object, "customMetadata" | "uploaded">,
  userId: string,
  currentUploadedAt: Date
): boolean {
  const metadata = object.customMetadata;
  const hasRevisionMetadata = Boolean(metadata?.sourceSyncEpoch && metadata.sourceSyncCursor);
  const hasOriginalAutosyncSignature = Boolean(
    metadata?.filename === "project-manager-latest.xlsx" &&
    metadata.updatedAt &&
    metadata.rowCount !== undefined
  );
  return Boolean(
    metadata?.userId === userId &&
    (hasRevisionMetadata || hasOriginalAutosyncSignature) &&
    object.uploaded.getTime() < currentUploadedAt.getTime()
  );
}

async function collectLegacyAutosyncKeys(
  bucket: Pick<R2Bucket, "list">,
  userId: string,
  currentUploadedAt: Date
): Promise<string[]> {
  const staleKeys: string[] = [];
  let cursor: string | undefined;
  do {
    // Pre-stable-key versions stored autosync files beside explicit backups.
    // Ask R2 for custom metadata so only invisible autosync revisions are
    // removed; user-created backup objects have no source revision fields.
    const options: R2ListOptions & { include: string[] } = {
      // The released 2.1.33 layout did not include userId in the key. Filter
      // ownership from custom metadata after listing the shared prefix.
      prefix: "exports/",
      limit: 1_000,
      include: ["customMetadata"],
      ...(cursor ? { cursor } : {})
    };
    const page = await bucket.list(options);
    for (const object of page.objects) {
      if (isLegacyAutosyncObject(object, userId, currentUploadedAt)) staleKeys.push(object.key);
      if (staleKeys.length >= AUTOSYNC_R2_DELETE_LIMIT) break;
    }
    if (staleKeys.length >= AUTOSYNC_R2_DELETE_LIMIT || !page.truncated) break;
    cursor = page.cursor;
  } while (cursor);
  return staleKeys;
}

export async function pruneAutosyncHistory(
  bucket: Pick<R2Bucket, "list" | "delete">,
  userId: string,
  currentEpoch: string,
  currentCursor: number,
  currentUploadedAt: Date
): Promise<void> {
  // Delete in platform-sized batches and rescan from the start. This drains a
  // pre-existing backlog larger than 1000 without keeping every key in memory.
  while (true) {
    const staleKeys = await collectStaleAutosyncKeys(
      bucket,
      userId,
      currentEpoch,
      currentCursor,
      currentUploadedAt
    );
    if (staleKeys.length === 0) break;
    await bucket.delete(staleKeys);
    if (staleKeys.length < AUTOSYNC_R2_DELETE_LIMIT) break;
  }

  // Drain timestamped autosync objects produced before stable revision keys
  // were introduced. Explicit backup objects under exports/ are preserved.
  while (true) {
    const staleKeys = await collectLegacyAutosyncKeys(bucket, userId, currentUploadedAt);
    if (staleKeys.length === 0) return;
    await bucket.delete(staleKeys);
    if (staleKeys.length < AUTOSYNC_R2_DELETE_LIMIT) return;
  }
}

async function retryR2Maintenance(work: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await work();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function reportR2MaintenanceError(message: string, error: unknown): void {
  console.error(JSON.stringify({
    message,
    error: error instanceof Error ? error.message : String(error)
  }));
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") ?? EXCEL_CONTENT_TYPE);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-R2-Key", object.key);
  headers.set("X-Excel-Updated-At", object.uploaded.toISOString());
  headers.set("X-Excel-Size", String(object.size));
  return headers;
}

function d1StateHeaders(state: D1ExcelState): Headers {
  const headers = new Headers();
  headers.set("Content-Type", EXCEL_CONTENT_TYPE);
  headers.set("ETag", state.etag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-R2-Key", state.r2Key ?? "d1:cloud_excel_latest");
  headers.set("X-Excel-Updated-At", state.updatedAt);
  headers.set("X-Excel-Size", String(state.size));
  headers.set("X-Excel-Source-Sync-Epoch", state.sourceSyncEpoch);
  headers.set("X-Excel-Source-Sync-Cursor", String(state.sourceSyncCursor));
  return headers;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Etag(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

function boundedFilename(value: string | null): string {
  const cleaned = (value ?? "project-manager-latest.xlsx").replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim();
  let filename = cleaned || "project-manager-latest.xlsx";
  while (new TextEncoder().encode(filename).byteLength > 512) filename = filename.slice(0, -1);
  return filename;
}

async function readD1ExcelState(context: AppContext, userId: string): Promise<D1ExcelState | null> {
  const row = await context.env.DB.prepare("SELECT value_json, sync_seq FROM app_settings WHERE user_id = ? AND key = ?")
    .bind(userId, D1_EXCEL_STATE_KEY)
    .first<{ value_json: string; sync_seq: number }>();
  if (!row) return null;
  try {
    const state = JSON.parse(row.value_json) as Partial<D1ExcelState>;
    if (!state.etag || !state.updatedAt || !Number.isFinite(Number(state.size))) return null;
    return {
      ...state,
      etag: state.etag,
      filename: state.filename ?? "project-manager-latest.xlsx",
      updatedAt: state.updatedAt,
      size: Number(state.size),
      sourceSyncEpoch: String(state.sourceSyncEpoch ?? ""),
      sourceSyncCursor: Number(state.sourceSyncCursor ?? row.sync_seq ?? 0)
    };
  } catch {
    return null;
  }
}

async function readD1ExcelMetadata(context: AppContext, userId: string): Promise<D1ExcelState | null> {
  const row = await context.env.DB.prepare("SELECT value_json, sync_seq FROM app_settings WHERE user_id = ? AND key = ?")
    .bind(userId, D1_EXCEL_METADATA_KEY)
    .first<{ value_json: string; sync_seq: number }>();
  if (!row) return null;
  try {
    const state = JSON.parse(row.value_json) as Partial<D1ExcelState>;
    if (!state.etag || !state.updatedAt || !Number.isFinite(Number(state.size))) return null;
    return {
      ...state,
      etag: state.etag,
      filename: state.filename ?? "project-manager-latest.xlsx",
      updatedAt: state.updatedAt,
      size: Number(state.size),
      sourceSyncEpoch: String(state.sourceSyncEpoch ?? ""),
      sourceSyncCursor: Number(state.sourceSyncCursor ?? row.sync_seq ?? 0)
    };
  } catch {
    return null;
  }
}

async function removeRejectedAutosyncObject(context: AppContext, userId: string, key: string): Promise<void> {
  if (!context.env.BACKUPS) return;
  const current = await readD1ExcelState(context, userId);
  // A same-cursor request may have committed the shared stable key while this
  // request was in flight. Preserve it whenever D1 names it as authoritative.
  if (current?.r2Key === key) return;
  await context.env.BACKUPS.delete(key);
}

interface SourceRevision {
  epoch: string;
  cursor: number;
}

async function requestedSourceRevision(context: AppContext, userId: string): Promise<SourceRevision | null> {
  const row = await context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?")
    .bind(userId)
    .first<{ epoch: string; seq: number }>();
  if (!row) return null;
  const epochHeader = context.request.headers.get("X-Source-Sync-Epoch");
  const cursorHeader = context.request.headers.get("X-Source-Sync-Cursor");
  if (epochHeader && cursorHeader !== null && /^\d+$/.test(cursorHeader)) {
    const cursor = Number(cursorHeader);
    if (epochHeader !== row.epoch || cursor > Number(row.seq)) return null;
    return { epoch: epochHeader, cursor };
  }
  // A cached pre-revision client cannot prove which dataset its workbook was
  // built from. Accepting it as current could clear a newer dirty marker.
  return null;
}

async function r2HeadForState(context: AppContext, state: D1ExcelState): Promise<R2Object | null> {
  if (!state.r2Key || !r2ExcelStateEnabled(context) || !context.env.BACKUPS) return null;
  return context.env.BACKUPS.head(state.r2Key);
}

async function r2GetForState(context: AppContext, state: D1ExcelState): Promise<R2ObjectBody | null> {
  if (!state.r2Key || !r2ExcelStateEnabled(context) || !context.env.BACKUPS) return null;
  return context.env.BACKUPS.get(state.r2Key);
}

export async function onRequestHead(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  // New uploads keep metadata in a small row so HEAD does not deserialize a
  // base64 workbook. The state-row fallback supports pre-migration uploads.
  const state = (await readD1ExcelMetadata(context, user.id)) ?? (await readD1ExcelState(context, user.id));
  if (state) {
    const object = await r2HeadForState(context, state);
    if (object) {
      const headers = objectHeaders(object);
      headers.set("X-Excel-Source-Sync-Epoch", state.sourceSyncEpoch);
      headers.set("X-Excel-Source-Sync-Cursor", String(state.sourceSyncCursor));
      return new Response(null, { headers });
    }
    if (state.dataBase64 || !state.r2Key) {
      return new Response(null, { headers: d1StateHeaders(state) });
    }
  }

  // Read the legacy global key only when no per-user revision pointer exists.
  if (!state && r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    const object = await context.env.BACKUPS.head(LATEST_EXCEL_KEY);
    if (object?.customMetadata?.userId === user.id) {
      return new Response(null, { headers: objectHeaders(object) });
    }
  }
  return apiError(404, "Cloud Excel file not found");
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  const state = await readD1ExcelState(context, user.id);
  if (state) {
    const object = await r2GetForState(context, state);
    if (object) {
      const headers = objectHeaders(object);
      headers.set("Content-Disposition", 'attachment; filename="project-manager-latest.xlsx"');
      headers.set("X-Excel-Source-Sync-Epoch", state.sourceSyncEpoch);
      headers.set("X-Excel-Source-Sync-Cursor", String(state.sourceSyncCursor));
      return new Response(object.body, { headers });
    }
    if (state.dataBase64) {
      const headers = d1StateHeaders(state);
      headers.set("Content-Disposition", 'attachment; filename="project-manager-latest.xlsx"');
      const body = base64ToBytes(state.dataBase64);
      const arrayBuffer = new ArrayBuffer(body.byteLength);
      new Uint8Array(arrayBuffer).set(body);
      return new Response(arrayBuffer, { headers });
    }
  }

  if (!state && r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    const object = await context.env.BACKUPS.get(LATEST_EXCEL_KEY);
    if (object?.customMetadata?.userId === user.id) {
      const headers = objectHeaders(object);
      headers.set("Content-Disposition", 'attachment; filename="project-manager-latest.xlsx"');
      return new Response(object.body, { headers });
    }
  }
  return apiError(404, "Cloud Excel file not found");
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  const sourceRevision = await requestedSourceRevision(context, user.id);
  if (!sourceRevision) {
    return apiError(409, "The workbook source revision is no longer current");
  }

  let bodyBytes: Uint8Array;
  try {
    // Reject an oversized D1-only upload while streaming it. Waiting until
    // after base64 conversion would briefly allocate and hash many megabytes
    // that can never fit in D1's 2 MB value/row limit.
    const maxBytes = r2ExcelStateEnabled(context) ? 10_000_000 : 1_400_000;
    bodyBytes = await readBodyBytes(context.request, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return apiError(413, "Excel file is too large");
    return apiError(400, "Could not read Excel file");
  }
  const bytes = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer;
  if (bytes.byteLength === 0) {
    return apiError(400, "Missing Excel file body");
  }

  const timestamp = nowIso();
  const sourceSyncEpoch = sourceRevision.epoch;
  const sourceSyncCursor = sourceRevision.cursor;
  const rawRowCount = Number(context.request.headers.get("X-Row-Count") ?? "0");
  const rowCount = Number.isSafeInteger(rawRowCount) && rawRowCount >= 0 ? rawRowCount : 0;
  const filename = boundedFilename(context.request.headers.get("X-File-Name"));
  const metadata = {
    userId: user.id,
    filename,
    updatedAt: timestamp,
    rowCount: String(rowCount)
  };
  const httpMetadata = {
    contentType: EXCEL_CONTENT_TYPE,
    contentDisposition: 'attachment; filename="project-manager-latest.xlsx"'
  };

  let etag: string;
  let archiveKey = "d1:cloud_excel_latest";
  let state: D1ExcelState;
  let storedR2Object: R2Object | null = null;

  if (r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    // A revision has one immutable key. Concurrent tabs building the same
    // revision reuse the first object instead of creating timestamped copies.
    archiveKey = autosyncObjectKey(user.id, sourceSyncEpoch, sourceSyncCursor);
    const createOnly = new Headers({ "If-None-Match": "*" });
    const uploaded = await context.env.BACKUPS.put(archiveKey, bytes, {
      onlyIf: createOnly,
      httpMetadata,
      customMetadata: { ...metadata, sourceSyncEpoch, sourceSyncCursor: String(sourceSyncCursor) }
    });
    storedR2Object = uploaded ?? await context.env.BACKUPS.head(archiveKey);
    if (!storedR2Object) return apiError(503, "Could not read the stored Excel snapshot");
    etag = storedR2Object.httpEtag;
    state = {
      r2Key: archiveKey,
      etag,
      filename,
      updatedAt: timestamp,
      size: storedR2Object.size,
      sourceSyncEpoch,
      sourceSyncCursor
    };
  } else {
    etag = await sha256Etag(bytes);
    state = {
      dataBase64: bytesToBase64(bytes),
      etag,
      filename,
      updatedAt: timestamp,
      size: bytes.byteLength,
      sourceSyncEpoch,
      sourceSyncCursor
    };
    // D1 caps a single string/row at 2 MB, and base64 inflates the file by
    // ~4/3 — so the real limit is on the JSON payload, not the raw bytes.
    const payload = JSON.stringify(state);
    if (payload.length > 1_900_000) {
      return apiError(413, "Excel file is too large for D1 fallback. Enable R2 for larger files.");
    }
  }

  const payload = JSON.stringify(state);
  const metadataPayload = JSON.stringify({ ...state, dataBase64: undefined });
  const pointerStatement = context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at, sync_seq)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sync_state WHERE user_id = ? AND epoch = ? AND seq >= ?
     )
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq
     WHERE
       COALESCE(json_extract(app_settings.value_json, '$.sourceSyncEpoch'), '') <>
         COALESCE(json_extract(excluded.value_json, '$.sourceSyncEpoch'), '')
       OR app_settings.sync_seq <= excluded.sync_seq`
  )
    .bind(
      user.id,
      D1_EXCEL_STATE_KEY,
      payload,
      timestamp,
      sourceSyncCursor,
      user.id,
      sourceSyncEpoch,
      sourceSyncCursor
    );
  const advanceForDirtyClear = context.env.DB.prepare(
    `UPDATE sync_state
     SET seq = seq + 1, last_operation_id = NULL
     WHERE user_id = ? AND epoch = ?
       AND EXISTS (
         SELECT 1 FROM app_settings
         WHERE user_id = ? AND key = ? AND sync_seq <= ? AND value_json <> 'null'
       )`
  ).bind(user.id, sourceSyncEpoch, user.id, EXCEL_DIRTY_SETTING_KEY, sourceSyncCursor);
  const metadataStatement = context.env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at, sync_seq)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM app_settings
       WHERE user_id = ? AND key = ? AND sync_seq = ?
         AND json_extract(value_json, '$.sourceSyncEpoch') = ?
         AND json_extract(value_json, '$.etag') = ?
     )
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq
     WHERE
       COALESCE(json_extract(app_settings.value_json, '$.sourceSyncEpoch'), '') <>
         COALESCE(json_extract(excluded.value_json, '$.sourceSyncEpoch'), '')
       OR app_settings.sync_seq <= excluded.sync_seq`
  ).bind(
    user.id,
    D1_EXCEL_METADATA_KEY,
    metadataPayload,
    timestamp,
    sourceSyncCursor,
    user.id,
    D1_EXCEL_STATE_KEY,
    sourceSyncCursor,
    sourceSyncEpoch,
    etag
  );
  const clearDirtyStatement = context.env.DB.prepare(
    `UPDATE app_settings
     SET value_json = 'null', updated_at = ?,
         sync_seq = (SELECT seq FROM sync_state WHERE user_id = ?)
     WHERE user_id = ? AND key = ? AND sync_seq <= ? AND value_json <> 'null'
       AND EXISTS (SELECT 1 FROM sync_state WHERE user_id = ? AND epoch = ?)`
  ).bind(timestamp, user.id, user.id, EXCEL_DIRTY_SETTING_KEY, sourceSyncCursor, user.id, sourceSyncEpoch);

  let pointerWrite: D1Result<unknown>;
  try {
    [pointerWrite] = await context.env.DB.batch([
      pointerStatement,
      metadataStatement,
      advanceForDirtyClear,
      clearDirtyStatement
    ]);
  } catch (error) {
    // Keep a stable R2 revision on an ambiguous D1 failure. Another concurrent
    // request may already have committed the same key; a later successful
    // upload will remove any genuinely unreferenced history.
    return apiError(500, error instanceof Error ? error.message : "Could not store Excel snapshot");
  }

  if (Number(pointerWrite.meta?.changes ?? 0) === 0) {
    if (storedR2Object && context.env.BACKUPS) {
      const rejectedKey = storedR2Object.key;
      try {
        await retryR2Maintenance(() => removeRejectedAutosyncObject(context, user.id, rejectedKey));
      } catch (error) {
        reportR2MaintenanceError("rejected cloud Excel R2 cleanup failed", error);
        return apiError(503, "Could not clean up the rejected Excel snapshot");
      }
    }
    return apiError(409, "A newer Excel snapshot is already stored");
  }

  if (storedR2Object && context.env.BACKUPS) {
    context.waitUntil(
      retryR2Maintenance(() => pruneAutosyncHistory(
          context.env.BACKUPS!,
          user.id,
          sourceSyncEpoch,
          sourceSyncCursor,
          storedR2Object!.uploaded
        ))
        .catch((error) => reportR2MaintenanceError("cloud Excel R2 retention failed", error))
    );
  }

  return json({
    ok: true,
    key: state.r2Key ?? LATEST_EXCEL_KEY,
    archiveKey,
    etag,
    updatedAt: timestamp
  });
}
