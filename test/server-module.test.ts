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

test("the module's Settings cards come from /api/settings/sections for the signed-in user; a failing module costs only its cards", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-module-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  db.createSession("s".repeat(64), u.id);
  const cookie = { Cookie: `gs=${"s".repeat(64)}` };
  const github = () => {
    throw new Error("no github");
  };
  const module: ServerModule = {
    name: "billing",
    settings: async (user) => [{ id: "plan", title: "Plan and usage", rows: [{ kind: "text", text: `plan of ${user.login}` }] }],
  };
  const server = createApp({ config, db, github, githubReady: () => false, module });
  const res = await server.request("/api/settings/sections", { headers: cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { sections: [{ id: "plan", title: "Plan and usage", rows: [{ kind: "text", text: "plan of tobi" }] }] });
  assert.equal((await server.request("/api/settings/sections")).status, 401, "signed out: no cards");

  const plain = createApp({ config, db, github, githubReady: () => false });
  assert.deepEqual(await (await plain.request("/api/settings/sections", { headers: cookie })).json(), { sections: [] });

  const broken = createApp({ config, db, github, githubReady: () => false, module: { name: "plans", settings: () => Promise.reject(new Error("store is down")) } });
  const r = await broken.request("/api/settings/sections", { headers: cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sections: [], error: "plans could not load: store is down" });
});
