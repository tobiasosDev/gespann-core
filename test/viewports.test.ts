import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe } from "../src/verify/recipe.ts";
import { viewportsOf } from "../src/verify/viewports.ts";

test("stored sizes come back in preset order, unknown ones drop out", () => {
  assert.deepEqual(viewportsOf("desktop-l, phone-s,watch").map((v) => v.id), ["phone-s", "desktop-l"]);
  assert.deepEqual(viewportsOf(""), []);
});

test("the tester prompt names each size, how to set it, and asks for one check per size", () => {
  const recipe = parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n');
  const base = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "http://localhost:1", out: "/o", work: "/w", criteria: "", recipe };
  const two = testerPrompt({ ...base, viewports: viewportsOf("phone-s,desktop-l") });
  assert.match(two, /tested at these screen sizes: Small phone 375x667, Large desktop 1920x1080\./);
  assert.match(two, /browser_resize/);
  assert.match(two, /window\.innerWidth/);
  assert.match(two, /one screenshot per size/);
  assert.match(two, /start `expect` with the size in brackets, e\.g\. "\[Small phone 375x667\] \.\.\."/);
  const one = testerPrompt({ ...base, viewports: viewportsOf("tablet") });
  assert.match(one, /tested at this screen size: Tablet 768x1024\./);
  assert.doesNotMatch(one, /in brackets|one screenshot per size/);
  assert.doesNotMatch(testerPrompt(base), /screen size|browser_resize/);
});

test("API: the project's screen sizes are saved in preset order; unknown sizes are refused", async () => {
  const db = new Db(":memory:");
  const server = createApp({ config: loadConfig({ DATA_DIR: "/tmp/gespann-test-data" }), db, github: () => { throw new Error("no github"); }, githubReady: () => false });
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "tobi/a", repo_id: 11, default_branch: "main" });
  db.setRepos(u.id, [{ repo_id: 11, installation_id: 9, account: "tobi", full_name: "tobi/a", private: false, default_branch: "main" }]);
  db.createSession("s".repeat(64), u.id);
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1", "Content-Type": "application/json" };
  const get = async () => (await server.request(`/api/projects/${id}`, { headers: h })).json();
  const set = (viewports: unknown) => server.request(`/api/projects/${id}/viewports`, { method: "POST", headers: h, body: JSON.stringify({ viewports }) });
  const before = await get();
  assert.deepEqual(before.viewports, []);
  assert.equal(before.viewport_presets.length, 6);
  assert.equal((await set(["desktop-l", "phone-s"])).status, 200);
  assert.deepEqual((await get()).viewports, ["phone-s", "desktop-l"]);
  assert.equal(db.project(id)?.viewports, "phone-s,desktop-l");
  assert.equal((await set(["phone-s", "watch"])).status, 400);
  assert.equal((await set("phone-s")).status, 400);
  assert.deepEqual((await get()).viewports, ["phone-s", "desktop-l"], "a refused change keeps the sizes");
  assert.equal((await set([])).status, 200);
  assert.deepEqual((await get()).viewports, []);
});
