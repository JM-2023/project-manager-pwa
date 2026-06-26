import { authenticate, isResponse } from "../_utils/auth";
import { apiError, json, requireSameOrigin } from "../_utils/response";
import { nowIso } from "../_utils/time";
import type { AppContext } from "../_utils/types";

function backupsEnabled(context: AppContext): boolean {
  return context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS);
}

function backupKey(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const stamp = timestamp.replace(/[:.]/g, "-");
  return `exports/${year}/${month}/project-manager-${stamp}.xlsx`;
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

  if (!context.request.body) {
    return apiError(400, "Missing backup body");
  }

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const key = backupKey(timestamp);
  const filename = context.request.headers.get("X-File-Name") ?? `project-manager-${timestamp}.xlsx`;

  await context.env.BACKUPS.put(key, context.request.body, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`
    },
    customMetadata: {
      userId: user.id,
      filename
    }
  });

  await context.env.DB.prepare("INSERT INTO export_logs (id, user_id, format, row_count, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, "xlsx", 0, key, timestamp)
    .run();

  return json({ ok: true, id, r2Key: key });
}
