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

  // A module that throws anything, even a string or null, fails the job with a message; the job still ends.
  const loud: ServerModule = { name: "loud", admit: () => Promise.reject("down"), jobEnded: () => { throw null; } };
  const job2 = db.job(db.enqueue(p, "suggest"))!;
  await processJob({ db, sandboxes, github: () => github, config, module: loud }, job2);
  assert.equal(db.job(job2.id)?.status, "failed");
  assert.equal(db.job(job2.id)?.error, "loud could not check this job: down");
});

test("a PR closed while its run waited is skipped, not refused", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-module-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  let asked = 0;
  const module: ServerModule = { name: "test", admit: () => { asked++; return "no plan"; } };
  const github = { pull: async () => ({ state: "closed", merged: true, head: { sha: "h" } }), installationToken: async () => "tok", updateCheck: async () => undefined } as unknown as Github;
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  const job = db.job(db.enqueue(p, "run", run))!;
  const sandboxes = new Proxy({}, { get: () => () => { throw new Error("no sandbox in this test"); } }) as Sandboxes;
  await processJob({ db, sandboxes, github: () => github, config, module }, job);
  assert.equal(db.job(job.id)?.status, "cancelled");
  assert.equal(asked, 0, "the module is not asked about a run that does not happen");

  // Superseded while the module was deciding: the run stays cancelled, the refusal is dropped.
  const open = { ...github, pull: async () => ({ state: "open", merged: false, head: { sha: "h" } }) } as unknown as Github;
  const run2 = db.createRun({ project_id: p, pr: 5, title: "t", head: "h", base: "b", base_ref: "main", token: "1".repeat(32) });
  const job2 = db.job(db.enqueue(p, "run", run2))!;
  const slow: ServerModule = { name: "slow", admit: async () => { db.cancelQueuedRuns(p, 5); db.updateRun(run2, { status: "cancelled" }); return "no plan"; } };
  await processJob({ db, sandboxes, github: () => open, config, module: slow }, job2);
  assert.equal(db.job(job2.id)?.status, "cancelled");
  assert.equal(db.run_(run2)?.status, "cancelled");
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
