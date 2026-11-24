import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookInput } from "../src/adapters/types.ts";
import { handle } from "../src/hook.ts";
import { loadState, record, type RuleVersion, saveState, saveVersion } from "../src/rules.ts";

export function sh(cwd: string, cmd: string): string {
  return execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export function makeRepo(files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gespann-test-")));
  sh(root, "git init -q -b main && git config user.email t@example.com && git config user.name Tester && git config commit.gpgsign false");
  for (const [p, t] of Object.entries(files)) write(root, p, t);
  write(root, "README.md", "x\n");
  sh(root, "git add -A && git commit -qm init");
  return root;
}

export function lintRule(over: Partial<RuleVersion> = {}): RuleVersion {
  return {
    id: "lint",
    version: 1,
    title: "Lint passes before a change is reported as done",
    why: "Lint errors in review cost a round trip.",
    paths: ["src/**/*.ts"],
    check: { command: "sh lint.sh", match: "\\blint\\.sh\\b" },
    level: "observe",
    ci: "report",
    ...over,
  };
}

/** lint.sh fails when any src file contains the word BAD. */
export const LINT_SH = `if grep -rq BAD src 2>/dev/null; then echo "src: BAD found"; exit 1; fi; echo ok\n`;

export function addRule(root: string, rule: RuleVersion): void {
  saveVersion(root, rule);
  const state = loadState(root);
  state.rules[rule.id] = { active: rule.version, status: "observing", history: [] };
  record(root, state, rule.id, "init", rule.version);
  saveState(root, state);
}

export function hook(root: string, agent: "claude" | "codex", session: string, event: HookInput["event"], extra: Partial<HookInput> = {}) {
  return handle({ agent, session, cwd: root, event, ...extra });
}

export function shell(root: string, agent: "claude" | "codex", session: string, command: string, exit: number | null, id?: string) {
  let real = exit;
  if (exit !== null || agent === "codex") {
    try {
      sh(root, command);
      real = 0;
    } catch (e) {
      real = (e as { status?: number }).status ?? 1;
    }
  }
  return hook(root, agent, session, "tool", { tool: { name: "Bash", kind: "shell", command, exit: agent === "codex" ? null : real, ...(id ? { id } : {}) } });
}
