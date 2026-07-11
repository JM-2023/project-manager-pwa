import {
  authMode,
  configuredPasswordHash,
  createSessionCookie,
  hashPassword,
  ownerEmail,
  savePasswordHashIfAbsent,
  timingSafeEqual
} from "../_utils/auth";
import { clearAuthAttempts, reserveAuthAttempt } from "../_utils/rateLimit";
import { apiError, json, readJson, requireSameOrigin } from "../_utils/response";
import type { AppContext } from "../_utils/types";

interface SetupBody {
  password?: string;
  setupToken?: string;
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
  if (!context.env.SETUP_TOKEN || context.env.SETUP_TOKEN.length < 16) {
    return apiError(503, "SETUP_TOKEN must contain at least 16 characters before first-run setup.");
  }

  const reservation = await reserveAuthAttempt(context, "setup");
  if (!reservation.allowed) {
    return json(
      { error: "Too many setup attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } }
    );
  }

  let body: SetupBody;
  try {
    body = await readJson<SetupBody>(context.request, 20_000);
  } catch {
    return apiError(400, "Invalid setup request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "Invalid setup request");
  const password = String(body.password ?? "");
  if (!validPin(password)) {
    return apiError(400, "Passcode must be 4 digits");
  }
  if (!(await timingSafeEqual(String(body.setupToken ?? ""), context.env.SETUP_TOKEN))) {
    return apiError(403, "Invalid setup token");
  }

  try {
    // Mint the cookie before persisting the hash: if minting fails, nothing was
    // saved, so the passcode state and the "Could not save" error can't diverge.
    const cookie = await createSessionCookie(context.env, email);
    const claimed = await savePasswordHashIfAbsent(context.env, await hashPassword(password));
    if (!claimed) {
      return apiError(409, "Passcode already configured");
    }
    await clearAuthAttempts(context, reservation.keys).catch(() => undefined);
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  } catch (error) {
    return apiError(500, error instanceof Error && error.message ? error.message : "Setup failed");
  }
}
