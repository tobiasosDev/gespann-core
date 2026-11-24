import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { patchFiles } from "../src/adapters/codex.ts";
import { detect } from "../src/detect.ts";
import { lineDiff } from "../src/diff.ts";
import { matchesAny } from "../src/glob.ts";
import { installHooks, uninstallHooks } from "../src/install.ts";
import { adapters } from "../src/adapters/index.ts";
import { checkMatcher, loadVersion, saveVersion, versions } from "../src/rules.ts";
import { parseArgs } from "../src/cli.ts";
import { lintRule, makeRepo, write } from "./helpers.ts";

test("glob matches nested paths and alternatives", () => {
  assert.ok(matchesAny("apps/web/lib/a.ts", ["apps/web/**/*.{ts,tsx}"]));
  assert.ok(matchesAny("apps/web/a.tsx", ["apps/web/**/*.{ts,tsx}"]));
  assert.ok(!matchesAny("apps/web/a.json", ["apps/web/**/*.{ts,tsx}"]));
  assert.ok(matchesAny("a.ts", ["**/*.ts"]));
  assert.ok(!matchesAny("apps/landing/a.ts", ["apps/web/**/*.ts"]));
});

test("line diff marks added and removed lines", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  assert.match(d, /^- b$/m);
  assert.match(d, /^\+ B$/m);
});

test("rule versions are immutable", () => {
  const root = makeRepo();
  saveVersion(root, lintRule());
  saveVersion(root, lintRule()); // identical: a retried write
  assert.throws(() => saveVersion(root, lintRule({ title: "changed" })), /immutable/);
  saveVersion(root, lintRule({ version: 2, level: "hook" }));
  assert.deepEqual(versions(root, "lint"), [1, 2]);
  assert.equal(loadVersion(root, "lint", 2).level, "hook");
  assert.throws(() => saveVersion(root, lintRule({ version: 3, level: "hook", check: undefined })), /needs a check/);
});

test("check matcher defaults to the command text", () => {
  const re = checkMatcher(lintRule({ check: { command: "bun run lint" } }));
  assert.ok(re?.test("cd apps/web && bun run lint -- --fix"));
  assert.ok(!re?.test("bun run lint-staged".replace("lint-staged", "test")));
});

test("detect finds package scripts per workspace with precise paths", () => {
  const root = makeRepo({
    "package.json": JSON.stringify({ scripts: { lint: "bun --filter '*' lint" } }),
    "bun.lock": "",
    "apps/web/package.json": JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "bun test" } }),
    "apps/landing/package.json": JSON.stringify({ scripts: { build: "astro build" } }),
  });
  const rules = detect(root);
  const lint = rules.find((r) => r.id === "lint");
  assert.ok(lint);
  assert.equal(lint.check?.command, "bun run lint");
  assert.equal(lint.check?.cwd, "apps/web");
  assert.deepEqual(lint.paths, ["apps/web/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]);
  assert.equal(lint.level, "observe");
  const re = checkMatcher(lint);
  assert.ok(re?.test("cd apps/web && bun run lint"));
  assert.ok(re?.test("bunx eslint lib/a.ts"));
  assert.ok(!re?.test("bun run lint-staged"));
  assert.ok(!re?.test("// eslint-disable-next-line"));
  assert.ok(rules.some((r) => r.id === "typecheck"));
});

test("hook install merges with existing hooks and is idempotent", () => {
  const root = makeRepo();
  write(root, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.mjs" }] }] }, model: "x" }));
  installHooks(root, adapters.claude);
  installHooks(root, adapters.claude);
  const cfg = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.equal(cfg.model, "x");
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.match(cfg.hooks.Stop[0].hooks[0].command, /gespann hook claude stop/);
  uninstallHooks(root, adapters.claude);
  const after = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(Object.keys(after.hooks), ["PreToolUse"]);
});

test("codex apply_patch file list", () => {
  assert.deepEqual(patchFiles("*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** Update File: src/b.ts\n*** Move to: src/c.ts\n*** End Patch"), ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("boolean flags do not swallow positionals", () => {
  const a = parseArgs(["approve", "--edit", "p1"]);
  assert.deepEqual(a._, ["approve", "p1"]);
  assert.equal(a.flags.edit, true);
});

test("invocation credits only a real check run in the rule's directory", async () => {
  const { invocation } = await import("../src/rules.ts");
  const web = lintRule({ check: { command: "npm run lint", cwd: "apps/web" } });
  const root = "/repo";
  const inv = (cmd: string, cwd = root) => invocation(cmd, web, root, cwd);
  assert.deepEqual(inv("cd apps/web && npm run lint"), { ran: true, ownExit: true });
  assert.deepEqual(inv("npm run lint", "/repo/apps/web"), { ran: true, ownExit: true });
  assert.deepEqual(inv("npm run lint 2>&1 | tail -5", "/repo/apps/web"), { ran: true, ownExit: false });
  assert.deepEqual(inv("cd apps/web && npm run lint\ngit status --short"), { ran: true, ownExit: false });
  assert.deepEqual(inv("cd apps/web && npm run lint &"), { ran: true, ownExit: false });
  assert.deepEqual(inv("cd apps/web && npm run lint || true"), { ran: true, ownExit: false });
  assert.deepEqual(inv("cd apps/web && echo npm run lint"), { ran: false, ownExit: false });
  assert.deepEqual(inv("cd apps/web && grep -r 'npm run lint' ."), { ran: false, ownExit: false });
  assert.deepEqual(inv("cd apps/web && true || npm run lint"), { ran: false, ownExit: false });
  assert.deepEqual(inv("cd apps/web && npm run lint & wait"), { ran: true, ownExit: false });
  assert.deepEqual(inv("npm run lint # apps/web"), { ran: false, ownExit: false });
  assert.deepEqual(inv("npm run lint # --prefix apps/web"), { ran: false, ownExit: false });
  assert.deepEqual(inv("npm run lint 2>&1", "/repo/apps/web"), { ran: true, ownExit: true });
  assert.deepEqual(inv("cd apps/web && true ||\nnpm run lint"), { ran: false, ownExit: false });
  const prefixed = lintRule({ check: { command: "npm run lint", cwd: "apps/web", match: "\\bnpm\\b.*\\blint\\b" } });
  assert.equal(invocation("npm --prefix apps/web run lint", prefixed, root, "/repo/packages").ran, false);
  assert.deepEqual(invocation("npm --prefix apps/web run lint", lintRule({ check: { command: "npm run lint", cwd: "apps/web", match: "\\bnpm\\b.*\\blint\\b" } }), root, root), { ran: true, ownExit: true });
  const eslint = lintRule({ check: { command: "npx eslint .", cwd: "apps/web", match: "\\beslint\\b" } });
  assert.equal(invocation("cd apps/web && npx eslint src", eslint, root, root).ran, true);
  assert.equal(invocation("cd apps/web && ./node_modules/.bin/eslint src", eslint, root, root).ran, true);
  assert.equal(invocation("cd apps/web && cat eslint.config.mjs", eslint, root, root).ran, false);
  assert.deepEqual(inv("npm run lint"), { ran: false, ownExit: false }, "wrong directory");
  assert.deepEqual(inv("cd apps/landing && npm run lint"), { ran: false, ownExit: false });
  assert.deepEqual(inv("cat > a.ts <<'EOF'\nnpm run lint; y\nEOF\ncd apps/web && CI=1 npm run lint"), { ran: true, ownExit: true });
});
