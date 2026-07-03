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

  if (await configuredPasswordHash(context.env)) {
    return apiError(409, "Passcode already configured");
  }

  const body = await readJson<SetupBody>(context.request, 20_000);
  const password = String(body.password ?? "");
  if (!validPin(password)) {
    return apiError(400, "Passcode must be 4 digits");
  }

  await savePasswordHash(context.env, await hashPassword(password));
  return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, email) } });
}
