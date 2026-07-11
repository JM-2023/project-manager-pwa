import { authMode, createSessionCookie, ownerEmail, verifyLocalPassword } from "../_utils/auth";
import { clearAuthAttempts, reserveAuthAttempt } from "../_utils/rateLimit";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface LoginBody {
  password?: string;
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  if (authMode(context.env) !== "local_password") {
    return apiError(404, "Local login is disabled");
  }
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  // Without this, createSessionCookie's throw lands in the catch below and a
  // missing secret masquerades as 401 "Invalid login" even for the correct
  // passcode. Server misconfiguration must not look like a wrong password.
  if (!context.env.SESSION_SECRET) {
    return apiError(500, "SESSION_SECRET is missing");
  }
  const email = ownerEmail(context.env);
  if (!email) {
    return apiError(500, "OWNER_EMAIL is missing");
  }

  const reservation = await reserveAuthAttempt(context, "login");
  if (!reservation.allowed) {
    return json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } }
    );
  }

  let body: LoginBody;
  try {
    body = await readJson<LoginBody>(context.request, 20_000);
  } catch {
    return apiError(401, "Invalid login");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(401, "Invalid login");

  const ok = await verifyLocalPassword(context.env, String(body.password ?? ""));
  if (!ok) {
    return apiError(401, "Invalid login");
  }
  await clearAuthAttempts(context, reservation.keys);
  return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, email) } });
}
