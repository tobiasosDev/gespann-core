import { serve as listen } from "@hono/node-server";
import { createApp, githubApp } from "./app.ts";
import { startLogin } from "./codex.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
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
  const app = createApp({ config, db, github, githubReady: () => !!githubApp(config, db), ...(sandboxes ? { startCodexLogin: (userId: number) => startLogin(db, sandboxes, config, userId) } : {}) });
  if (sandboxes) {
    startWorker({ db, sandboxes, github, config });
    console.log(JSON.stringify({ level: "info", message: `sandboxes: ${sandboxes.kind}` }));
  } else console.error(JSON.stringify({ level: "warn", message: "no sandbox provider (SANDBOX_PROVIDER): jobs stay queued" }));
  listen({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(JSON.stringify({ level: "info", message: `gespann listening on ${info.port}`, baseUrl: config.baseUrl }));
  });
}
