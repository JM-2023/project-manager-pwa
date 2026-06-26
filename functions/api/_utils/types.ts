export interface AppEnv {
  DB: D1Database;
  BACKUPS?: R2Bucket;
  AUTH_MODE?: "none" | "local_password" | "cloudflare_access";
  OWNER_EMAIL?: string;
  ENABLE_R2_BACKUPS?: string;
  ENABLE_D1_EXCEL_STATE?: string;
  APP_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name?: string | null;
}

export type AppContext = EventContext<AppEnv, string, Record<string, string>>;
