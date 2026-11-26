import { join } from "node:path";
import { SAFE_PATH, words } from "./sandbox.ts";

export interface Config {
  baseUrl: string;
  port: number;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  /** Where PR code runs: "docker", "ssh", "module:<path>" for a provider module of your own, or "" for none. */
  sandboxProvider: string;
  docker: { image: string; args: string[]; command: string[]; user: string; home: string };
  ssh: { host: string; port: string; keyFile: string; key: string; knownHosts: string; root: string };
  /** `SERVER_MODULE`: path of a module that adds pages and a say over jobs; "" for none. */
  serverModule: string;
  /** `MAX_PARALLEL_JOBS`: how many jobs run at once; null computes it from the sandbox host. */
  maxParallel: number | null;
  /** git ref of gespann-core that sandboxes install, so sandbox and server run the same code. */
  gespannRef: string;
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
  const sandboxProvider = env.SANDBOX_PROVIDER ?? "";
  if (!["docker", "ssh", ""].includes(sandboxProvider) && !/^module:.+/.test(sandboxProvider)) throw new Error(`SANDBOX_PROVIDER ${sandboxProvider} is not docker, ssh or module:<path>`);
  const docker = {
    image: env.SANDBOX_IMAGE ?? "",
    args: words(env.SANDBOX_DOCKER_ARGS ?? ""),
    command: words(env.SANDBOX_COMMAND ?? ""),
    user: env.SANDBOX_USER ?? "",
    home: env.SANDBOX_HOME ?? "/home/user",
  };
  const ssh = {
    host: env.SSH_HOST ?? "",
    port: env.SSH_PORT ?? "",
    keyFile: env.SSH_KEY_FILE ?? "",
    key: (env.SSH_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    knownHosts: (env.SSH_KNOWN_HOSTS ?? "").replace(/\\n/g, "\n"),
    root: env.SANDBOX_ROOT ?? "~/gespann-sandboxes",
  };
  if (sandboxProvider === "docker" && !docker.image) throw new Error("SANDBOX_PROVIDER=docker needs SANDBOX_IMAGE");
  if (sandboxProvider === "docker" && !SAFE_PATH.test(docker.home)) throw new Error("SANDBOX_HOME has to be an absolute path of letters, digits, . _ - and /");
  if (sandboxProvider === "ssh" && !ssh.host) throw new Error("SANDBOX_PROVIDER=ssh needs SSH_HOST");
  const allowedUsers = (env.ALLOWED_USERS ?? "").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (env.ALLOWED_USERS !== undefined && !allowedUsers.length) throw new Error("ALLOWED_USERS is set but names no GitHub login; remove it to let everyone sign in");
  const max = (env.MAX_PARALLEL_JOBS ?? "").trim();
  if (max && !/^[1-9]\d{0,2}$/.test(max)) throw new Error(`MAX_PARALLEL_JOBS ${max} is not a whole number from 1 to 999`);
  return {
    baseUrl,
    port,
    dataDir,
    dbPath: env.DATABASE_PATH ?? join(dataDir, "gespann.sqlite"),
    sessionSecret,
    sandboxProvider,
    serverModule: (env.SERVER_MODULE ?? "").trim(),
    docker,
    ssh,
    maxParallel: max ? Number(max) : null,
    gespannRef: env.GESPANN_REF ?? "main",
    adminToken: env.ADMIN_TOKEN ?? "",
    allowedUsers,
    production,
    github,
  };
}
