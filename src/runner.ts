import { appendFileSync } from "node:fs";
import { changedVsBase, headSha } from "./changes.ts";
import { runCheck } from "./check.ts";
import { matchesAny } from "./glob.ts";
import { activeRules, type RuleVersion } from "./rules.ts";
import { gitOk, now, tail } from "./util.ts";

export interface RunRecord {
  rule: string;
  version: number;
  command: string;
  cwd: string;
  commit: string | null;
  ci: RuleVersion["ci"];
  status: "pass" | "fail" | "blocked" | "skipped";
  exit: number | null;
  durationMs: number;
  reason?: string;
  output?: string;
  files: string[];
}

export interface RunReport {
  at: string;
  commit: string | null;
  base: string | null;
  results: RunRecord[];
  /** True when a rule in CI mode "block" failed. Report-mode failures never fail the job. */
  failed: boolean;
}

export function defaultBase(root: string): string | null {
  const origin = gitOk(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])?.trim();
  if (origin) return origin.replace("refs/remotes/", "");
  for (const b of ["origin/main", "origin/master", "main", "master"]) if (gitOk(root, ["rev-parse", "--verify", "--quiet", b])) return b;
  return null;
}

/** The same command a developer runs locally runs in CI: one runner, one record format. */
export function runRules(root: string, opts: { base?: string | null; all?: boolean; rule?: string; ci?: boolean } = {}): RunReport {
  const commit = headSha(root);
  const base = opts.all ? null : (opts.base ?? defaultBase(root));
  const changed = base ? changedVsBase(root, base) : null;
  const rules = activeRules(root).filter((r) => r.check && (!opts.rule || r.id === opts.rule) && (!opts.ci || r.ci !== "off"));
  const results: RunRecord[] = rules.map((r) => {
    const files = changed ? changed.filter((f) => matchesAny(f, r.paths)) : [];
    const rec = { rule: r.id, version: r.version, command: r.check?.command ?? "", cwd: r.check?.cwd ?? ".", commit, ci: r.ci, files };
    if (changed && files.length === 0) return { ...rec, status: "skipped" as const, exit: null, durationMs: 0, reason: `no change matches ${r.paths.join(", ")}` };
    const run = runCheck(root, r);
    if (run.blocked) return { ...rec, status: "blocked" as const, exit: run.exit, durationMs: run.durationMs, reason: run.blocked, output: tail(run.output, 40) };
    return { ...rec, status: run.exit === 0 ? ("pass" as const) : ("fail" as const), exit: run.exit, durationMs: run.durationMs, output: tail(run.output, 40) };
  });
  const failed = results.some((r) => r.ci === "block" && (r.status === "fail" || r.status === "blocked"));
  return { at: now(), commit, base, results, failed };
}

export function markdown(report: RunReport): string {
  const icon = { pass: "✅", fail: "❌", blocked: "⛔", skipped: "➖" };
  const lines = [
    `### gespann checks on \`${report.commit?.slice(0, 12) ?? "?"}\``,
    "",
    "| Rule | Version | Command | Mode | Result | Time |",
    "|---|---|---|---|---|---|",
    ...report.results.map(
      (r) =>
        `| ${r.rule} | v${r.version} | \`${r.command}\`${r.cwd !== "." ? ` in \`${r.cwd}\`` : ""} | ${r.ci === "block" ? "blocking" : "report"} | ${icon[r.status]} ${r.status}${r.reason ? `: ${r.reason}` : ""} | ${(r.durationMs / 1000).toFixed(1)} s |`,
    ),
  ];
  for (const r of report.results.filter((x) => x.status === "fail" || x.status === "blocked")) {
    lines.push("", `<details><summary>${r.rule} output</summary>`, "", "```", r.output ?? "", "```", "</details>");
  }
  return lines.join("\n");
}

export function emitGithub(report: RunReport): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown(report)}\n`);
  for (const r of report.results) {
    if (r.status !== "fail" && r.status !== "blocked") continue;
    const level = r.ci === "block" ? "error" : "warning";
    const msg = `${r.rule} v${r.version}: \`${r.command}\` ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.ci === "block" ? "" : " — report mode, not blocking"}`;
    process.stdout.write(`::${level} title=gespann ${r.rule}::${msg.replace(/\n/g, "%0A")}\n`);
  }
}
