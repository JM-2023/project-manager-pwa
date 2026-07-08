# Access-Control Hardening Guideline

## Goal

No one may read or modify the project/task data without presenting the correct
passcode. This document records a security review of the authentication and
data-access paths, and gives concrete, prioritized remediation steps for every
gap that could let data be reached without the correct password.

**Out of scope (accepted risk, by owner's decision):** server-side login retry
/ rate limiting. See [Accepted Risks](#accepted-risks) for the one caveat that
still matters even though rate limiting itself is not being added.

## Verdict (what is already correct)

The core access model is sound. Do **not** rewrite it; only harden the edges
below.

- Every data endpoint calls `authenticate(context)` before touching D1:
  `bootstrap`, `session`, `export-data`, `import`, `mutations`, `restore`,
  `excel-state` (HEAD/GET/POST), `backups`, `backups/[id]`, and
  `auth/change-password`. There is no data endpoint that skips it.
- The four public endpoints are public **by design** and expose no data:
  `auth/login`, `auth/logout`, `auth/status` (returns only `authMode` +
  `needsSetup`), and `auth/setup` (gated — see Finding 1).
- Sessions are stateless HMAC-SHA256 tokens (`payload.signature`) keyed by
  `SESSION_SECRET`. The payload carries `email`, `exp`, `gen`, and a random
  `nonce`; it is verified with a timing-safe comparison
  (`functions/api/_utils/auth.ts:191`). A token cannot be forged or altered
  without the secret.
- Passcodes are stored only as PBKDF2-SHA256 hashes (210k iterations, per-hash
  salt) in D1, never in code or the bundle. Verification is timing-safe and
  rejects hashes weaker than 100k iterations
  (`functions/api/_utils/auth.ts:118`).
- Single-owner is enforced: `authenticate` rejects any identity whose email is
  not `OWNER_EMAIL` with 403 (`functions/api/_utils/auth.ts:253`).
- If `SESSION_SECRET` is missing the code fails closed (throws), never
  defaulting to a guessable key (`functions/api/_utils/auth.ts:177`).

The findings below are therefore **not** "the password check is broken." They
are conditions under which the guarantee can be bypassed via configuration, the
first-run window, or local device access.

---

## Findings and Fixes

Severity uses: **High** (can lead to data access without the passcode under a
realistic scenario), **Medium** (weakens the guarantee or a plausible
misconfiguration removes it), **Low** (defense-in-depth / hardening).

### Finding 1 — First-run setup is unauthenticated (Trust-On-First-Use takeover) — High

**Where:** `functions/api/auth/setup.ts:13`, `functions/api/auth/status.ts:5`

**What:** When no passcode is configured (no stored hash **and** no
`APP_PASSWORD_HASH`), `/api/auth/status` publicly returns `needsSetup: true`,
and `/api/auth/setup` lets *any* unauthenticated caller POST a 4-digit PIN and
receive a valid session cookie. Login is impossible in this state
(`verifyPassword(..., null)` is always false), so setup is the only door — and
it is open to the whole internet.

**Impact:** Whoever reaches a not-yet-configured deployment first can claim the
account, lock out the legitimate owner, and — critically — **read any data that
already exists in D1** (e.g. rows seeded by a migration, a direct
`wrangler d1 execute`, or a restore run out-of-band before the owner set the
PIN). This is a direct "data without the owner's password" path during the
setup window.

**Fix (choose one; the first is simplest and matches current README guidance):**

1. **Always pre-seed the passcode at deploy time.** Make `APP_PASSWORD_HASH`
   mandatory for production so the app is *never* in the `needsSetup` state on a
   public URL:
   ```bash
   npm run hash-password -- "<pin>"
   npx wrangler pages secret put APP_PASSWORD_HASH
   ```
   With a hash present, `configuredPasswordHash()` is non-null, `/api/auth/setup`
   returns `409`, and `/api/auth/status` reports `needsSetup: false`.

2. **Gate first-run setup behind a deploy-time token.** Add a `SETUP_TOKEN`
   secret and require it in the setup request, so a random visitor cannot call
   it even during the window:
   ```ts
   // functions/api/auth/setup.ts, after requireSameOrigin(...)
   const provided = context.request.headers.get("X-Setup-Token") ?? "";
   if (!context.env.SETUP_TOKEN || provided !== context.env.SETUP_TOKEN) {
     return apiError(403, "Setup token required");
   }
   ```
   (The owner enters the token once on the first-run screen.)

3. **Bind first-run to a private network / Cloudflare Access** for the initial
   visit, then relax. Heavier; only if you cannot pre-seed.

**Recommended:** Option 1 for all real deployments; add Option 2 if fresh
deployments must occasionally be reachable before the owner can set the PIN.

---

### Finding 2 — The whole guarantee reduces to `SESSION_SECRET` strength — High

**Where:** `functions/api/_utils/auth.ts:176` (mint), `:203` (verify)

**What:** A valid session is exactly `payload.HMAC(SESSION_SECRET, payload)`. The
password is checked **once** at login; from then on access depends only on the
secrecy and entropy of `SESSION_SECRET`. The code fails closed if the secret is
absent, but it does **not** check that the secret is long or random. A short,
reused, or leaked secret lets an attacker forge a cookie for `OWNER_EMAIL` and
bypass the passcode entirely.

**Impact:** Full data access without ever knowing the passcode, if the secret is
weak or exposed (e.g. committed to a `.dev.vars` that leaks, copied from an
example, or brute-forced because it is short).

**Fix:**

1. **Generate a high-entropy secret** (≥ 32 bytes) and store it only as a
   Cloudflare secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" \
     | npx wrangler pages secret put SESSION_SECRET
   ```
2. **Enforce a minimum length at runtime** so a weak secret fails closed instead
   of silently protecting nothing. In `createSessionCookie` and
   `userFromLocalSession`:
   ```ts
   if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
     throw new Error("SESSION_SECRET missing or too weak");
   }
   ```
3. **Rotation procedure:** rotating `SESSION_SECRET` invalidates all existing
   cookies (HMAC no longer matches) and forces re-login everywhere — do this if
   the secret is ever suspected leaked. Keep it out of git (`.dev.vars` and
   `.env*` are already gitignored — verified).

---

### Finding 3 — `AUTH_MODE=none` disables all authentication — Medium

**Where:** `functions/api/_utils/auth.ts:60` and `:243`

**What:** With `AUTH_MODE=none`, `authenticate` returns the owner user with **no
credential check at all** — every data endpoint becomes public. The default in
`wrangler.toml` is `local_password`, but this is a one-line misconfiguration
away from exposing everything.

**Impact:** A deploy or env slip to `none` serves all data to anyone with the
URL, no passcode involved.

**Fix:**

1. **Never set `none` in production.** Reserve it for isolated local dev only.
2. **Guard against it at runtime** so a production misconfig fails loudly rather
   than silently opening the app. For example, refuse `none` unless an explicit
   `ALLOW_INSECURE_NO_AUTH=true` is also set:
   ```ts
   export function authMode(env: AppEnv): "none" | "local_password" | "cloudflare_access" {
     if (env.AUTH_MODE === "none") {
       if (env.ALLOW_INSECURE_NO_AUTH !== "true") {
         throw new Error("AUTH_MODE=none requires ALLOW_INSECURE_NO_AUTH=true");
       }
       return "none";
     }
     return env.AUTH_MODE === "cloudflare_access" ? "cloudflare_access" : "local_password";
   }
   ```
3. **Add a deployment check** (CI or a smoke test) asserting production responds
   `401` to an unauthenticated `GET /api/bootstrap`.

---

### Finding 4 — Local data at rest is unencrypted and outlives the login screen — Medium

**Where:** `src/App.tsx:100` (startup order), `src/App.tsx:564` (logout),
`src/lib/localDb.ts:197` (`resetLocalData`),
`functions/api/_utils/auth.ts:181` (30-day cookie)

**What:** The passcode gates the **network API** and the **login screen**, not
the on-device copy. All projects/tasks are mirrored in **IndexedDB in
plaintext**. Anyone with access to the unlocked device or browser profile can
open DevTools and read the IndexedDB stores directly, without entering the
passcode. Two factors widen the window:

- The session cookie lasts **30 days** (`Max-Age` = 60·60·24·30), so reopening
  the app within that period skips the passcode entirely.
- Local data is cleared **only on explicit logout** (`resetLocalData()` in
  `handleLogout`). Closing the tab or navigating away leaves the plaintext copy
  in IndexedDB. (Note: on startup `getSession()` runs before the local snapshot
  is rendered, so an *expired* session does show the login screen — but the raw
  IndexedDB rows are still physically present and readable via DevTools.)

**Impact:** On a shared or lost device, data is readable without the passcode.
This is the largest residual gap versus "no one accesses the data without the
password" for the local-device threat model.

**Fix (pick per threat model; these are defense-in-depth, not a full E2E-crypto
rebuild):**

1. **Shorten the session and add an idle timeout.** Reduce `Max-Age` (e.g. 24h)
   and/or store a `lastActive` timestamp; require re-entering the passcode after
   N minutes of inactivity or on each cold start. This re-gates the UI far more
   often.
2. **Add an explicit "Lock now" control** (in addition to full sign-out) that
   returns to the passcode screen without wiping IndexedDB, plus auto-lock on
   `visibilitychange → hidden`.
3. **Document the device-security assumption** in the README: the passcode
   protects the *server* copy; the *local* copy relies on OS/browser profile
   security. Recommend full-disk encryption and OS login for any device running
   the app.
4. **For strong local confidentiality**, prefer `AUTH_MODE=cloudflare_access`
   (device/identity enforced at the edge) or encrypt IndexedDB values with a key
   derived from the passcode (largest change; only if the threat model needs
   at-rest encryption on the device).

---

### Finding 5 — No central auth guard; each endpoint must remember `authenticate()` — Low

**Where:** all `functions/api/**` handlers; `functions/_middleware.ts:22` only
sets security headers, it does not enforce auth.

**What:** Authentication is opt-in per handler. Today every data route calls
`authenticate()` (verified), but nothing *structurally* prevents a future
endpoint from forgetting it and shipping a public data leak.

**Impact:** A latent footgun — one missed call in a new route = unauthenticated
data access.

**Fix:** Make protection the default. Enforce auth centrally in the middleware
and let only an explicit allowlist through, so new routes are private unless
deliberately opened:
```ts
// functions/_middleware.ts (sketch)
const PUBLIC_PATHS = new Set([
  "/api/auth/login", "/api/auth/logout", "/api/auth/status", "/api/auth/setup"
]);
export async function onRequest(context: AppContext): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith("/api/") && !PUBLIC_PATHS.has(url.pathname)) {
    const user = await authenticate(context);
    if (isResponse(user)) return withSecurityHeaders(user);
  }
  return withSecurityHeaders(await context.next());
}
```
Keep the per-handler `authenticate()` calls too (defense in depth); the
middleware is the safety net. Add a test asserting every non-public `/api/*`
route returns `401` without a session.

---

### Finding 6 — `requireSameOrigin` allows a missing `Origin` header — Low

**Where:** `functions/api/_utils/response.ts:19`

**What:** The origin check returns "OK" when no `Origin` header is present. CSRF
is already mitigated by `SameSite=Lax` cookies (cross-site POSTs don't send the
session), so this is defense-in-depth, but the permissive branch is worth
tightening for state-changing requests.

**Impact:** Low. No practical bypass given `SameSite=Lax`, but the check is
weaker than it looks.

**Fix:** For POST/mutation routes, treat a missing `Origin` as suspicious unless
a same-origin `Referer` (or `Sec-Fetch-Site: same-origin`) is present:
```ts
const site = request.headers.get("Sec-Fetch-Site");
if (site && site !== "same-origin" && site !== "none") {
  return apiError(403, "Invalid origin");
}
```
Keep it lenient enough not to break same-origin `fetch`, which already sends a
correct `Origin`.

---

### Finding 7 — Cloudflare Access verification errors surface as 500, not 401 — Low

**Where:** `functions/api/_utils/auth.ts:219` (`userFromAccess`) and `:236`
(`authenticate` has no try/catch around the mode calls)

**What:** In `cloudflare_access` mode, a malformed/expired JWT makes `jwtVerify`
throw, which propagates as a `500`. This is **not** a bypass (the client only
treats `401` as "log in"; a `500` denies access), but it degrades UX and muddies
logs.

**Fix:** Catch verification failures and return `401`:
```ts
try {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
} catch {
  return null; // -> authenticate() returns 401
}
```

---

## Accepted Risks

- **No server-side login rate limiting (accepted).** Per the owner's decision
  this is intentionally not being fixed. Record the trade-off explicitly: the
  passcode is a **4-digit PIN (10,000 combinations)**, and `/api/auth/login`
  currently accepts unlimited attempts, so the PIN is brute-forceable given
  time. Two things keep this from being catastrophic today — PBKDF2 makes each
  guess relatively expensive, and Finding 1/2 fixes stop the *cheaper* bypasses
  — but if this risk is ever revisited, the cheapest mitigations are: raise the
  PIN length/complexity, add Cloudflare rate-limiting rules or Turnstile in
  front of `/api/auth/login`, or introduce a short exponential backoff. No code
  change is requested now; this note exists so the decision is documented rather
  than forgotten.

---

## Deployment Checklist (enforce the guarantee)

Before exposing any deployment publicly, confirm:

- [ ] `AUTH_MODE` is `local_password` or `cloudflare_access` — **never** `none`.
- [ ] `SESSION_SECRET` is set as a Cloudflare secret, ≥ 32 random bytes, and not
      present in git or `.dev.vars` committed anywhere.
- [ ] `APP_PASSWORD_HASH` is pre-seeded (Finding 1, Option 1) **or** a
      `SETUP_TOKEN` gate is in place, so the app is never in an open
      `needsSetup` state on a public URL.
- [ ] `OWNER_EMAIL` matches the only identity allowed in.
- [ ] Unauthenticated `GET /api/bootstrap` returns `401` (smoke test).
- [ ] Unauthenticated `POST /api/auth/setup` returns `409`/`403` on an already
      configured or token-gated deployment.
- [ ] Devices running the app use full-disk encryption and an OS lock
      (Finding 4).

## Rule for Adding New Endpoints

Any new route under `functions/api/` that reads or writes user data **must**
call `authenticate(context)` and bail on `isResponse(user)` before any D1
access — or rely on the central guard from Finding 5. Add a test that the new
route returns `401` without a valid session. Treat "public by default" as a bug.
