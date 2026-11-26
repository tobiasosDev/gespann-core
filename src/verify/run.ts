import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { judge, type Judged } from "./verdict.ts";
import type { Recipe, Step } from "./recipe.ts";

/**
 * Runs a recipe on the machine that hosts the copy (a sandbox or a CI runner), in two
 * halves around the tester: `prepare` brings the copy up and leaves services and alongside
 * checks running; `finish` waits for them, judges verdict.json and always tears down.
 */
export interface RunContext {
  /** Repo checkout at the commit under test; every command runs here. */
  root: string;
  recipeFile: string;
  pr: string;
  head: string;
  base: string;
  run: string;
  /** Scratch dir for this run; the tester may read it. */
  work: string;
  /** The tester's output dir. */
  out: string;
}

interface State {
  services: { name: string; pid: number }[];
  alongside: { name: string; pid: number; statusFile: string; required: boolean; output?: string }[];
  url?: string;
  upDone?: boolean;
  tornDown?: boolean;
}

export interface Prepared {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface Finished {
  judged: Judged;
  alongside: { name: string; exit: number | null; required: boolean }[];
  /** PASS/SKIP of the tester can still fail the run when a required alongside check failed. */
  outcome: Judged["outcome"];
  teardownErrors: string[];
}

const stateFile = (ctx: RunContext) => join(ctx.work, "state.json");
const envFile = (ctx: RunContext) => join(ctx.work, "env");
const logFile = (ctx: RunContext) => join(ctx.work, "run.log");

function log(ctx: RunContext, line: string): void {
  appendFileSync(logFile(ctx), `${new Date().toISOString()} ${line}\n`);
}

/** `KEY=value` lines the steps appended to $GESPANN_ENV; later lines win. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

export function expand(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a: string | undefined, b: string | undefined) => env[(a ?? b) as string] ?? "");
}

function env(ctx: RunContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GESPANN_PR: ctx.pr,
    GESPANN_HEAD: ctx.head,
    GESPANN_BASE: ctx.base,
    GESPANN_RUN: ctx.run,
    GESPANN_WORK: ctx.work,
    GESPANN_OUT: ctx.out,
    GESPANN_ENV: envFile(ctx),
    GESPANN_PROJECT: dirname(resolve(ctx.recipeFile)),
    ...readEnvFile(envFile(ctx)),
  };
}

function runStep(ctx: RunContext, step: Step, timeoutMs: number): { ok: boolean; stdout: string } {
  log(ctx, `▶ ${step.name}`);
  const r = spawnSync("bash", ["-c", step.run], { cwd: ctx.root, env: env(ctx), encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.stdout) appendFileSync(logFile(ctx), r.stdout);
  if (r.stderr) appendFileSync(logFile(ctx), r.stderr);
  const ok = r.status === 0;
  log(ctx, `${ok ? "✓" : "✗"} ${step.name}${ok ? "" : ` (exit ${r.status ?? r.signal ?? r.error?.message})`}`);
  return { ok, stdout: r.stdout ?? "" };
}

/** Starts a long-running command in its own process group so teardown can stop all of it. */
function background(ctx: RunContext, name: string, command: string): number {
  const file = join(ctx.work, `${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.log`);
  const fd = openSync(file, "a");
  const child = spawn("bash", ["-c", command], { cwd: ctx.root, env: env(ctx), detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  log(ctx, `▶ ${name} in the background (pid ${child.pid}, log ${file})`);
  return child.pid as number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function save(ctx: RunContext, s: State): void {
  writeFileSync(stateFile(ctx), `${JSON.stringify(s, null, 2)}\n`);
}

function load(ctx: RunContext): State {
  return existsSync(stateFile(ctx)) ? (JSON.parse(readFileSync(stateFile(ctx), "utf8")) as State) : { services: [], alongside: [] };
}

export async function prepare(ctx: RunContext, r: Recipe): Promise<Prepared> {
  mkdirSync(ctx.work, { recursive: true });
  mkdirSync(ctx.out, { recursive: true });
  const deadline = Date.now() + r.timeout * 60_000;
  const left = () => Math.max(1000, deadline - Date.now());
  const state: State = { services: [], alongside: [] };
  save(ctx, state);
  const fail = async (error: string): Promise<Prepared> => {
    log(ctx, `✗ ${error}`);
    await teardown(ctx, r);
    return { ok: false, error };
  };

  for (const s of r.setup) if (!runStep(ctx, s, left()).ok) return fail(`setup step "${s.name}" failed`);

  for (const s of r.services) {
    const pid = background(ctx, s.name, s.run);
    state.services.push({ name: s.name, pid });
    save(ctx, state);
    if (!s.ready) continue;
    const until = Date.now() + s.readyTimeout * 1000;
    let ready = false;
    while (Date.now() < until) {
      if (spawnSync("bash", ["-c", s.ready], { cwd: ctx.root, env: env(ctx), timeout: 30_000 }).status === 0) {
        ready = true;
        break;
      }
      if (!alive(pid)) break;
      await sleep(1000);
    }
    if (!ready) return fail(`service "${s.name}" was not ready within ${s.readyTimeout} s`);
    log(ctx, `✓ ${s.name} ready`);
  }

  if (r.flags) {
    const f = runStep(ctx, { name: "feature flags", run: r.flags.run }, left());
    if (!f.ok) return fail("the feature-flag step failed");
    writeFileSync(join(ctx.work, "flags.md"), f.stdout);
  }

  state.upDone = true;
  save(ctx, state);
  if (!runStep(ctx, { name: "environment up", run: r.env.up }, left()).ok) return fail("env.up failed");
  const url = expand(r.env.url, env(ctx));
  if (!/^https?:\/\/\S+$/.test(url)) return fail(`env.url resolved to ${JSON.stringify(url)}, not a URL`);
  state.url = url;

  for (const a of r.alongside) {
    const statusFile = join(ctx.work, `${a.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.exit`);
    const pid = background(ctx, a.name, `(${a.run}); echo $? > ${JSON.stringify(statusFile)}`);
    state.alongside.push({ name: a.name, pid, statusFile, required: a.required, ...(a.output ? { output: a.output } : {}) });
  }
  save(ctx, state);
  writeFileSync(join(ctx.work, "prepared.json"), `${JSON.stringify({ ok: true, url })}\n`);
  log(ctx, `✓ copy is up at ${url}`);
  return { ok: true, url };
}

async function teardown(ctx: RunContext, r: Recipe): Promise<string[]> {
  const s = load(ctx);
  if (s.tornDown) return [];
  const errors: string[] = [];
  for (const a of s.alongside) if (alive(a.pid)) killGroup(a.pid);
  if (s.upDone && !runStep(ctx, { name: "environment down", run: r.env.down }, 10 * 60_000).ok) errors.push("env.down failed");
  for (const svc of s.services) killGroup(svc.pid);
  for (const c of r.cleanup) if (!runStep(ctx, c, 10 * 60_000).ok) errors.push(`cleanup "${c.name}" failed`);
  if (!errors.length) save(ctx, { ...load(ctx), tornDown: true });
  return errors;
}

export async function finish(ctx: RunContext, r: Recipe, waitMs = 10 * 60_000): Promise<Finished> {
  const s = load(ctx);
  const until = Date.now() + waitMs;
  while (s.alongside.some((a) => !existsSync(a.statusFile)) && Date.now() < until) await sleep(2000);
  const file = join(ctx.out, "verdict.json");
  let judged: Judged;
  let alongside: Finished["alongside"];
  let teardownErrors: string[] = [];
  try {
    alongside = s.alongside.map((a) => {
      const text = existsSync(a.statusFile) ? readFileSync(a.statusFile, "utf8").trim() : "";
      return { name: a.name, exit: text === "" ? null : Number(text), required: a.required };
    });
    judged = judge(existsSync(file) ? readFileSync(file, "utf8") : null, (f) => proofOk(join(ctx.out, f)), issueRefs(ctx));
  } finally {
    teardownErrors = await teardown(ctx, r);
  }
  const failedRequired = alongside.filter((a) => a.required && a.exit !== 0);
  let outcome = judged.outcome;
  if (failedRequired.length) {
    outcome = "FAIL";
    judged.problems.push(...failedRequired.map((a) => `alongside check "${a.name}" ${a.exit === null ? "did not finish" : `exited ${a.exit}`}`));
  }
  const result: Finished = { judged, alongside, outcome, teardownErrors };
  writeFileSync(join(ctx.work, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** The linked issues the tester was given (`issues.json` in the work dir, written by the server). */
function issueRefs(ctx: RunContext): string[] {
  const file = join(ctx.work, "issues.json");
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as { ref?: unknown }[];
    return Array.isArray(list) ? list.map((i) => String(i?.ref ?? "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** A proof file exists; an image must also start like a PNG, JPEG, GIF or WebP. */
export function proofOk(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return true;
    const head = Buffer.alloc(12);
    const fd = openSync(path, "r");
    const n = readSync(fd, head, 0, 12, 0);
    closeSync(fd);
    const hex = head.subarray(0, n).toString("hex");
    const text = head.subarray(0, n).toString("latin1");
    return hex.startsWith("89504e470d0a1a0a") || hex.startsWith("ffd8ff") || text.startsWith("GIF87a") || text.startsWith("GIF89a") || (n === 12 && text.startsWith("RIFF") && text.slice(8, 12) === "WEBP");
  } catch {
    return false;
  }
}

/** Saves a PNG of the sandbox screen. Tries the tools a Linux desktop usually has. */
export function screenshot(file: string): boolean {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const display = process.env.DISPLAY || ":0";
  const q = JSON.stringify(resolve(file));
  const tries = [
    `import -display ${display} -window root ${q}`,
    `scrot -o ${q}`,
    `ffmpeg -loglevel error -y -f x11grab -i ${display} -frames:v 1 ${q}`,
    `xwd -root -display ${display} | convert xwd:- ${q}`,
  ];
  for (const t of tries) {
    const r = spawnSync("bash", ["-c", t], { env: { ...process.env, DISPLAY: display }, timeout: 20_000 });
    if (r.status === 0 && existsSync(resolve(file))) return true;
  }
  return false;
}
