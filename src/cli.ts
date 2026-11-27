import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { adapterFor, adapters } from "./adapters/index.ts";
import type { Agent } from "./adapters/types.ts";
import { runHook } from "./hook.ts";
import { hooksInstalled, installHooks, uninstallHooks } from "./install.ts";
import { gitOk, repoRoot } from "./util.ts";
import { renderPlan, triggered } from "./verify/plan.ts";
import { PROMPT_KINDS, type PromptKind, promptFor } from "./verify/prompt.ts";
import { loadRecipe, RECIPE_PATH, recipeLine } from "./verify/recipe.ts";
import { startMirror } from "./verify/mirror.ts";
import { finish, prepare, type RunContext, screenshot } from "./verify/run.ts";
import { VIEWPORTS, viewportsOf } from "./verify/viewports.ts";

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

function cmdRecipe(root: string, args: Args) {
  const file = typeof args.flags.file === "string" ? args.flags.file : join(root, RECIPE_PATH);
  const recipe = loadRecipe(file);
  if (args._[1] !== "trigger") return say(renderPlan(recipe));
  const list = (k: string) => (typeof args.flags[k] === "string" ? (args.flags[k] as string).split(",").filter(Boolean) : []);
  const changed = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const t = triggered(recipe.trigger, { base: need(typeof args.flags.base === "string" ? args.flags.base : undefined, "--base"), labels: list("labels"), changed });
  say(`${t.run ? "run" : "skip"}: ${t.reason}`);
  if (!t.run) process.exitCode = 1;
}

function str(args: Args, k: string): string | undefined {
  const v = args.flags[k];
  return typeof v === "string" ? v : undefined;
}

/** Run dirs live outside the checkout: ~/gespann/runs/<run>/{work,out}. `last` points at the newest. */
function runContext(root: string, args: Args, fresh: boolean): RunContext {
  const runs = join(homedir(), "gespann", "runs");
  const lastFile = join(runs, "last");
  const run = str(args, "run") ?? (fresh ? randomBytes(6).toString("hex") : existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "");
  if (!/^[0-9a-f]{12}$/.test(run)) throw new Error("missing --run (12 hex characters), and no earlier prepare to continue");
  const dir = str(args, "dir") ?? join(runs, run);
  const rev = (r: string | undefined) => (r && /^[0-9a-f]{40}$/.test(r) ? r : (gitOk(root, ["rev-parse", r ?? "HEAD"])?.trim() ?? r ?? ""));
  const recipeFile = resolve(str(args, "recipe") ?? join(root, RECIPE_PATH));
  if (fresh) {
    mkdirSync(runs, { recursive: true });
    writeFileSync(lastFile, `${run}\n`);
  }
  return { root, recipeFile, pr: str(args, "pr") ?? "0", head: rev(str(args, "head")), base: rev(str(args, "base")), run, work: join(dir, "work"), out: join(dir, "out") };
}

/**
 * `verify recipe` and `verify prompt`, for the orchestrator: they need no git checkout. A prompt is
 * printed exactly as the function returns it (each ends with a newline already); a newline is added
 * only to one that does not.
 */
function cmdVerifyTool(args: Args): void {
  if (args._[1] === "recipe") return say(recipeLine(need(str(args, "recipe"), "--recipe")));
  const kind = args._[2] as PromptKind;
  if (!PROMPT_KINDS.includes(kind)) throw new Error(`usage: gespann verify prompt ${PROMPT_KINDS.join("|")} --input <file.json>`);
  const input = JSON.parse(readFileSync(need(str(args, "input"), "--input"), "utf8")) as Record<string, unknown>;
  const text = promptFor(kind, input);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** `--sizes phone-s,desktop`: known screen sizes in preset order; an unknown one is an error. */
function sizes(args: Args) {
  const list = (str(args, "sizes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((id) => !VIEWPORTS.some((v) => v.id === id));
  if (unknown.length) throw new Error(`unknown screen size ${unknown.join(", ")}; known: ${VIEWPORTS.map((v) => v.id).join(", ")}`);
  return viewportsOf(list.join(","));
}

/** `gespann mirror`: the copy at every size side by side until stopped; prints and writes `{"url"}`. */
async function cmdMirror(args: Args) {
  const m = await startMirror({ target: need(str(args, "url"), "--url"), viewports: sizes(args), ...(str(args, "notes") ? { notes: str(args, "notes") as string } : {}), ...(str(args, "port") ? { port: Number(str(args, "port")) } : {}) });
  const line = JSON.stringify({ url: m.url });
  const out = str(args, "out");
  if (out) writeFileSync(out, `${line}\n`);
  say(line);
  const stop = () => void m.close().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function cmdVerify(root: string, args: Args) {
  const sub = args._[1];
  if (sub === "prepare") {
    const ctx = runContext(root, args, true);
    const p = await prepare(ctx, loadRecipe(ctx.recipeFile), sizes(args));
    say(JSON.stringify({ ...p, run: ctx.run, work: ctx.work, out: ctx.out }));
    if (!p.ok) process.exitCode = 1;
    return;
  }
  if (sub === "finish") {
    const ctx = runContext(root, args, false);
    const wait = Number(str(args, "wait") ?? 600);
    const f = await finish(ctx, loadRecipe(ctx.recipeFile), wait * 1000);
    say(JSON.stringify({ outcome: f.outcome, problems: f.judged.problems, alongside: f.alongside, teardownErrors: f.teardownErrors, run: ctx.run }));
    if (f.outcome === "FAIL") process.exitCode = 1;
    return;
  }
  throw new Error("usage: gespann verify prepare|finish|recipe|prompt [--recipe f] [--pr n --head sha --base sha] [--run id]");
}

const HELP = `gespann ${VERSION}: acceptance testing for coding agents (Claude Code, Codex)

  init [--yes] [--agents claude,codex]   install the stop hook
  uninstall [--agents claude,codex]      remove gespann's hooks, keep all others
  status                                 which hooks are installed

  recipe [--file f]                      validate .gespann/verify.yml and print the run plan
  recipe trigger --base b [--labels a,b] [--file f] < changed-files
                                         exit 0 when the PR runs, 1 when it does not

  verify prepare [--recipe f] [--pr n --head sha --base sha] [--sizes phone-s,desktop]
                                         bring the copy up; prints {"ok","url","mirror","run","work","out"}
                                         (two sizes or more also start the mirror)
  verify finish [--run id] [--wait s]    wait for alongside checks, judge verdict.json, tear down
  verify recipe --recipe f               check a recipe; prints {"ok","timeout","prompt"} or {"ok":false,"error"}
  verify prompt <tester|setup|repair|suggest> --input f.json
                                         print an agent prompt (used by the orchestrator)
  mirror --url u --sizes phone-s,desktop [--notes f] [--out f] [--port n]
                                         show the copy at every size side by side; what you do in
                                         one size happens in all (until stopped)
  shot <file.png>                        save a screenshot of the desktop (for the tester)
  serve                                  run the gespann web service (see docs/self-host.md)

Agents call: gespann hook <claude|codex> stop`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.flags.version || cmd === "version") return say(VERSION);
  if (!cmd || cmd === "help" || args.flags.help) return say(HELP);
  if (cmd === "hook") return runHook(need(args._[1], "agent"), need(args._[2], "event"));
  if (cmd === "shot") {
    if (!screenshot(need(args._[1], "file"))) throw new Error("no screenshot tool worked (import, scrot, ffmpeg, xwd)");
    return say(resolve(args._[1] as string));
  }
  if (cmd === "serve") return (await import("./server/main.ts")).serve();
  if (cmd === "mirror") return cmdMirror(args);
  if (cmd === "verify" && (args._[1] === "recipe" || args._[1] === "prompt")) return cmdVerifyTool(args);
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
    case "recipe":
      return cmdRecipe(root, args);
    case "verify":
      return cmdVerify(root, args);
    default:
      throw new Error(`unknown command ${cmd}; see gespann help`);
  }
}
