import type { AppContext } from "./types";

const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_BLOCK_MS = 15 * 60 * 1000;
const IP_MAX_ATTEMPTS = 5;
const OWNER_WINDOW_MS = 15 * 60 * 1000;
const OWNER_BLOCK_MS = 30 * 60 * 1000;
const OWNER_MAX_ATTEMPTS = 20;

interface ReservedAttemptRow {
  attempts: number;
  blocked_until: string | null;
  last_reservation_id: string | null;
}

interface ActiveBlockRow extends ReservedAttemptRow {
  key: string;
}

interface LimitSpec {
  key: string;
  maxAttempts: number;
  windowMs: number;
  blockMs: number;
}

export interface RateLimitReservation {
  allowed: boolean;
  keys: string[];
  retryAfterSeconds: number;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function digestKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function limitSpecs(context: AppContext, scope: "login" | "setup" | "change-password"): Promise<LimitSpec[]> {
  const forwarded = context.request.headers.get("CF-Connecting-IP") ?? context.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  const address = forwarded || "unknown";
  const owner = (context.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  const [ipDigest, ownerDigest] = await Promise.all([
    digestKey(`${owner}:${address}`),
    digestKey(owner)
  ]);
  return [
    { key: `${scope}:ip:${ipDigest}`, maxAttempts: IP_MAX_ATTEMPTS, windowMs: IP_WINDOW_MS, blockMs: IP_BLOCK_MS },
    { key: `${scope}:owner:${ownerDigest}`, maxAttempts: OWNER_MAX_ATTEMPTS, windowMs: OWNER_WINDOW_MS, blockMs: OWNER_BLOCK_MS }
  ];
}

async function reserveOne(context: AppContext, spec: LimitSpec, reservationId: string, now: number): Promise<ReservedAttemptRow | null> {
  const timestamp = iso(now);
  const windowCutoff = iso(now - spec.windowMs);
  const blockedUntil = iso(now + spec.blockMs);
  const reserved = await context.env.DB.prepare(
    `INSERT INTO auth_rate_limits (
       key, attempts, window_started, blocked_until, updated_at, last_reservation_id
     )
     VALUES (?, 1, ?, NULL, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE
         WHEN auth_rate_limits.window_started <= ? THEN 1
         ELSE auth_rate_limits.attempts + 1
       END,
       window_started = CASE
         WHEN auth_rate_limits.window_started <= ? THEN excluded.window_started
         ELSE auth_rate_limits.window_started
       END,
       blocked_until = CASE
         WHEN auth_rate_limits.window_started <= ? THEN NULL
         WHEN auth_rate_limits.attempts + 1 >= ? THEN ?
         ELSE NULL
       END,
       updated_at = excluded.updated_at,
       last_reservation_id = excluded.last_reservation_id
     WHERE auth_rate_limits.blocked_until IS NULL OR auth_rate_limits.blocked_until <= ?
     RETURNING attempts, blocked_until, last_reservation_id`
  )
    .bind(
      spec.key,
      timestamp,
      timestamp,
      reservationId,
      windowCutoff,
      windowCutoff,
      windowCutoff,
      spec.maxAttempts,
      blockedUntil,
      timestamp
    )
    .first<ReservedAttemptRow>();
  if (reserved) return reserved;

  // An active block intentionally takes a read-only path. A no-op UPDATE still
  // counts as a written D1 row, so read the existing deadline after the UPSERT
  // conflict WHERE clause suppresses the write.
  return context.env.DB.prepare(
    "SELECT attempts, blocked_until, last_reservation_id FROM auth_rate_limits WHERE key = ?"
  ).bind(spec.key).first<ReservedAttemptRow>();
}

async function findActiveBlock(context: AppContext, specs: LimitSpec[], now: number): Promise<ActiveBlockRow | null> {
  return context.env.DB.prepare(
    `SELECT key, attempts, blocked_until, last_reservation_id
     FROM auth_rate_limits
     WHERE key IN (${specs.map(() => "?").join(", ")}) AND blocked_until > ?
     ORDER BY blocked_until DESC
     LIMIT 1`
  ).bind(...specs.map((spec) => spec.key), iso(now)).first<ActiveBlockRow>();
}

/**
 * Reserve both an IP-scoped and owner-wide attempt before expensive password
 * verification. Each UPSERT is atomic, so a parallel burst cannot pass the
 * gate by observing the same pre-increment counter.
 */
export async function reserveAuthAttempt(
  context: AppContext,
  scope: "login" | "setup" | "change-password",
  now = Date.now()
): Promise<RateLimitReservation> {
  const specs = await limitSpecs(context, scope);
  const activeBlock = await findActiveBlock(context, specs, now);
  if (activeBlock) {
    const retryAt = Date.parse(activeBlock.blocked_until ?? "");
    return {
      allowed: false,
      keys: specs.map((spec) => spec.key),
      retryAfterSeconds: Number.isFinite(retryAt) ? Math.max(1, Math.ceil((retryAt - now) / 1000)) : 1
    };
  }
  const reservationId = crypto.randomUUID();
  const reservedSpecs: LimitSpec[] = [specs[0]];
  const rows: Array<ReservedAttemptRow | null> = [await reserveOne(context, specs[0], reservationId, now)];
  if (rows[0]?.last_reservation_id === reservationId) {
    reservedSpecs.push(specs[1]);
    rows.push(await reserveOne(context, specs[1], reservationId, now));
  }

  const allowed = rows.every((row) => row?.last_reservation_id === reservationId);
  const retryAt = Math.max(
    0,
    ...rows.map((row) => {
      const parsed = row?.blocked_until ? Date.parse(row.blocked_until) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    })
  );

  if (allowed) {
    const retentionCutoff = iso(now - 30 * 24 * 60 * 60 * 1000);
    context.waitUntil(
      context.env.DB.prepare("DELETE FROM auth_rate_limits WHERE updated_at < ?")
        .bind(retentionCutoff)
        .run()
        .then(() => undefined)
    );
  }

  return {
    allowed,
    keys: reservedSpecs.map((spec) => spec.key),
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((retryAt - now) / 1000))
  };
}

export async function clearAuthAttempts(context: AppContext, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  await context.env.DB.prepare(`DELETE FROM auth_rate_limits WHERE key IN (${placeholders})`).bind(...keys).run();
}
