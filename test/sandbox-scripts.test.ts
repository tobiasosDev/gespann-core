import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installScript } from "../src/server/worker.ts";

const sh = (script: string, env: NodeJS.ProcessEnv = process.env) => spawnSync("bash", ["-c", script], { encoding: "utf8", env });
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("the sandbox installs gespann only when the ref moved, and runs npm ci only when the lockfile changed", () => {
  const root = mkdtempSync(join(tmpdir(), "gespann-install-"));
  const src = join(root, "src-repo");
  mkdirSync(join(src, "src"), { recursive: true });
  // One local dependency, so `npm ci` creates node_modules without the network.
  mkdirSync(join(src, "dep"));
  writeFileSync(join(src, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "g", version: "1.0.0", dependencies: { dep: "file:dep" } }));
  writeFileSync(join(src, ".gitignore"), "node_modules\n");
  assert.equal(sh(`cd ${src} && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent`).status, 0);
  writeFileSync(join(src, "src", "bin.ts"), 'console.log("0.0.1")\n');
  git(src, "init", "-q", "-b", "main");
  git(src, "add", ".");
  git(src, "commit", "-qm", "one");
  const at = { core: join(root, "box", "core"), url: src, bin: join(root, "bin-gespann") };
  const run = () => sh(installScript("main", at));

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /gespann: installing gespann main/);
  assert.ok(existsSync(join(at.core, "node_modules")), "npm ci ran on the first install");
  assert.equal(readFileSync(at.bin, "utf8").includes(`${at.core}/src/bin.ts`), true);

  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /installing/, "same commit: nothing to do");

  // An install that did not finish (no marker) is redone at the same commit.
  rmSync(join(at.core, ".gespann-installed"));
  assert.match(run().stdout, /installing/);

  // A new commit without a lockfile change: checkout, but no npm ci (a marker in node_modules survives).
  writeFileSync(join(at.core, "node_modules", "marker"), "kept");
  writeFileSync(join(src, "src", "bin.ts"), 'console.log("0.0.2")\n');
  git(src, "commit", "-qam", "two");
  const moved = run();
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /installing/);
  assert.equal(git(at.core, "rev-parse", "HEAD"), git(src, "rev-parse", "HEAD"));
  assert.ok(existsSync(join(at.core, "node_modules", "marker")), "npm ci did not run");

  // A lockfile change runs npm ci again, which replaces node_modules.
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "g", version: "1.0.1", dependencies: { dep: "file:dep" } }));
  assert.equal(sh(`cd ${src} && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent`).status, 0);
  git(src, "commit", "-qam", "three");
  const locked = run();
  assert.equal(locked.status, 0, locked.stderr);
  assert.ok(!existsSync(join(at.core, "node_modules", "marker")), "npm ci ran");
});
