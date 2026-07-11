import { authMode, configuredPasswordHash } from "../_utils/auth";
import { json } from "../_utils/response";
import type { AppContext } from "../_utils/types";

export async function onRequestGet(context: AppContext): Promise<Response> {
  const mode = authMode(context.env);
  const hasConfiguredPassword = mode === "local_password" ? Boolean(await configuredPasswordHash(context.env)) : true;
  const needsSetup = mode === "local_password" && !hasConfiguredPassword;
  return json({
    authMode: mode,
    needsSetup,
    setupTokenRequired: needsSetup,
    setupAvailable: !needsSetup || Boolean(context.env.SETUP_TOKEN && context.env.SETUP_TOKEN.length >= 16)
  });
}
