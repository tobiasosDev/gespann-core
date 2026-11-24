import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { RuleVersion } from "./rules.ts";

export interface CheckRun {
  /** null when the check could not start (missing requirement, timeout). */
  exit: number | null;
  durationMs: number;
  output: string;
  blocked?: string;
}

export function missingRequirements(rule: RuleVersion): string[] {
  const missing: string[] = [];
  for (const r of rule.check?.requires ?? []) {
    if (r.env && !process.env[r.env]) missing.push(`environment variable ${r.env}`);
    if (r.command) {
      const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", r.command], { encoding: "utf8", timeout: 5000 });
      if (found.status !== 0) missing.push(`command ${r.command}`);
    }
  }
  return missing;
}

export function runCheck(root: string, rule: RuleVersion): CheckRun {
  if (!rule.check) throw new Error(`rule ${rule.id} has no check`);
  const missing = missingRequirements(rule);
  if (missing.length) return { exit: null, durationMs: 0, output: "", blocked: `missing ${missing.join(", ")}` };
  const started = Date.now();
  const r = spawnSync("sh", ["-c", rule.check.command], {
    cwd: join(root, rule.check.cwd ?? "."),
    encoding: "utf8",
    timeout: (rule.check.timeoutSec ?? 600) * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GESPANN_RULE: rule.id, GESPANN_RULE_VERSION: String(rule.version) },
  });
  const durationMs = Date.now() - started;
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || r.status === null) {
    return { exit: null, durationMs, output, blocked: r.error ? String(r.error.message) : `stopped by ${r.signal}` };
  }
  return { exit: r.status, durationMs, output };
}
