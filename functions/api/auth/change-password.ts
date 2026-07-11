import {
  authenticate,
  authMode,
  createSessionCookie,
  hashPassword,
  isResponse,
  ownerEmail,
  replacePasswordHashAndBumpGeneration,
  verifyLocalPassword
} from "../_utils/auth";
import { clearAuthAttempts, reserveAuthAttempt } from "../_utils/rateLimit";
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

  const reservation = await reserveAuthAttempt(context, "change-password");
  if (!reservation.allowed) {
    return json(
      { error: "Too many passcode attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } }
    );
  }

  let body: ChangePasswordBody;
  try {
    body = await readJson<ChangePasswordBody>(context.request, 20_000);
  } catch {
    return apiError(400, "Invalid request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "Invalid request");
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (!validPin(newPassword)) {
    return apiError(400, "Passcode must be 4 digits");
  }
  if (!(await verifyLocalPassword(context.env, currentPassword))) {
    return apiError(401, "Invalid login");
  }

  await replacePasswordHashAndBumpGeneration(context.env, await hashPassword(newPassword));
  await clearAuthAttempts(context, reservation.keys).catch(() => undefined);
  // The fresh cookie carries the incremented generation, keeping this device
  // signed in while every earlier cookie stops validating.
  return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, ownerEmail(context.env)) } });
}
