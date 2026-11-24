import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { adapters } from "./adapters/index.ts";
import { detect } from "./detect.ts";
import { isFinding, outcomes } from "./findings.ts";
import { runHook } from "./hook.ts";
import { ensureGitignore, hooksInstalled, installHooks } from "./install.ts";
import { type Agent, findSession, append } from "./journal.ts";
import { approve, listProposals, loadProposal, propose, reject, render } from "./proposals.ts";
import { activeRules, loadState, loadVersion, record, type RuleVersion, saveState, saveVersion, validate } from "./rules.ts";
import { emitGithub, markdown, runRules } from "./runner.ts";
import { saveScan, scan } from "./scan.ts";
import { sync } from "./sync.ts";
import { adopt, ciBlock, exportRule, extend, readPortable, renderRate, rollback, trialReport } from "./trial.ts";
import { dataDir, now, pct, repoRoot } from "./util.ts";

const VERSION = "0.2.0";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOL = new Set(["yes", "force", "ci", "all", "edit", "no-save", "false-alarm", "help", "version"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (v !== undefined) out.flags[k] = v;
    else if (!BOOL.has(k) && next !== undefined && !next.startsWith("--")) out.flags[k] = argv[++i] as string;
    else out.flags[k] = true;
  }
  return out;
}

function flag(args: Args, k: string): string | undefined {
  const v = args.flags[k];
  return typeof v === "string" ? v : undefined;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

const say = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function agentsOf(args: Args): Agent[] {
  return (flag(args, "agents") ?? "claude,codex").split(",").map((a) => a.trim()) as Agent[];
}

function editJson<T>(value: T): T {
  const file = join(tmpdir(), `gespann-${process.pid}.json`);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`editor exited with ${r.status}`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function cmdInit(root: string, args: Args) {
  const state = loadState(root);
  const found = detect(root).filter((r) => !state.rules[r.id]);
  say(found.length ? "Checks found in this repo (they start in observe mode: measure only, change nothing):" : "No new checks found.");
  for (const r of found) say(`  ${r.id}: \`${r.check?.command}\`${r.check?.cwd ? ` in ${r.check.cwd}` : ""} when ${r.paths.join(", ")} change`);
  const agents = agentsOf(args);
  say(`Hooks for: ${agents.join(", ")} (${agents.map((a) => adapters[a].configPath).join(", ")})`);
  if (!args.flags.yes && !(await confirm("Write .gespann/ and install the hooks?"))) {
    say("Nothing written. Re-run with --yes to accept.");
    return;
  }
  for (const r of found) {
    saveVersion(root, r);
    state.rules[r.id] = { active: 1, status: "observing", history: [] };
    record(root, state, r.id, "init", 1);
  }
  saveState(root, state);
  for (const a of agents) say(`installed ${installHooks(root, adapters[a])}`);
  ensureGitignore(root);
  sync(root);
  say("");
  say("Next:");
  say("  gespann scan        baseline from past Claude Code / Codex sessions");
  say("  gespann findings    sessions where a check was expected but did not end green");
  say("  gespann propose <rule>");
  if (agents.includes("codex")) say("Codex runs new project hooks only after you trust them: open Codex in this repo and run /hooks once.");
}

function cmdStatus(root: string) {
  const state = loadState(root);
  const rules = activeRules(root, state);
  if (rules.length === 0) say("No rules yet. Run `gespann init`.");
  for (const r of rules) {
    const s = state.rules[r.id];
    const trial = s?.trial ? `, trial since ${s.trial.started.slice(0, 10)} (${s.trial.days} d, previous v${s.trial.previous ?? "-"})` : "";
    say(`${r.id} v${r.version} [${s?.status}${trial}] level ${r.level}, ci ${r.ci}${r.check ? `: \`${r.check.command}\`` : ""}`);
  }
  for (const a of Object.keys(adapters) as Agent[]) say(`hooks ${a}: ${hooksInstalled(root, a) ? "installed" : "not installed"}`);
  const s = sync(root);
  if (s.conflicts.length) {
    say("Conflicts (local edits kept, approved version not applied):");
    for (const c of s.conflicts) say(`  ${c.path}: approved ${c.rule} v${c.version}. Keep yours by proposing it, or run \`gespann sync --force\`.`);
  }
  const open = listProposals(root).filter((p) => p.status === "open");
  for (const p of open) say(`open proposal ${p.id}: ${p.rule} v${p.from ?? "-"} → v${p.to.version}`);
}

function cmdScan(root: string, args: Args) {
  const days = Number(flag(args, "days") ?? 30);
  const rules = activeRules(root);
  const file = scan(root, rules, { days, agents: agentsOf(args), ...(flag(args, "match") ? { match: flag(args, "match") } : {}) });
  if (!args.flags["no-save"]) saveScan(root, file);
  say(`${file.sessions.length} sessions in the last ${days} days.`);
  for (const r of rules) {
    const list = file.sessions.map((s) => s.results[r.id]).filter((x) => !!x);
    const ran = list.filter((x) => x.status !== "missing").length;
    say(`${r.id}: ${list.length} sessions changed ${r.paths.join(", ")}; check after the last edit in ${ran} (${pct(ran, list.length)}), not in ${list.length - ran}.`);
  }
  say("Transcript scan is an estimate: it sees Edit/Write/apply_patch and recognisable shell writes. Live hooks observe through git.");
}

function cmdFindings(root: string, args: Args) {
  const list = outcomes(root, { ...(flag(args, "rule") ? { rule: flag(args, "rule") } : {}) });
  const f = list.filter(isFinding);
  const limit = Number(flag(args, "limit") ?? 20);
  for (const o of f.slice(-limit)) {
    say(`${o.t.slice(0, 16)} ${o.rule} ${o.status.padEnd(7)} ${o.agent} ${o.session.slice(0, 12)} (${o.source}${o.version ? ` v${o.version}` : ""}) ${o.files.slice(0, 3).join(", ")}${o.files.length > 3 ? " …" : ""}`);
  }
  const unknown = list.filter((o) => o.status === "unknown").length;
  say(`${f.length} findings in ${list.length - unknown} sessions with relevant changes${unknown ? `; ${unknown} unknown (hooks did not see the session start)` : ""}.`);
}

function cmdRun(root: string, args: Args) {
  const report = runRules(root, {
    ...(flag(args, "base") ? { base: flag(args, "base") } : {}),
    all: !!args.flags.all,
    ...(flag(args, "rule") ? { rule: flag(args, "rule") } : {}),
    ci: !!args.flags.ci,
  });
  if (flag(args, "json")) writeFileSync(flag(args, "json") as string, `${JSON.stringify(report, null, 2)}\n`);
  if (args.flags.ci) emitGithub(report);
  say(markdown(report));
  if (report.failed) process.exitCode = 1;
}

function cmdImport(root: string, args: Args) {
  const p = readPortable(need(args._[1], "file"));
  const id = flag(args, "id") ?? p.rule.id;
  const check = p.rule.check
    ? { ...p.rule.check, ...(flag(args, "command") ? { command: flag(args, "command") as string, match: undefined } : {}), ...(flag(args, "cwd") ? { cwd: flag(args, "cwd") } : {}) }
    : undefined;
  if (check && check.match === undefined) delete check.match;
  const to: RuleVersion = {
    ...p.rule,
    id,
    version: 1,
    ...(flag(args, "paths") ? { paths: (flag(args, "paths") as string).split(",") } : {}),
    ...(check ? { check } : {}),
    ci: p.rule.ci === "block" ? "report" : p.rule.ci,
    origin: { importedFrom: `${p.rule.id} v${p.exportedFrom.version}` },
  };
  const prop = propose(root, id, { to, reason: `Imported from another repo (${p.rule.id} v${p.exportedFrom.version}), adapted to this repo's command and paths. CI starts in report mode.` });
  say(render(root, prop));
}

function cmdAdd(root: string, args: Args) {
  const id = need(args._[1], "rule id");
  if (loadState(root).rules[id]) throw new Error(`rule ${id} exists; use \`gespann propose ${id}\``);
  const command = flag(args, "command");
  const to: RuleVersion = {
    id,
    version: 1,
    title: need(flag(args, "title"), "--title"),
    why: flag(args, "why") ?? "Found in review or manual testing.",
    paths: (flag(args, "paths") ?? "**/*").split(","),
    ...(command ? { check: { command, ...(flag(args, "cwd") ? { cwd: flag(args, "cwd") } : {}) } } : {}),
    level: command ? "hook" : "skill",
    ci: command ? "report" : "off",
    skill: flag(args, "skill") ?? "",
  };
  if (!to.skill) {
    to.skill = command
      ? `Before you report a change to ${to.paths.map((p) => `\`${p}\``).join(", ")} as done, run \`${command}\` and fix what it reports.\n\nWhy: ${to.why}`
      : `${to.title}.\n\nWhy: ${to.why}`;
  }
  validate(to);
  const prop = propose(root, id, { to, reason: `New rule from a finding: ${to.why}` });
  say(render(root, prop));
}

const HELP = `gespann ${VERSION}: quality loop for coding agents (Claude Code, Codex)

Setup
  init [--yes] [--agents claude,codex]   detect checks, write .gespann/, install hooks
  status                                 rules, versions, trials, hooks, conflicts
  sync [--force]                         write approved skills (runs at every session start)

Observe
  scan [--days 30] [--match text]        baseline from past transcripts
  findings [--rule id]                   sessions where a check was expected and did not end green
  flag <session> --rule id --false-alarm [--note text]

Change
  propose <rule> [--force]               next version, highest level that works
  add <id> --title t [--command c] [--paths a,b] [--why w]   new rule from a finding
  proposals | show <id>
  approve <id> [--edit] [--note t] [--days 14]   starts a trial
  reject <id> [--note t]

Trial
  trial <rule>                           effect vs before
  adopt <rule> | extend <rule> --days n | rollback <rule>
  ci-block <rule> --note t               make the CI check blocking (separate approval)

Run
  run [--base ref | --all] [--rule id] [--ci] [--json file]

Transfer
  export <rule> [--out file] | import <file> [--id id] [--command c] [--cwd d] [--paths a,b]

Agents call: gespann hook <claude|codex> <session-start|post-tool|post-tool-failure|stop|session-end>`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.flags.version || cmd === "version") return say(VERSION);
  if (!cmd || cmd === "help" || args.flags.help) return say(HELP);
  if (cmd === "hook") return runHook(need(args._[1], "agent"), need(args._[2], "event"));
  const root = repoRoot(process.cwd());
  switch (cmd) {
    case "init":
      return cmdInit(root, args);
    case "status":
      return cmdStatus(root);
    case "sync": {
      const s = sync(root, { force: !!args.flags.force });
      say(`written ${s.written.length}, removed ${s.removed.length}, unchanged ${s.unchanged.length}, conflicts ${s.conflicts.length}`);
      for (const c of s.conflicts) say(`  conflict ${c.path} (approved ${c.rule} v${c.version})`);
      return;
    }
    case "scan":
      return cmdScan(root, args);
    case "findings":
      return cmdFindings(root, args);
    case "propose":
      return say(render(root, propose(root, need(args._[1], "rule"), { force: !!args.flags.force })));
    case "add":
      return cmdAdd(root, args);
    case "proposals":
      for (const p of listProposals(root)) say(`${p.id} ${p.status} ${p.rule} v${p.from ?? "-"} → v${p.to.version} (${p.created.slice(0, 10)}, ${p.createdBy})`);
      return;
    case "show":
      return say(render(root, loadProposal(root, need(args._[1], "proposal id"))));
    case "approve": {
      const id = need(args._[1], "proposal id");
      const edited = args.flags.edit ? editJson(loadProposal(root, id).to) : undefined;
      const v = approve(root, id, { ...(edited ? { edited } : {}), ...(flag(args, "note") ? { note: flag(args, "note") } : {}), ...(flag(args, "days") ? { trialDays: Number(flag(args, "days")) } : {}) });
      const s = sync(root);
      say(`approved: ${v.id} v${v.version} is active (trial). New sessions pick it up; synced ${s.written.length} skill file(s).`);
      return;
    }
    case "reject":
      reject(root, need(args._[1], "proposal id"), flag(args, "note"));
      return say("rejected");
    case "trial": {
      const r = trialReport(root, need(args._[1], "rule"));
      say(`${r.rule} v${r.version} (${r.status}${r.started ? `, since ${r.started.slice(0, 10)}, ends ${r.ends?.slice(0, 10)}` : ""}, previous v${r.previous ?? "-"})`);
      say(`trial:  ${renderRate(r.trial)}`);
      say(`before: ${renderRate(r.before)} (${r.beforeSource})`);
      return say(r.verdict);
    }
    case "adopt":
      adopt(root, need(args._[1], "rule"), flag(args, "note"));
      return say("adopted");
    case "extend":
      extend(root, need(args._[1], "rule"), Number(need(flag(args, "days"), "--days")), flag(args, "note"));
      return say("extended");
    case "rollback": {
      const v = rollback(root, need(args._[1], "rule"), flag(args, "note"));
      sync(root);
      return say(v === null ? "rule deactivated (it did not exist before); its version files stay in .gespann/rules." : `rolled back to v${v}; new sessions use it.`);
    }
    case "ci-block": {
      const v = ciBlock(root, need(args._[1], "rule"), need(flag(args, "note"), "--note with the reason"));
      return say(`${v.id} v${v.version}: CI now blocks on failure.`);
    }
    case "flag": {
      const s = findSession(root, need(args._[1], "session"));
      if (!s) throw new Error(`no session ${args._[1]}`);
      append(root, s.agent, s.session, { type: "flag", t: now(), rule: need(flag(args, "rule"), "--rule"), kind: "false-alarm", ...(flag(args, "note") ? { note: flag(args, "note") } : {}) });
      return say("flagged as false alarm");
    }
    case "run":
      return cmdRun(root, args);
    case "export": {
      const text = `${JSON.stringify(exportRule(root, need(args._[1], "rule")), null, 2)}\n`;
      if (flag(args, "out")) writeFileSync(flag(args, "out") as string, text);
      else process.stdout.write(text);
      return;
    }
    case "import":
      return cmdImport(root, args);
    case "rule": {
      const id = need(args._[1], "rule");
      const st = loadState(root).rules[id];
      if (!st) throw new Error(`unknown rule ${id}`);
      say(JSON.stringify(loadVersion(root, id, st.active), null, 2));
      for (const h of st.history) say(`${h.at.slice(0, 16)} ${h.by} ${h.action} v${h.version}${h.note ? `: ${h.note}` : ""}`);
      return;
    }
    case "data":
      return say(dataDir(root));
    default:
      throw new Error(`unknown command ${cmd}; see gespann help`);
  }
}
