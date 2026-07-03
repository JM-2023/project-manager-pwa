# Private Project Manager PWA

An iPhone-first project and task manager for Cloudflare Pages, Pages Functions, and D1. The live data source is D1. Excel files are used for first import, manual export, and backups.

The deployment mode in `wrangler.toml` is `AUTH_MODE=local_password`: the app is protected by a 4-digit passcode.

## Passcode

- **First run** — on a fresh database the login screen asks you to create a passcode. It is stored as a PBKDF2 hash in D1 (`app_settings`), never in the code or the bundle.
- **Change it** — Settings -> Security -> Change passcode (current passcode required). The old passcode stops working immediately.
- **Pre-seeded passcode** -- until a passcode has been created in-app, a deploy-time `APP_PASSWORD_HASH` secret is accepted. Creating or changing a passcode in-app revokes that deploy-time hash. There is no built-in default passcode.

Redeploying the app never resets the passcode: it lives in D1, and deploys only replace code. `SESSION_SECRET` must be set (secret or `.dev.vars`) for login to work in any case.

## Local Setup

Use Node.js 20 or newer because Wrangler requires it.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Optional: pre-seed a login passcode instead of using the first-run setup screen:

   ```bash
   npm run hash-password -- "1234"
   ```

3. Create `.dev.vars` (`APP_PASSWORD_HASH` is optional — without it, a fresh database shows the create-passcode screen):

   ```text
   AUTH_MODE=local_password
   OWNER_EMAIL=owner@project-manager.local
   APP_PASSWORD_HASH=<output-from-hash-password>
   SESSION_SECRET=<long-random-secret>
   ENABLE_R2_BACKUPS=false
   ```

4. Create and migrate D1:

   ```bash
   npx wrangler d1 create project_manager
   npm run db:migrate:local
   ```

5. Start the local Pages runtime:

   ```bash
   npm run pages:dev
   ```

## Cloudflare Setup

Create the D1 database in Cloudflare, copy the returned `database_id` into `wrangler.toml`, and apply migrations:

```bash
npx wrangler d1 create project_manager
npm run db:migrate:remote
```

Set the session secret in the Cloudflare dashboard or through Wrangler (required for login). `APP_PASSWORD_HASH` is optional — a fresh deployment without it asks you to create a passcode on first visit:

```bash
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put APP_PASSWORD_HASH   # optional pre-seeded passcode
```

For Cloudflare Access mode, set:

```text
AUTH_MODE=cloudflare_access
OWNER_EMAIL=you@example.com
ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
ACCESS_AUD=<application-audience-tag>
```

## Optional R2 Backups

Create an R2 bucket, uncomment the `[[r2_buckets]]` block in `wrangler.toml`, set `ENABLE_R2_BACKUPS=true`, and redeploy. Excel export still works as a direct browser download while R2 is disabled.

## Workbook Import Notes

The importer recognizes common English headers and equivalent Chinese-language headers, including Project, Task, Importance, Progress, Today's output, Blocked on, Tomorrow's first step, and Notes. It maps workbook rows into projects, tasks, priorities, statuses, next actions, notes, and preserved extra columns.
