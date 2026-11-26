import assert from "node:assert/strict";
import { test } from "node:test";
import { plan, triggered } from "../src/verify/plan.ts";
import { parseRecipe, type RecipeError } from "../src/verify/recipe.ts";

const MINIMAL = `
version: 1
trigger:
  paths: ["src/**"]
env:
  up: docker compose up -d --wait
  down: docker compose down -v
  url: http://127.0.0.1:3000
`;

const FULL = `
version: 1
mode: gate
timeout: 30
trigger:
  branches: [dev]
  label: verify
  paths: ["apps/web/{app,lib}/**", "packages/*/src/**"]
  ignore: ["**/*.test.ts", "**/e2e/**"]
setup:
  - { name: install, run: npm ci }
services:
  - name: replay
    run: node replay.js > "$GESPANN_WORK/replay.log"
    ready: grep -o 'http://[^ ]*' "$GESPANN_WORK/replay.log" | sed 's/^/REPLAY=/' >> "$GESPANN_ENV"
    readyTimeout: 30
flags:
  run: node flags.js
  admin: /admin/flags
env:
  up: ./up.sh
  down: ./down.sh
  url: $WEB_URL
replay:
  misses: $GESPANN_WORK/misses
alongside:
  - { name: golden, run: ./golden.sh, output: golden.md }
login: { path: /login, user: dev@example.test, password: dev }
seeds:
  - { name: funded, run: ./seed.sh funded, about: a user with a paid plan }
prompt: .gespann/verify.md
cleanup:
  - { name: logs, run: ./collect-logs.sh }
`;

function problems(text: string): string[] {
  try {
    parseRecipe(text);
  } catch (err) {
    return (err as RecipeError).problems;
  }
  return [];
}

test("a minimal recipe gets the defaults", () => {
  const r = parseRecipe(MINIMAL);
  assert.equal(r.timeout, 25);
  assert.deepEqual(r.trigger, { branches: [], paths: ["src/**"], ignore: [] });
  assert.deepEqual([r.setup, r.services, r.alongside, r.seeds, r.cleanup], [[], [], [], [], []]);
  assert.equal(r.flags, undefined);
});

test("a full recipe parses every section", () => {
  const r = parseRecipe(FULL);
  assert.equal("mode" in r, false, "an old recipe with mode stays valid; the merge gate is the project setting");
  assert.equal(r.services[0]?.readyTimeout, 30);
  assert.deepEqual(r.alongside[0], { name: "golden", run: "./golden.sh", output: "golden.md", required: true });
  assert.deepEqual(r.login, { path: "/login", user: "dev@example.test", password: "dev" });
  assert.equal(r.seeds[0]?.about, "a user with a paid plan");
  assert.equal(r.replay?.misses, "$GESPANN_WORK/misses");
});

test("all problems are reported at once, typos included", () => {
  const p = problems(`
version: 2
mode: strict
trigger: { paths: [] }
env: { up: ./up.sh, url: "" }
setup:
  - { name: a, run: x, runn: y }
  - just a string
alongside:
  - { name: a, run: x, output: ../out.md, required: "yes" }
servics: []
prompt: ../outside.md
`);
  assert.deepEqual(p.sort(), [
    "alongside[0].output: a file name in $GESPANN_WORK, no path",
    "alongside[0].required: must be true or false",
    "env.down: required",
    "env.url: must be a non-empty string",
    "prompt: a repo-relative path",
    "servics: unknown field",
    "setup[0].runn: unknown field",
    "setup[1]: must be a mapping",
    "trigger: needs paths or a label, or no PR would ever run",
    "version: must be 1",
  ]);
});

test("names of services, alongside checks and seeds are unique", () => {
  const p = problems(`${MINIMAL}
services: [{ name: db, run: x }]
alongside: [{ name: db, run: y }]
`);
  assert.deepEqual(p, ['name "db" is used twice']);
});

test("not YAML or not a mapping", () => {
  assert.match(problems("a: [")[0] ?? "", /^not valid YAML/);
  assert.deepEqual(problems("- a"), ["the recipe must be a mapping"]);
});

test("trigger: base branch, label, ignored and matching files", () => {
  const t = parseRecipe(FULL).trigger;
  const pr = (base: string, changed: string[], labels: string[] = []) => triggered(t, { base, changed, labels }).run;
  assert.equal(pr("dev", ["apps/web/app/page.tsx"]), true);
  assert.equal(pr("dev", ["packages/ui/src/button.tsx"]), true);
  assert.equal(pr("main", ["apps/web/app/page.tsx"]), false, "wrong base");
  assert.equal(pr("dev", ["apps/web/app/page.test.ts", "docs/x.md"]), false, "only ignored or unmatched files");
  assert.equal(pr("dev", ["docs/x.md"], ["verify"]), true, "label forces a run");
  assert.equal(pr("main", ["docs/x.md"], ["verify"]), false, "label does not override the base");
});

test("plan: setup, services, flags, up, alongside, tester, verdict, then always-steps", () => {
  const phases = plan(parseRecipe(FULL)).map((p) => `${p.phase}:${p.name}${p.always ? "!" : ""}`);
  assert.deepEqual(phases, [
    "setup:install",
    "service:replay",
    "flags:feature flags",
    "up:environment up",
    "alongside:golden",
    "tester:tester on $WEB_URL",
    "wait:golden",
    "verdict:validate verdict.json",
    "down:environment down!",
    "stop:replay!",
    "cleanup:logs!",
  ]);
});

test("the example in docs/recipe.md is a valid recipe", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../docs/recipe.md", import.meta.url), "utf8");
  const example = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(example);
  assert.equal(parseRecipe(example).login?.user, "admin@example.test");
});
