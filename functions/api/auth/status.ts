import { authMode, configuredPasswordHash } from "../_utils/auth";
import { json } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const mode = authMode(context.env);
  const hasConfiguredPassword = mode === "local_password" ? Boolean(await configuredPasswordHash(context.env)) : true;
  return json({
    authMode: mode,
    needsSetup: mode === "local_password" && !hasConfiguredPassword
  });
}
