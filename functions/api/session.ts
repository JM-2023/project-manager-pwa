import { authenticate, authMode, isResponse } from "./_utils/auth";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

function excelAutosyncEnabled(context: AppContext): boolean {
  return (context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS)) || context.env.ENABLE_D1_EXCEL_STATE === "true";
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  return json({
    user: { email: user.email },
    serverTime: nowIso(),
    schemaVersion: 6,
    features: {
      r2Backups: context.env.ENABLE_R2_BACKUPS === "true",
      excelAutosync: excelAutosyncEnabled(context),
      authMode: authMode(context.env)
    }
  });
}
