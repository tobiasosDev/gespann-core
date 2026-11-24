import { createInterface } from "node:readline/promises";
import { adapterFor, adapters } from "./adapters/index.ts";
import type { Agent } from "./adapters/types.ts";
import { runHook } from "./hook.ts";
import { hooksInstalled, installHooks, uninstallHooks } from "./install.ts";
import { repoRoot } from "./util.ts";

const VERSION = "0.3.0";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOL = new Set(["yes", "help", "version"]);

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
  const v = args.flags.agents;
  return (typeof v === "string" ? v : "claude,codex").split(",").map((a) => adapterFor(a.trim()).agent);
}

async function cmdInit(root: string, args: Args) {
  const agents = agentsOf(args);
  say(`Stop hook for: ${agents.join(", ")} (${agents.map((a) => adapters[a].configPath).join(", ")})`);
  if (!args.flags.yes && !(await confirm("Install the hooks?"))) {
    say("Nothing written. Re-run with --yes to accept.");
    return;
  }
  for (const a of agents) say(`installed ${installHooks(root, adapters[a])}`);
  if (agents.includes("codex")) say("Codex runs new project hooks only after you trust them: open Codex in this repo and run /hooks once.");
}

const HELP = `gespann ${VERSION}: acceptance testing for coding agents (Claude Code, Codex)

  init [--yes] [--agents claude,codex]   install the stop hook
  uninstall [--agents claude,codex]      remove gespann's hooks, keep all others
  status                                 which hooks are installed

Agents call: gespann hook <claude|codex> stop`;

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
    case "uninstall":
      for (const a of agentsOf(args)) uninstallHooks(root, adapters[a]);
      return say("removed");
    case "status":
      for (const a of Object.keys(adapters) as Agent[]) say(`hooks ${a}: ${hooksInstalled(root, a) ? "installed" : "not installed"}`);
      return;
    default:
      throw new Error(`unknown command ${cmd}; see gespann help`);
  }
}
