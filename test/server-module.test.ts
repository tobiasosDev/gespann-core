import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { loadServerModule, type ModuleJobEnd, type ServerModule } from "../src/server/extension.ts";
import type { Github } from "../src/server/github.ts";
import type { Sandboxes } from "../src/server/sandbox.ts";
import { processJob } from "../src/server/worker.ts";

test("SERVER_MODULE loads a module file that gets the environment; none without the variable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-module-"));
  const file = join(dir, "mod.mjs");
  writeFileSync(file, "export default (env) => ({ name: `m-${env.WHO}`, links: [{ label: 'Plan', href: '/plan' }] });\n");
  const m = await loadServerModule(file, { WHO: "x" });
  assert.equal(m?.name, "m-x");
  assert.equal(await loadServerModule("", {}), null);
  writeFileSync(join(dir, "bad.mjs"), "export const x = 1;\n");
  await assert.rejects(loadServerModule(join(dir, "bad.mjs"), {}), /no default export function/);
  assert.equal(loadConfig({ SERVER_MODULE: ` ${file} ` }).serverModule, file);
});

test("a job the module refuses fails with its reason before it takes a sandbox; the module hears of every end", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-module-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const asked: unknown[] = [];
  const ends: ModuleJobEnd[] = [];
  const module: ServerModule = {
    name: "test",
    admit: (j) => {
      asked.push(j);
      return "choose a plan first";
    },
    jobEnded: (e) => {
      ends.push(e);
    },
  };
  let touched = false;
  const sandboxes = new Proxy({}, { get: () => () => { touched = true; throw new Error("no sandbox in this test"); } }) as Sandboxes;
  const github = {} as Github;
  const job = db.job(db.enqueue(p, "suggest"))!;
  await processJob({ db, sandboxes, github: () => github, config, module }, job);
  assert.equal(db.job(job.id)?.status, "failed");
  assert.equal(db.job(job.id)?.error, "not started: choose a plan first");
  assert.equal(touched, false, "no sandbox was asked for");
  assert.deepEqual(asked, [{ jobId: job.id, kind: "suggest", projectId: p, owner: { id: u.id, login: "tobi" } }]);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.status, "failed");
  assert.equal(ends[0]?.owner.login, "tobi");
  assert.ok(ends[0]!.seconds >= 0 && ends[0]!.seconds < 5);

  // A module that throws in jobEnded does not change the job's result.
  const loud: ServerModule = { name: "loud", admit: () => "no", jobEnded: () => { throw new Error("boom"); } };
  const job2 = db.job(db.enqueue(p, "suggest"))!;
  await processJob({ db, sandboxes, github: () => github, config, module: loud }, job2);
  assert.equal(db.job(job2.id)?.error, "not started: no");
});

test("the module's routes see the signed-in user and come before the web app; its links show in /api/me", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-module-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  db.createSession("s".repeat(64), u.id);
  const module: ServerModule = {
    name: "test",
    links: [{ label: "Plan", href: "/plan" }],
    routes: (app, h) => {
      app.get("/plan", (c) => c.text(`plan for ${h.user(c)?.login ?? "nobody"}`));
    },
  };
  const server = createApp({ config, db, github: () => { throw new Error("no github"); }, githubReady: () => false, module });
  const cookie = { Cookie: `gs=${"s".repeat(64)}` };
  assert.equal(await (await server.request("/plan", { headers: cookie })).text(), "plan for tobi");
  assert.equal(await (await server.request("/plan")).text(), "plan for nobody");
  assert.deepEqual((await (await server.request("/api/me", { headers: cookie })).json()).links, [{ label: "Plan", href: "/plan" }]);
  assert.deepEqual((await (await server.request("/api/me")).json()).links, [], "signed out: no links");
  const plain = createApp({ config, db, github: () => { throw new Error("no github"); }, githubReady: () => false });
  assert.deepEqual((await (await plain.request("/api/me", { headers: cookie })).json()).links, []);
});
