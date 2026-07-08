import { authMode, configuredPasswordHash, createSessionCookie, hashPassword, ownerEmail, savePasswordHash } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface SetupBody {
  password?: string;
}

function validPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  if (authMode(context.env) !== "local_password") {
    return apiError(404, "Local setup is disabled");
  }
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const email = ownerEmail(context.env);
  if (!email) {
    return apiError(500, "OWNER_EMAIL is missing");
  }
  // Checked up front: createSessionCookie throws without it, and an unhandled
  // throw surfaces in the UI as an unreadable generic failure. Pages binds
  // secrets at deploy time, so a secret added in the dashboard after the last
  // deployment is exactly the misconfiguration this turns into a clear message.
  if (!context.env.SESSION_SECRET) {
    return apiError(500, "SESSION_SECRET is missing");
  }

  if (await configuredPasswordHash(context.env)) {
    return apiError(409, "Passcode already configured");
  }

  const body = await readJson<SetupBody>(context.request, 20_000);
  const password = String(body.password ?? "");
  if (!validPin(password)) {
    return apiError(400, "Passcode must be 4 digits");
  }

  try {
    // Mint the cookie before persisting the hash: if minting fails, nothing was
    // saved, so the passcode state and the "Could not save" error can't diverge.
    const cookie = await createSessionCookie(context.env, email);
    await savePasswordHash(context.env, await hashPassword(password));
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  } catch (error) {
    return apiError(500, error instanceof Error && error.message ? error.message : "Setup failed");
  }
}
