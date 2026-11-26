import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { createPool, describePool } from "../src/server/provider.ts";
import type { Sandboxes } from "../src/server/sandbox.ts";
import { type Route, startWorker } from "../src/server/worker.ts";

const METHODS = ["create", "exists", "home", "ensureRunning", "keepAlive", "stop", "remove", "exec", "start", "status", "kill", "readFile", "writeFile", "download"];

/** A provider module whose kind says which module it is; `cpus` makes it report its size. */
function moduleFile(dir: string, name: string, cpus?: number): string {
  const file = join(dir, `${name}.mjs`);
  const capacity = cpus ? `, capacity: async () => ({ cpus: ${cpus}, memoryGb: ${cpus * 2} })` : "";
  writeFileSync(file, `export default () => ({ kind: "${name}", ${METHODS.map((m) => `${m}: async () => null`).join(", ")}${capacity} });`);
  return `module:${file}`;
}

test("config: SANDBOX_PROVIDER_BY_USER gives GitHub logins their own provider", () => {
  const c = loadConfig({ SANDBOX_PROVIDER: "module:/app/shared.ts", SANDBOX_PROVIDER_BY_USER: " Tobi=ssh , ops=module:/app/own.ts,", SSH_HOST: "ci" });
  assert.equal(c.sandboxProvider, "module:/app/shared.ts");
  assert.deepEqual(c.sandboxProviderByUser, { tobi: "ssh", ops: "module:/app/own.ts" });
  assert.deepEqual(loadConfig({}).sandboxProviderByUser, {});
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "tobi" }), /SANDBOX_PROVIDER_BY_USER: tobi is not/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "=ssh" }), /SANDBOX_PROVIDER_BY_USER/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "tobi=" }), /SANDBOX_PROVIDER_BY_USER: tobi= is not/, "an empty provider is a typo, not a way to switch someone off");
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "tobi=jenkins" }), /docker, ssh or module:<path>/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "tobi=ssh" }), /needs SSH_HOST/, "a provider named only per user is checked too");
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER_BY_USER: "tobi=docker" }), /needs SANDBOX_IMAGE/);
});

test("pool: each provider is made once, users named in SANDBOX_PROVIDER_BY_USER get theirs, everyone else the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-pool-"));
  const shared = moduleFile(dir, "shared");
  const own = moduleFile(dir, "own", 32);
  const config = loadConfig({ SANDBOX_PROVIDER: shared, SANDBOX_PROVIDER_BY_USER: `tobi=${own},ops=${own}` });
  const pool = await createPool(config, {});
  assert.deepEqual(pool.providers.map((p) => [p.sandboxes.kind, p.parallel.jobs]), [["shared", 2], ["own", 8]], "own reports 32 CPUs; shared reports nothing");
  assert.equal(pool.forLogin("Tobi")?.sandboxes.kind, "own", "logins match without case");
  assert.equal(pool.forLogin("ops")?.sandboxes, pool.forLogin("tobi")?.sandboxes, "one instance for users sharing a provider");
  assert.equal(pool.forLogin("eve")?.sandboxes.kind, "shared");
  assert.equal(pool.forLogin(null)?.sandboxes.kind, "shared");
  assert.equal(pool.forLogin("constructor")?.sandboxes.kind, "shared", "a login that is an object property name gets the default too");
  assert.deepEqual(describePool(config, pool).map((d) => [d.provider.sandboxes.kind, d.who]), [["shared", "everyone else"], ["own", "tobi, ops"]]);

  const onlyOwn = await createPool(loadConfig({ SANDBOX_PROVIDER_BY_USER: `tobi=${own}` }), {});
  assert.equal(onlyOwn.forLogin("tobi")?.sandboxes.kind, "own");
  assert.equal(onlyOwn.forLogin("eve"), null, "without SANDBOX_PROVIDER, other users have no sandboxes");
  const single = await createPool(loadConfig({ SANDBOX_PROVIDER: shared }), {});
  assert.deepEqual(describePool(loadConfig({ SANDBOX_PROVIDER: shared }), single).map((d) => d.who), [""], "one provider: the log line stays as before");
  assert.equal((await createPool(loadConfig({}), {})).providers.length, 0);
});

/** Sandboxes whose create never returns, so a job that reaches its provider keeps running. */
function hanging(kind: string): Sandboxes & { created: string[] } {
  const created: string[] = [];
  const never = () => new Promise<never>(() => undefined);
  const sb = Object.fromEntries(METHODS.map((m) => [m, never])) as unknown as Sandboxes & { created: string[] };
  return Object.assign(sb, {
    kind,
    created,
    create: (o: { name: string }) => {
      created.push(o.name);
      return never();
    },
  });
}

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
}

test("worker: jobs go to their owner's provider; each provider runs its own number, a full one holds up no one else", async () => {
  const db = new Db(":memory:");
  const user = (id: number, login: string) => db.upsertUser({ github_id: id, login, name: null, avatar: null }).id;
  const project = (owner: number, repo: string) => db.createProject({ owner_id: owner, installation_id: 9, repo, repo_id: db.allProjects().length + 1, default_branch: "main" });
  const tobi = user(1, "tobi");
  const eve = user(2, "eve");
  const mallory = user(3, "mallory");
  const t1 = db.enqueue(project(tobi, "tobi/a"), "suggest");
  const t2 = db.enqueue(project(tobi, "tobi/b"), "suggest");
  const e1 = db.enqueue(project(eve, "eve/a"), "suggest");
  const m1 = db.enqueue(project(mallory, "mallory/a"), "suggest");
  const own = hanging("own");
  const shared = hanging("shared");
  const route: Route = (ownerId) => (ownerId === tobi ? { key: "own", sandboxes: own, parallel: 1 } : ownerId === eve ? { key: "shared", sandboxes: shared, parallel: 1 } : null);
  const stop = startWorker({ db, github: () => { throw new Error("no github"); }, config: loadConfig({}) }, route);
  try {
    await until(() => own.created.length + shared.created.length >= 2);
    assert.deepEqual(own.created, ["gespann-tobi-a"]);
    assert.deepEqual(shared.created, ["gespann-eve-a"], "eve's job starts although tobi's provider is full");
    assert.deepEqual([t1, t2, e1, m1].map((j) => db.job(j)?.status), ["running", "queued", "running", "queued"], "mallory has no provider: their job waits");
  } finally {
    stop();
  }
});

test("API: the Codex sign-in and the job limit follow the user's provider", async () => {
  const db = new Db(":memory:");
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const tobi = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null }).id;
  const eve = db.upsertUser({ github_id: 2, login: "eve", name: null, avatar: null }).id;
  const started: number[] = [];
  const server = createApp({
    config,
    db,
    github: () => { throw new Error("no github"); },
    githubReady: () => false,
    startCodexLogin: (u) => (u === tobi ? (started.push(u), true) : false),
    parallel: (u) => (u === tobi ? 7 : null),
  });
  const as = (u: number, sid: string) => {
    db.createSession(sid.repeat(64), u);
    return { Cookie: `gs=${sid.repeat(64)}`, "x-gespann": "1", "Content-Type": "application/json" };
  };
  const ht = as(tobi, "t");
  const he = as(eve, "e");
  assert.equal((await server.request("/api/settings/codex/login", { method: "POST", headers: ht })).status, 200);
  const denied = await server.request("/api/settings/codex/login", { method: "POST", headers: he });
  assert.equal(denied.status, 409);
  assert.match(((await denied.json()) as { error: string }).error, /no sandbox provider for your account/);
  assert.deepEqual(started, [tobi]);
  assert.equal(((await (await server.request("/api/boxes", { headers: ht })).json()) as { host: number }).host, 7);
  assert.equal(((await (await server.request("/api/boxes", { headers: he })).json()) as { host: number | null }).host, null);
  assert.equal((await server.request("/api/boxes/limit", { method: "POST", headers: ht, body: '{"limit":8}' })).status, 400, "the limit stops at the user's provider");
});
