import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRules } from "../src/runner.ts";
import { evaluateScanned, parseClaude, parseCodex, scan, shellWrites } from "../src/scan.ts";
import { exportRule, readPortable } from "../src/trial.ts";
import { propose } from "../src/proposals.ts";
import { addRule, LINT_SH, lintRule, makeRepo, sh, write } from "./helpers.ts";

test("runner: skipped without matching change, report-mode failure does not fail the job", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  sh(root, "git checkout -qb feature");
  write(root, "README.md", "docs\n");
  let report = runRules(root, { base: "main" });
  assert.equal(report.results[0]?.status, "skipped");

  write(root, "src/a.ts", "BAD\n");
  report = runRules(root, { base: "main" });
  assert.equal(report.results[0]?.status, "fail");
  assert.equal(report.results[0]?.version, 1);
  assert.equal(report.failed, false);
  assert.ok(report.commit);
});

test("runner: blocking mode fails the job; missing requirement is reported, not run", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "BAD\n" });
  addRule(root, lintRule({ ci: "block" }));
  assert.equal(runRules(root, { all: true }).failed, true);

  const root2 = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "x\n" });
  addRule(root2, lintRule({ check: { command: "sh lint.sh", requires: [{ env: "GESPANN_TEST_DB_URL_THAT_IS_UNSET" }] } }));
  const r = runRules(root2, { all: true }).results[0];
  assert.equal(r?.status, "blocked");
  assert.match(r?.reason ?? "", /GESPANN_TEST_DB_URL_THAT_IS_UNSET/);
});

test("shellWrites sees sed, redirects and python heredoc writes, not commit messages", () => {
  assert.deepEqual(shellWrites("sed -i '' 's/a/b/' apps/web/lib/x.ts").files, ["apps/web/lib/x.ts"]);
  assert.deepEqual(shellWrites("cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF").files, ["src/a.ts"]);
  const py = shellWrites("cd apps/web && python3 - <<'EOF'\np='lib/y.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF");
  assert.deepEqual(py.files, ["lib/y.ts"]);
  assert.equal(py.cd, "apps/web");
  assert.deepEqual(shellWrites("git add src/a.ts && git commit -F - <<'EOF'\nfix: src/a.ts\nEOF").files, []);
});

function fakeHome(root: string) {
  const home = mkdtempSync(join(tmpdir(), "gespann-home-"));
  const proj = join(home, ".claude", "projects", "-repo");
  mkdirSync(proj, { recursive: true });
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  // Claude session: edit, no lint afterwards
  writeFileSync(
    join(proj, "s-claude.jsonl"),
    line({ type: "user", cwd: root, timestamp: "2026-11-01T10:00:00Z", message: { content: "fix a" } }) +
      line({ type: "assistant", cwd: root, timestamp: "2026-11-01T10:00:05Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sh lint.sh" } }] } }) +
      line({ type: "user", timestamp: "2026-11-01T10:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }) +
      line({ type: "assistant", timestamp: "2026-11-01T10:01:00Z", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(root, "src/a.ts") } }] } }),
  );
  // Codex session: patch then lint (fails)
  const cdx = join(home, ".codex", "sessions", "2026", "11", "01");
  mkdirSync(cdx, { recursive: true });
  writeFileSync(
    join(cdx, "rollout-x.jsonl"),
    line({ type: "session_meta", timestamp: "2026-11-01T11:00:00Z", payload: { id: "codex-1", cwd: root } }) +
      line({ type: "event_msg", timestamp: "2026-11-01T11:00:05Z", payload: { type: "item_completed", item: { type: "FileChange", changes: { [join(root, "src/b.ts")]: { type: "add" } } } } }) +
      line({ type: "event_msg", timestamp: "2026-11-01T11:00:09Z", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "sh lint.sh"], exit_code: 1 } } }),
  );
  return home;
}

test("scan rebuilds per-session status from Claude and Codex transcripts", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "x\n" });
  addRule(root, lintRule());
  const home = fakeHome(root);
  const claudeS = parseClaude(join(home, ".claude/projects/-repo/s-claude.jsonl"));
  assert.equal(evaluateScanned(claudeS!, lintRule(), [root]).status, "missing");
  const codexS = parseCodex(join(home, ".codex/sessions/2026/11/01/rollout-x.jsonl"));
  assert.equal(evaluateScanned(codexS!, lintRule(), [root]).status, "fail");

  const file = scan(root, [lintRule()], { days: 3650, agents: ["claude", "codex"], home });
  assert.equal(file.sessions.length, 2);
  assert.deepEqual(file.sessions.map((s) => s.results.lint?.status), ["missing", "fail"]);
});

test("export and import carry a proven rule to a second repo with its own command", () => {
  const a = makeRepo({ "lint.sh": LINT_SH });
  addRule(a, lintRule({ level: "hook", skill: "Run lint.", ci: "block" }));
  const file = join(a, "..", `lint-export-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(exportRule(a, "lint")));
  const portable = readPortable(file);

  const b = makeRepo();
  const p = propose(b, "lint", {
    to: { ...portable.rule, version: 1, paths: ["lib/**/*.py"], check: { command: "ruff check ." }, ci: "report" },
    reason: "imported",
  });
  assert.equal(p.from, null);
  assert.equal(p.to.check?.command, "ruff check .");
  assert.equal(p.to.ci, "report");
});

test("scan follows symlinked transcript folders", async () => {
  const { symlinkSync, renameSync } = await import("node:fs");
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "x\n" });
  const home = fakeHome(root);
  const offload = mkdtempSync(join(tmpdir(), "gespann-offload-"));
  renameSync(join(home, ".claude/projects/-repo"), join(offload, "-repo"));
  symlinkSync(join(offload, "-repo"), join(home, ".claude/projects/-repo"));
  const file = scan(root, [lintRule()], { days: 3650, agents: ["claude"], home });
  assert.equal(file.sessions.length, 1);
});
