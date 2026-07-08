import { authMode, createSessionCookie, ownerEmail, verifyLocalPassword } from "../_utils/auth";
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

  try {
    const body = await readJson<LoginBody>(context.request, 20_000);
    const ok = await verifyLocalPassword(context.env, String(body.password ?? ""));
    if (!ok) {
      return apiError(401, "Invalid login");
    }
    const email = ownerEmail(context.env);
    if (!email) {
      return apiError(500, "OWNER_EMAIL is missing");
    }
    return json({ ok: true }, { headers: { "Set-Cookie": await createSessionCookie(context.env, email) } });
  } catch {
    return apiError(401, "Invalid login");
  }
}
