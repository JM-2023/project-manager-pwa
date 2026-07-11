import { authenticate, isResponse } from "../_utils/auth";
import { apiError, json, readBodyBytes, RequestBodyTooLargeError, requireSameOrigin } from "../_utils/response";
import { nowIso } from "../_utils/time";
import type { AppContext } from "../_utils/types";

function backupsEnabled(context: AppContext): boolean {
  return context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS);
}

function backupKey(timestamp: string, userId: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const stamp = timestamp.replace(/[:.]/g, "-");
  return `exports/${userId}/${year}/${month}/project-manager-${stamp}-${crypto.randomUUID()}.xlsx`;
}

function boundedFilename(value: string | null, timestamp: string): string {
  const fallback = `project-manager-${timestamp}.xlsx`;
  const cleaned = (value ?? fallback).replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim();
  let filename = cleaned || fallback;
  while (new TextEncoder().encode(filename).byteLength > 512) filename = filename.slice(0, -1);
  return filename;
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  const rows = await context.env.DB.prepare(
    "SELECT id, format, row_count, r2_key, created_at FROM export_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  )
    .bind(user.id)
    .all();
  return json({ backups: rows.results });
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!backupsEnabled(context) || !context.env.BACKUPS) {
    return apiError(404, "R2 backups are disabled");
  }

  let body: Uint8Array;
  try {
    body = await readBodyBytes(context.request, 10_000_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return apiError(413, "Backup is too large");
    return apiError(400, "Could not read backup body");
  }
  if (body.byteLength === 0) return apiError(400, "Missing backup body");

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const key = backupKey(timestamp, user.id);
  const filename = boundedFilename(context.request.headers.get("X-File-Name"), timestamp);
  const rawRowCount = Number(context.request.headers.get("X-Row-Count") ?? "0");
  const rowCount = Number.isSafeInteger(rawRowCount) && rawRowCount >= 0 ? rawRowCount : 0;

  await context.env.BACKUPS.put(key, body, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`
    },
    customMetadata: {
      userId: user.id,
      filename,
      rowCount: String(rowCount)
    }
  });

  try {
    await context.env.DB.prepare("INSERT INTO export_logs (id, user_id, format, row_count, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, user.id, "xlsx", rowCount, key, timestamp)
      .run();
  } catch (error) {
    await context.env.BACKUPS.delete(key).catch(() => undefined);
    return apiError(500, error instanceof Error ? error.message : "Could not record backup");
  }

  return json({ ok: true, id, r2Key: key });
}
