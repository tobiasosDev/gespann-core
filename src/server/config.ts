import { join } from "node:path";

export interface Config {
  baseUrl: string;
  port: number;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  /** `SERVER_MODULE`: path of a module that adds pages and a say over jobs; "" for none. */
  serverModule: string;
  /** Days after a PR closes until its runs' screenshots and recordings are deleted; null keeps them. */
  mediaRetentionDays: number | null;
  /** Guards /setup (GitHub App creation). */
  adminToken: string;
  /** `ALLOWED_USERS`: GitHub logins (lowercase) that may sign in; empty lets every GitHub user in. */
  allowedUsers: string[];
  production: boolean;
  /** Overrides for the GitHub App; otherwise they come from the settings table (manifest flow). */
  github: Partial<GithubApp>;
}

export interface GithubApp {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const dataDir = env.DATA_DIR ?? (production ? "/data" : join(process.cwd(), ".data"));
  const port = Number(env.PORT ?? 3000);
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const sessionSecret = env.SESSION_SECRET ?? (production ? "" : "dev-only-session-secret");
  if (production && (!baseUrl.startsWith("https://") || sessionSecret.length < 32)) {
    throw new Error("production needs an https BASE_URL and a SESSION_SECRET of at least 32 characters");
  }
  const github: Partial<GithubApp> = {};
  if (env.GITHUB_APP_ID) github.appId = env.GITHUB_APP_ID;
  if (env.GITHUB_APP_SLUG) github.slug = env.GITHUB_APP_SLUG;
  if (env.GITHUB_APP_PRIVATE_KEY) github.privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (env.GITHUB_WEBHOOK_SECRET) github.webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (env.GITHUB_CLIENT_ID) github.clientId = env.GITHUB_CLIENT_ID;
  if (env.GITHUB_CLIENT_SECRET) github.clientSecret = env.GITHUB_CLIENT_SECRET;
  const allowedUsers = (env.ALLOWED_USERS ?? "").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (env.ALLOWED_USERS !== undefined && !allowedUsers.length) throw new Error("ALLOWED_USERS is set but names no GitHub login; remove it to let everyone sign in");
  const retention = (env.MEDIA_RETENTION_DAYS ?? "10").trim().toLowerCase();
  if (retention !== "off" && !/^\d{1,4}$/.test(retention)) throw new Error(`MEDIA_RETENTION_DAYS ${retention} is not a whole number of days or off`);
  return {
    baseUrl,
    port,
    dataDir,
    dbPath: env.DATABASE_PATH ?? join(dataDir, "gespann.sqlite"),
    sessionSecret,
    serverModule: (env.SERVER_MODULE ?? "").trim(),
    mediaRetentionDays: retention === "off" ? null : Number(retention),
    adminToken: env.ADMIN_TOKEN ?? "",
    allowedUsers,
    production,
    github,
  };
}
