import { authenticate, authMode, createSessionCookie, hashPassword, isResponse, ownerEmail, savePasswordHash, verifyLocalPassword } from "../_utils/auth";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

function validPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  if (authMode(context.env) !== "local_password") {
    return apiError(404, "Local password change is disabled");
  }
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  const body = await readJson<ChangePasswordBody>(context.request, 20_000);
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (!validPin(newPassword)) {
    return apiError(400, "Passcode must be 4 digits");
  }
  if (!(await verifyLocalPassword(context.env, currentPassword))) {
    return apiError(401, "Invalid login");
  }

  await savePasswordHash(context.env, await hashPassword(newPassword));
  return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, ownerEmail(context.env)) } });
}
