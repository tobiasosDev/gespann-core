import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { accessLines } from "../src/server/comment.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { open } from "../src/server/openrouter.ts";
import { repairPrompt, setupPrompt, testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe, RecipeError } from "../src/verify/recipe.ts";
import { accessUses, finish, prepare, switchFlag, takeKeys, type RunContext } from "../src/verify/run.ts";

const KEY = "mac-provider-key-0123456789";

const recipe = (access: string) => `
version: 1
trigger: { paths: ["**"] }
setup:
  - { name: sneaky, run: 'echo "MAC_PROVIDER_TOKEN=from-env-file" >> "$GESPANN_ENV"' }
flags: { run: 'echo "flags with $MAC_PROVIDER_TOKEN"', switch: 'echo "switch saw \${MAC_PROVIDER_TOKEN:-nothing}"' }
env:
  up: 'echo "up saw \${MAC_PROVIDER_TOKEN:-nothing}" > "$GESPANN_WORK/seen"; echo "token is $MAC_PROVIDER_TOKEN"'
  down: 'echo "down saw \${MAC_PROVIDER_TOKEN:-nothing}" >> "$GESPANN_WORK/seen"'
  url: http://127.0.0.1:4321/
${access}`;

const ACCESS = `access:
  - name: MAC_PROVIDER_TOKEN
    about: Mac sandbox provider
    paths: ["orchestrator/src/sandbox/**"]
`;

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A repo whose PR commit changes `file`: the run's base and head. */
function repo(file: string): RunContext {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gespann-access-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), "change\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "pr");
  const head = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "verify.yml"), "");
  return { root: dir, recipeFile: join(dir, "verify.yml"), pr: "7", head, base, run: "0123456789ab", work: join(dir, "run", "work"), out: join(dir, "run", "out") };
}

function keysFile(c: RunContext): string {
  const f = join(c.root, "keys.json");
  writeFileSync(f, JSON.stringify({ MAC_PROVIDER_TOKEN: KEY, OTHER: "not in the recipe" }));
  return f;
}

test("recipe: access lists each faked service with its variable, its name and the code that talks to it", () => {
  const r = parseRecipe(recipe(ACCESS));
  assert.deepEqual(r.access, [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", paths: ["orchestrator/src/sandbox/**"] }]);
  assert.deepEqual(parseRecipe(recipe("")).access, []);
  const problems = (text: string) => {
    try {
      parseRecipe(recipe(text));
      return [];
    } catch (err) {
      return (err as RecipeError).problems;
    }
  };
  assert.match(problems("access:\n  - { name: mac_token, about: Mac, paths: [a] }\n").join(), /access\[0\]\.name: an environment variable/);
  assert.match(problems("access:\n  - { name: GESPANN_TOKEN, about: Mac, paths: [a] }\n").join(), /not starting with GESPANN_/);
  assert.match(problems("access:\n  - { name: MAC_TOKEN, about: Mac }\n").join(), /access\[0\]\.paths: needs the files/);
  assert.match(problems("access:\n  - { name: MAC_TOKEN, about: Mac, paths: [a] }\n  - { name: MAC_TOKEN, about: Mac 2, paths: [b] }\n").join(), /access "MAC_TOKEN" is listed twice/);
  assert.match(problems("access:\n  - { name: MAC_TOKEN, about: Mac, paths: [a], key: x }\n").join(), /access\[0\]\.key: unknown field/);
});

test("a PR that changes the service's code runs against the real service; the key file is gone and no log shows the key", async () => {
  const c = repo("orchestrator/src/sandbox/macos.rs");
  const r = parseRecipe(recipe(ACCESS));
  const file = keysFile(c);
  assert.ok((await prepare(c, r, [], file)).ok);
  assert.equal(existsSync(file), false, "prepare deletes the keys at once");
  assert.equal(readFileSync(join(c.work, "seen"), "utf8"), `up saw ${KEY}\n`);
  const access = JSON.parse(readFileSync(join(c.work, "access.json"), "utf8"));
  assert.deepEqual(access, [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", real: true, why: "the PR changes orchestrator/src/sandbox/macos.rs" }]);
  const log = readFileSync(join(c.work, "run.log"), "utf8");
  assert.ok(log.includes("token is [key]"), log);
  assert.equal(log.includes(KEY), false, "the key never reaches the run log the tester reads");
  for (const f of ["env", "state.json", "context.json"]) assert.equal(existsSync(join(c.work, f)) && readFileSync(join(c.work, f), "utf8").includes(KEY), false, f);
  assert.equal(readFileSync(join(c.work, "flags.md"), "utf8"), "flags with [key]\n", "the flag sheet the tester reads has no key");
  // A later process (a flag switch, finish) has no key file: there the key is gone, and the result says
  // that checks after the switch may have used the fake.
  assert.match(switchFlag(c, r, "x", "on").output, /switch saw nothing/);
  writeFileSync(join(c.out, "verdict.json"), JSON.stringify({ verdict: "SKIP", summary: "nothing to test", checks: [], proof: [] }));
  const f = await finish(c, r, 1000);
  assert.deepEqual(f.judged.access, [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", real: false, why: `the PR changes orchestrator/src/sandbox/macos.rs, but a feature-flag switch ran without the key, so checks after it may have used the fake` }]);
});

test("every other PR runs against the fake, even when the machine's environment has the variable", async () => {
  const c = repo("web/src/pages/Run.tsx");
  const r = parseRecipe(recipe(ACCESS));
  process.env.MAC_PROVIDER_TOKEN = "from-the-machine";
  try {
    assert.ok((await prepare(c, r, [], keysFile(c))).ok);
  } finally {
    delete process.env.MAC_PROVIDER_TOKEN;
  }
  assert.equal(readFileSync(join(c.work, "seen"), "utf8"), "up saw nothing\n", "neither the machine nor a step's $GESPANN_ENV line hands the variable out");
  assert.deepEqual(JSON.parse(readFileSync(join(c.work, "access.json"), "utf8")), [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", real: false, why: "the PR does not change its code" }]);
  writeFileSync(join(c.out, "verdict.json"), JSON.stringify({ verdict: "SKIP", summary: "nothing to test", checks: [], proof: [] }));
  assert.equal((await finish(c, r, 1000)).judged.access?.[0]?.real, false);
});

test("without a key every PR runs against the fake; a CI runner's own environment counts as stored", () => {
  const a = parseRecipe(recipe(ACCESS)).access;
  assert.deepEqual(accessUses(a, {}, ["orchestrator/src/sandbox/macos.rs"]), [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", real: false, why: "no key stored" }]);
  assert.equal(accessUses(a, { MAC_PROVIDER_TOKEN: KEY }, null)[0]?.real, false, "unreadable changes never hand the key out");
  const many = accessUses(a, { MAC_PROVIDER_TOKEN: KEY }, ["orchestrator/src/sandbox/a.rs", "orchestrator/src/sandbox/b.rs", "orchestrator/src/sandbox/c.rs", "orchestrator/src/sandbox/d.rs", "orchestrator/src/sandbox/e.rs"]);
  assert.equal(many[0]?.why, "the PR changes orchestrator/src/sandbox/a.rs, orchestrator/src/sandbox/b.rs, orchestrator/src/sandbox/c.rs and 2 more");
  assert.deepEqual(takeKeys(undefined, ["MAC_PROVIDER_TOKEN", "NONE"], { MAC_PROVIDER_TOKEN: KEY }), { MAC_PROVIDER_TOKEN: KEY });
  assert.deepEqual(takeKeys(join(tmpdir(), "gespann-no-such-keys.json"), ["MAC_PROVIDER_TOKEN"]), {});
});

test("prompts: setup and repair fake outside services and list them; the tester never blocks a check for running against a fake", () => {
  const setup = setupPrompt({ repo: "o/r", repoDir: "/r", projectDir: "/p", criteria: "" });
  assert.match(setup, /add an entry to the recipe's `access` list/);
  const repair = repairPrompt({ repo: "o/r", repoDir: "/r", projectDir: "/p", gaps: [{ expect: "run an iOS test", observed: "no Mac provider", fix: "a Mac provider" }] });
  assert.match(repair, /a Mac with Xcode/);
  assert.match(repair, /Only if not even a fake can stand in \(physical hardware/);
  const tester = testerPrompt({ repo: "o/r", pr: 1, head: "h", base: "b", url: "http://x", out: "/o", work: "/w", criteria: "", recipe: parseRecipe(recipe(ACCESS)) });
  assert.match(tester, /Outside services the copy fakes \(\/w\/access\.json says which of them run for real.*\): Mac sandbox provider \(MAC_PROVIDER_TOKEN\)/);
  assert.match(tester, /never block it just because the service is a fake/);
  assert.equal(testerPrompt({ repo: "o/r", pr: 1, head: "h", base: "b", url: "http://x", out: "/o", work: "/w", criteria: "", recipe: parseRecipe(recipe("")) }).includes("Outside services"), false);
});

test("the PR comment names what was faked and what ran for real", () => {
  assert.deepEqual(accessLines([]), []);
  const lines = accessLines([
    { name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", real: false, why: "no key stored" },
    { name: "STRIPE_KEY", about: "Stripe test account", real: true, why: "the PR changes src/pay.ts" },
  ]);
  assert.match(lines.join("\n"), /🎭 \*\*Tested against a fake:\*\* Mac sandbox provider\. What the app does with this service was tested, not the real one/);
  assert.match(lines.join("\n"), /🔑 \*\*Real Stripe test account\*\* with the project's key: the PR changes src\/pay\.ts\./);
});

test("API: the owner stores a key sealed, the project shows only its end, and removes it; others cannot", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no github in this test"); }, githubReady: () => false });
  const owner = db.upsertUser({ github_id: 1, login: "tobi", name: "T", avatar: null });
  const mate = db.upsertUser({ github_id: 2, login: "mate", name: "M", avatar: null });
  for (const u of [owner, mate]) db.setRepos(u.id, [{ repo_id: 1, installation_id: 9, account: "acme", full_name: "acme/shop", private: true, default_branch: "main" }]);
  db.createSession("o".repeat(64), owner.id);
  db.createSession("m".repeat(64), mate.id);
  const p = db.createProject({ owner_id: owner.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { recipe: recipe(ACCESS) });
  const as = (s: string) => ({ Cookie: `gs=${s.repeat(64)}`, "x-gespann": "1" });
  const post = (path: string, body: unknown, who = "o") => server.request(`/api${path}`, { method: "POST", headers: { ...as(who), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const detail = async () => (await (await server.request(`/api/projects/${p}`, { headers: as("o") })).json()) as { access: unknown[] };

  assert.deepEqual((await detail()).access, [{ name: "MAC_PROVIDER_TOKEN", about: "Mac sandbox provider", paths: ["orchestrator/src/sandbox/**"], listed: true, key: null }]);
  assert.equal((await post(`/projects/${p}/access/MAC_PROVIDER_TOKEN`, { key: KEY }, "m")).status, 403, "only the owner, whose runs use it");
  assert.equal((await post(`/projects/${p}/access/mac`, { key: KEY })).status, 400);
  assert.equal((await post(`/projects/${p}/access/MAC_PROVIDER_TOKEN`, { key: "  " })).status, 400);
  const saved = await post(`/projects/${p}/access/MAC_PROVIDER_TOKEN`, { key: `  ${KEY}\n` });
  assert.deepEqual(await saved.json(), { ok: true, hint: "…6789" });
  const sealed = db.sql.prepare("select sealed from project_access where project_id = ?").get(p) as { sealed: string };
  assert.equal(sealed.sealed.includes(KEY), false);
  assert.equal(open(config.sessionSecret, sealed.sealed), KEY, "sealed as the orchestrator opens it");
  const shown = await detail();
  assert.equal(JSON.stringify(shown).includes(KEY), false, "the key never leaves the server");
  assert.deepEqual((shown.access[0] as { key: { hint: string } }).key.hint, "…6789");
  // A key for a service the recipe dropped stays visible, so it can be removed.
  db.updateProject(p, { recipe: recipe("") });
  assert.deepEqual((await detail()).access, [{ name: "MAC_PROVIDER_TOKEN", about: "", paths: [], listed: false, key: (shown.access[0] as { key: unknown }).key }]);
  assert.equal((await post(`/projects/${p}/access/MAC_PROVIDER_TOKEN/remove`, {}, "m")).status, 403);
  assert.equal((await post(`/projects/${p}/access/MAC_PROVIDER_TOKEN/remove`, {})).status, 200);
  assert.deepEqual((await detail()).access, []);
});
