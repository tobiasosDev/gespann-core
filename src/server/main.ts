import { serve as listen } from "@hono/node-server";
import { createApp, githubApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { AGENT_READY, Db } from "./db.ts";
import { capFor, loadServerModule } from "./extension.ts";
import { Github } from "./github.ts";
import { startPrSync } from "./pulls.ts";
import { startMediaSweep } from "./retention.ts";

/**
 * `gespann serve`: the web service, its webhook and the internal API. Jobs and Codex sign-ins run in
 * the orchestrator (docs/orchestrator.md).
 */
export async function serve(): Promise<void> {
  const config = loadConfig();
  const db = new Db(config.dbPath);
  // Projects added before their owner connected an agent start their setup now.
  for (const { id } of db.sql.prepare(`select id from users where ${AGENT_READY}`).all() as { id: number }[]) db.autoSetup(id);
  let cached: { key: string; gh: Github } | null = null;
  const github = () => {
    const app = githubApp(config, db);
    if (!app) throw new Error("This instance has no GitHub App yet. Create it at /setup.");
    if (!cached || cached.key !== app.appId) cached = { key: app.appId, gh: new Github(app) };
    return cached.gh;
  };
  const serverModule = await loadServerModule(config.serverModule);
  if (serverModule) console.log(JSON.stringify({ level: "info", message: `server module: ${serverModule.name}` }));
  const app = createApp({ config, db, github, githubReady: () => !!githubApp(config, db), module: serverModule });
  startPrSync({ db, github });
  // The orchestrator cannot ask the server module: the caps go into the database (every 10 s, plans change rarely).
  const publish = () => db.publishJobCaps((owner) => capFor(serverModule, owner)?.jobs ?? null);
  publish();
  setInterval(publish, 10_000).unref();
  if (config.mediaRetentionDays !== null) startMediaSweep({ db, github, dataDir: config.dataDir, days: config.mediaRetentionDays });
  listen({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(JSON.stringify({ level: "info", message: `gespann listening on ${info.port}`, baseUrl: config.baseUrl }));
  });
}
