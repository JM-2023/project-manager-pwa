# Private Project Manager PWA

An iPhone-first project and task manager for Cloudflare Pages, Pages Functions, and D1. The live data source is D1. Excel files are used for first import, manual export, and backups.

The current deployment mode is `AUTH_MODE=none`, so opening the URL enters the app directly. Anyone with the URL can read and change the same D1 data.

## Local Setup

Use Node.js 20 or newer because Wrangler requires it.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Optional: create a local password hash if you later switch `AUTH_MODE` back to `local_password`:

   ```bash
   npm run hash-password -- "your-long-password"
   ```

3. Create `.dev.vars`:

   ```text
   AUTH_MODE=none
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

If you later switch back to password auth, set production secrets in the Cloudflare dashboard or through Wrangler:

```bash
npx wrangler pages secret put APP_PASSWORD_HASH
npx wrangler pages secret put SESSION_SECRET
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
