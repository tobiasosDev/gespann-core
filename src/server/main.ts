import { serve as listen } from "@hono/node-server";
import { createApp, githubApp } from "./app.ts";
import { parallelJobs } from "./capacity.ts";
import { startLogin } from "./codex.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { loadServerModule } from "./extension.ts";
import { Github } from "./github.ts";
import { createSandboxes } from "./provider.ts";
import { startWorker } from "./worker.ts";

/** `gespann serve`: the web service, its webhook and the job worker in one process. */
export async function serve(): Promise<void> {
  const config = loadConfig();
  const db = new Db(config.dbPath);
  db.failPendingLogins();
  // Projects added before their owner connected Codex start their setup now.
  for (const { id } of db.sql.prepare("select id from users where codex_state = 'connected'").all() as { id: number }[]) db.autoSetup(id);
  let cached: { key: string; gh: Github } | null = null;
  const github = () => {
    const app = githubApp(config, db);
    if (!app) throw new Error("This instance has no GitHub App yet. Create it at /setup.");
    if (!cached || cached.key !== app.appId) cached = { key: app.appId, gh: new Github(app) };
    return cached.gh;
  };
  const sandboxes = await createSandboxes(config);
  const serverModule = await loadServerModule(config.serverModule);
  if (serverModule) console.log(JSON.stringify({ level: "info", message: `server module: ${serverModule.name}` }));
  const parallel = sandboxes ? await parallelJobs(config.maxParallel, sandboxes) : null;
  const app = createApp({
    config,
    db,
    github,
    githubReady: () => !!githubApp(config, db),
    module: serverModule,
    ...(sandboxes && parallel ? { startCodexLogin: (userId: number) => startLogin(db, sandboxes, config, userId), parallel: parallel.jobs } : {}),
  });
  if (sandboxes && parallel) {
    startWorker({ db, sandboxes, github, config, module: serverModule }, parallel.jobs);
    console.log(JSON.stringify({ level: "info", message: `sandboxes: ${sandboxes.kind}` }));
    console.log(JSON.stringify({ level: "info", message: `parallel jobs: ${parallel.jobs} (${parallel.why})` }));
  } else console.error(JSON.stringify({ level: "warn", message: "no sandbox provider (SANDBOX_PROVIDER): jobs stay queued" }));
  listen({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(JSON.stringify({ level: "info", message: `gespann listening on ${info.port}`, baseUrl: config.baseUrl }));
  });
}
