import { serve as listen } from "@hono/node-server";
import { createApp, githubApp } from "./app.ts";
import { startLogin } from "./codex.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { loadServerModule } from "./extension.ts";
import { Github } from "./github.ts";
import { createPool, describePool } from "./provider.ts";
import { startPrSync } from "./pulls.ts";
import { startMediaSweep } from "./retention.ts";
import { startWorker } from "./worker.ts";

/**
 * `gespann serve`: the web service and its webhook, and with WORKER=builtin the job worker in the
 * same process. With WORKER=external the orchestrator runs jobs and Codex sign-ins.
 */
export async function serve(): Promise<void> {
  const config = loadConfig();
  const db = new Db(config.dbPath);
  const external = config.worker === "external";
  // A builtin sign-in lives in this process; the orchestrator's survive a restart of the UI.
  if (!external) db.failPendingLogins();
  // Projects added before their owner connected Codex start their setup now.
  for (const { id } of db.sql.prepare("select id from users where codex_state = 'connected'").all() as { id: number }[]) db.autoSetup(id);
  let cached: { key: string; gh: Github } | null = null;
  const github = () => {
    const app = githubApp(config, db);
    if (!app) throw new Error("This instance has no GitHub App yet. Create it at /setup.");
    if (!cached || cached.key !== app.appId) cached = { key: app.appId, gh: new Github(app) };
    return cached.gh;
  };
  // With WORKER=external the orchestrator holds the sandboxes; this process only serves.
  const pool = external ? { providers: [], forLogin: () => null } : await createPool(config);
  const providerOf = (userId: number) => pool.forLogin(db.user(userId)?.login);
  const serverModule = await loadServerModule(config.serverModule);
  if (serverModule) console.log(JSON.stringify({ level: "info", message: `server module: ${serverModule.name}` }));
  const app = createApp({
    config,
    db,
    github,
    githubReady: () => !!githubApp(config, db),
    module: serverModule,
    ...(pool.providers.length
      ? {
          startCodexLogin: (userId: number) => {
            const p = providerOf(userId);
            if (p) startLogin(db, p.sandboxes, config, userId);
            return !!p;
          },
          parallel: (userId: number) => providerOf(userId)?.parallel.jobs ?? null,
        }
      : {}),
  });
  if (pool.providers.length) {
    startWorker({ db, github, config, module: serverModule }, (ownerId) => {
      const p = providerOf(ownerId);
      return p ? { key: p.spec, sandboxes: p.sandboxes, parallel: p.parallel.jobs } : null;
    });
    for (const { who, provider } of describePool(config, pool)) {
      const kind = provider.sandboxes.kind;
      console.log(JSON.stringify({ level: "info", message: `sandboxes: ${kind}${who ? ` (${who})` : ""}` }));
      console.log(JSON.stringify({ level: "info", message: `parallel jobs${pool.providers.length > 1 ? ` on ${kind}` : ""}: ${provider.parallel.jobs} (${provider.parallel.why})` }));
    }
    if (!config.sandboxProvider) console.error(JSON.stringify({ level: "warn", message: "no SANDBOX_PROVIDER: jobs of users outside SANDBOX_PROVIDER_BY_USER stay queued" }));
  } else if (external) console.log(JSON.stringify({ level: "info", message: "worker: external (the orchestrator runs jobs)" }));
  else console.error(JSON.stringify({ level: "warn", message: "no sandbox provider (SANDBOX_PROVIDER): jobs stay queued" }));
  startPrSync({ db, github });
  if (config.mediaRetentionDays !== null) startMediaSweep({ db, github, dataDir: config.dataDir, days: config.mediaRetentionDays });
  listen({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(JSON.stringify({ level: "info", message: `gespann listening on ${info.port}`, baseUrl: config.baseUrl }));
  });
}
