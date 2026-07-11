import { authenticate, isResponse } from "../_utils/auth";
import { apiError } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (context.env.ENABLE_R2_BACKUPS !== "true" || !context.env.BACKUPS) {
    return apiError(404, "R2 backups are disabled");
  }

  const id = context.params.id;
  const row = await context.env.DB.prepare("SELECT r2_key FROM export_logs WHERE user_id = ? AND id = ?")
    .bind(user.id, id)
    .first<{ r2_key: string | null }>();
  if (!row?.r2_key) {
    return apiError(404, "Backup not found");
  }

  const object = await context.env.BACKUPS.get(row.r2_key);
  if (!object) {
    return apiError(404, "Backup object not found");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", headers.get("Content-Type") ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return new Response(object.body, { headers });
}
