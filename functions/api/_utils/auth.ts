import { getOrCreateUser } from "./db";
import { apiError } from "./response";
import { nowIso } from "./time";
import type { AppContext, AppEnv, AuthUser } from "./types";

const encoder = new TextEncoder();
const SESSION_COOKIE = "pm_session";
const LOCAL_PASSWORD_HASH_SETTING_KEY = "local_password_hash";
// Bumped on every passcode change. Cookies embed the generation they were
// minted with; a mismatch invalidates them, so changing the passcode signs
// every other device out even though the HMAC secret stays the same.
const SESSION_GENERATION_SETTING_KEY = "session_generation";
// The deployed Workers runtime rejects PBKDF2 above 100k iterations
// ("Pbkdf2 failed: iteration counts above 100000 are not supported").
// 100k is therefore the strongest hash production can mint or verify; local
// `wrangler pages dev` does not enforce the cap, so only production catches
// violations. Must stay within [100k, runtime cap] — verifyPassword rejects
// anything weaker than 100k.
const HASH_ITERATIONS = 100_000;

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(signature);
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) {
    return subtle.timingSafeEqual(leftHash, rightHash);
  }
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function authMode(env: AppEnv): "none" | "local_password" | "cloudflare_access" {
  if (env.AUTH_MODE === "none") {
    return "none";
  }
  return env.AUTH_MODE === "cloudflare_access" ? "cloudflare_access" : "local_password";
}

export function ownerEmail(env: AppEnv): string {
  return (env.OWNER_EMAIL ?? "").trim().toLowerCase();
}

function normalizePasswordHash(hashSetting: string | undefined | null): string | null {
  const normalized = hashSetting?.trim().replace(/^['"]|['"]$/g, "");
  return normalized || null;
}

async function readStoredPasswordHash(env: AppEnv): Promise<string | null> {
  const email = ownerEmail(env);
  if (!email) return null;
  const user = await getOrCreateUser(env, email);
  const row = await env.DB.prepare("SELECT value_json FROM app_settings WHERE user_id = ? AND key = ?")
    .bind(user.id, LOCAL_PASSWORD_HASH_SETTING_KEY)
    .first<{ value_json: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as { hash?: unknown };
    return typeof parsed.hash === "string" ? normalizePasswordHash(parsed.hash) : null;
  } catch {
    return null;
  }
}

export async function configuredPasswordHash(env: AppEnv): Promise<string | null> {
  return (await readStoredPasswordHash(env)) ?? normalizePasswordHash(env.APP_PASSWORD_HASH);
}

export async function savePasswordHash(env: AppEnv, hash: string): Promise<void> {
  const email = ownerEmail(env);
  if (!email) {
    throw new Error("OWNER_EMAIL is missing");
  }
  const user = await getOrCreateUser(env, email);
  await env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(user.id, LOCAL_PASSWORD_HASH_SETTING_KEY, JSON.stringify({ hash }), nowIso())
    .run();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations: HASH_ITERATIONS }, key, 256);
  return `pbkdf2_sha256$${HASH_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

export async function verifyPassword(password: string, hashSetting: string | undefined | null): Promise<boolean> {
  const normalizedHash = normalizePasswordHash(hashSetting);
  if (!normalizedHash) {
    return false;
  }

  try {
    const [algorithm, iterationsText, saltText, expectedText] = normalizedHash.split("$");
    const iterations = Number(iterationsText);
    if (algorithm === "pbkdf2_sha256" && Number.isInteger(iterations) && iterations >= 100_000) {
      const salt = base64UrlDecode(saltText);
      const expected = base64UrlDecode(expectedText);
      const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations }, key, expected.length * 8);
      if (await timingSafeEqual(base64UrlEncode(derived), base64UrlEncode(expected))) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

export async function verifyLocalPassword(env: AppEnv, password: string): Promise<boolean> {
  return verifyPassword(password, (await readStoredPasswordHash(env)) ?? env.APP_PASSWORD_HASH);
}

async function readSessionGeneration(env: AppEnv): Promise<number> {
  const email = ownerEmail(env);
  if (!email) return 0;
  const user = await getOrCreateUser(env, email);
  const row = await env.DB.prepare("SELECT value_json FROM app_settings WHERE user_id = ? AND key = ?")
    .bind(user.id, SESSION_GENERATION_SETTING_KEY)
    .first<{ value_json: string }>();
  if (!row) return 0;
  // Tolerate a hand-edited or corrupted row: a malformed value must degrade to
  // generation 0 (cookies just get invalidated), not crash login and setup.
  try {
    const parsed = Number(JSON.parse(row.value_json));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Invalidate every outstanding session cookie (called on passcode change). */
export async function bumpSessionGeneration(env: AppEnv): Promise<void> {
  const email = ownerEmail(env);
  if (!email) {
    throw new Error("OWNER_EMAIL is missing");
  }
  const user = await getOrCreateUser(env, email);
  const next = (await readSessionGeneration(env)) + 1;
  await env.DB.prepare(
    `INSERT INTO app_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
    .bind(user.id, SESSION_GENERATION_SETTING_KEY, JSON.stringify(next), nowIso())
    .run();
}

export async function createSessionCookie(env: AppEnv, email: string): Promise<string> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  const generation = await readSessionGeneration(env);
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ email, exp: expiresAt, gen: generation, nonce: crypto.randomUUID() })));
  const signature = await hmac(env.SESSION_SECRET, payload);
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function userFromLocalSession(env: AppEnv, request: Request): Promise<string | null> {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing");
  }
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!(await timingSafeEqual(signature, expected))) {
    return null;
  }
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { email?: string; exp?: number; gen?: number };
  if (!parsed.email || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  // Cookies minted before the last passcode change carry a stale generation
  // (missing = 0, the pre-feature default) and stop being accepted.
  if ((parsed.gen ?? 0) !== (await readSessionGeneration(env))) {
    return null;
  }
  return parsed.email.toLowerCase();
}

async function userFromAccess(env: AppEnv, request: Request): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new Error("Cloudflare Access environment variables are missing");
  }
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return null;
  }
  const jwks = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD
  });
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}

export async function authenticate(context: AppContext): Promise<AuthUser | Response> {
  const expectedOwner = ownerEmail(context.env);
  if (!expectedOwner) {
    return apiError(500, "OWNER_EMAIL is missing");
  }

  const mode = authMode(context.env);
  const email =
    mode === "none"
      ? expectedOwner
      : mode === "cloudflare_access"
        ? await userFromAccess(context.env, context.request)
        : await userFromLocalSession(context.env, context.request);

  if (!email) {
    return apiError(401, "Authentication required");
  }
  if (email !== expectedOwner) {
    return apiError(403, "Forbidden");
  }

  return getOrCreateUser(context.env, email);
}

export function isResponse(value: AuthUser | Response): value is Response {
  return value instanceof Response;
}
