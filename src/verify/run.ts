import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny } from "../glob.ts";
import { FLAG_CHANGES } from "./flags.ts";
import { judge, type AccessUse, type Judged } from "./verdict.ts";
import type { Access, Recipe, Step } from "./recipe.ts";
import type { Viewport } from "./viewports.ts";

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
  /** The mirror page that shows the copy at every screen size at once (two sizes or more). */
  mirror?: string;
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

export const ACCESS_FILE = "access.json";

/** The recipe's outside services, for this process. */
let services: Access[] = [];
/** Keys this prepare hands to the recipe's commands, by variable; they never reach a file. */
let keyEnv: Record<string, string> = {};

/** Command output with every key handed out replaced, before it reaches a log the tester or a user reads. */
function scrub(text: string): string {
  let out = text;
  for (const v of Object.values(keyEnv)) if (v.length >= 8) out = out.split(v).join("[key]");
  return out;
}

/**
 * The keys stored for this run. From `--keys`, a JSON object `{NAME: key}` the orchestrator writes just
 * before: read and deleted at once, so nothing the tester runs later finds it. Without the file (a CI
 * runner), the process environment holds them.
 */
export function takeKeys(file: string | undefined, names: string[], environ: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys: Record<string, string> = {};
  if (file === undefined) {
    for (const n of names) if (environ[n]) keys[n] = environ[n] as string;
    return keys;
  }
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // no file: nothing stored
  } finally {
    rmSync(file, { force: true });
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const n of names) {
      const v = (raw as Record<string, unknown>)[n];
      if (typeof v === "string" && v) keys[n] = v;
    }
  }
  return keys;
}

/** Files the PR changes (`base...head`); null when git cannot tell. */
export function changedFiles(root: string, base: string, head: string): string[] | null {
  const r = spawnSync("git", ["-C", root, "diff", "--name-only", "--no-renames", `${base}...${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return r.status === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

/** Which services run for real: a key is stored and the PR changes a file of that service's code. */
export function accessUses(access: Access[], keys: Record<string, string>, changed: string[] | null): AccessUse[] {
  return access.map((a) => {
    const use = { name: a.name, about: a.about };
    if (!keys[a.name]) return { ...use, real: false, why: "no key stored" };
    if (changed === null) return { ...use, real: false, why: "the PR's changed files could not be read" };
    const hits = changed.filter((f) => matchesAny(f, a.paths));
    if (!hits.length) return { ...use, real: false, why: "the PR does not change its code" };
    const shown = hits.slice(0, 3).join(", ");
    return { ...use, real: true, why: `the PR changes ${shown}${hits.length > 3 ? ` and ${hits.length - 3} more` : ""}` };
  });
}

/**
 * Sets what this process's commands see of the outside services: the keys `prepare` decided to hand out
 * (`real` in access.json) and no variable for the others. A later process (finish, a flag switch) has
 * no orchestrator file any more; it finds keys only in its own environment, as a CI runner sets them.
 */
function useAccess(ctx: RunContext, r: Recipe, keys: Record<string, string>): void {
  services = r.access;
  const real = new Set(readAccess(ctx.work).filter((a) => a.real).map((a) => a.name));
  keyEnv = Object.fromEntries(Object.entries(keys).filter(([n]) => real.has(n)));
}

/** The services as the run ran them, from $GESPANN_WORK/access.json; empty before prepare or without any. */
export function readAccess(work: string): AccessUse[] {
  try {
    const list = JSON.parse(readFileSync(join(work, ACCESS_FILE), "utf8")) as unknown;
    return Array.isArray(list) ? (list as AccessUse[]) : [];
  } catch {
    return [];
  }
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
  // A service without a key handed out sees no variable, whatever the machine's environment holds: it runs the fake.
  const unset = Object.fromEntries(services.map((a) => [a.name, undefined]));
  return {
    ...process.env,
    ...unset,
    ...keyEnv,
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
  if (r.stdout) appendFileSync(logFile(ctx), scrub(r.stdout));
  if (r.stderr) appendFileSync(logFile(ctx), scrub(r.stderr));
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

/**
 * Starts the mirror (`gespann mirror`) in the background like a service, so teardown stops it, and
 * waits for its URL. Undefined when it does not start: the tester then goes through the sizes one by one.
 */
async function mirrorUp(ctx: RunContext, state: State, url: string, viewports: Viewport[]): Promise<string | undefined> {
  const out = join(ctx.work, "mirror.json");
  const sh = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
  const bin = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "../bin.js", import.meta.url));
  const command = [process.execPath, bin, "mirror", "--url", url, "--sizes", viewports.map((v) => v.id).join(","), "--notes", join(ctx.work, "mirror-notes.txt"), "--out", out];
  const pid = background(ctx, "mirror", `exec ${command.map(sh).join(" ")}`);
  state.services.push({ name: "mirror", pid });
  save(ctx, state);
  for (const until = Date.now() + 15_000; Date.now() < until && alive(pid); await sleep(200)) {
    if (!existsSync(out)) continue;
    try {
      const m = JSON.parse(readFileSync(out, "utf8")) as { url?: string };
      if (m.url) {
        log(ctx, `✓ mirror for ${viewports.length} screen sizes at ${m.url}`);
        return m.url;
      }
    } catch {
      // still being written
    }
  }
  log(ctx, "✗ the mirror did not start; the tester checks the screen sizes one after the other");
  return undefined;
}

export async function prepare(ctx: RunContext, r: Recipe, viewports: Viewport[] = [], keysFile?: string): Promise<Prepared> {
  mkdirSync(ctx.work, { recursive: true });
  mkdirSync(ctx.out, { recursive: true });
  // `gespann verify flag` runs recipe commands for this run later, from the work dir alone.
  writeFileSync(join(ctx.work, "context.json"), `${JSON.stringify(ctx)}\n`);
  const names = r.access.map((a) => a.name);
  const keys = takeKeys(keysFile, names);
  const uses = accessUses(r.access, keys, r.access.length && Object.keys(keys).length ? changedFiles(ctx.root, ctx.base, ctx.head) : []);
  writeFileSync(join(ctx.work, ACCESS_FILE), `${JSON.stringify(uses, null, 2)}\n`);
  for (const u of uses) log(ctx, `${u.real ? "real" : "fake"} ${u.about} (${u.name}): ${u.why}`);
  useAccess(ctx, r, keys);
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
  if (!isCopyUrl(url)) return fail(`env.url resolved to ${JSON.stringify(url)}, not a URL (http(s)://… or ios-simulator://<bundle id>)`);
  state.url = url;

  for (const a of r.alongside) {
    const statusFile = join(ctx.work, `${a.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.exit`);
    const pid = background(ctx, a.name, `(${a.run}); echo $? > ${JSON.stringify(statusFile)}`);
    state.alongside.push({ name: a.name, pid, statusFile, required: a.required, ...(a.output ? { output: a.output } : {}) });
  }
  save(ctx, state);
  log(ctx, `✓ copy is up at ${url}`);
  const mirror = viewports.length > 1 ? await mirrorUp(ctx, state, url, viewports) : undefined;
  const prepared: Prepared = { ok: true, url, ...(mirror ? { mirror } : {}) };
  writeFileSync(join(ctx.work, "prepared.json"), `${JSON.stringify(prepared)}\n`);
  return prepared;
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
  useAccess(ctx, r, takeKeys(undefined, r.access.map((a) => a.name)));
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
    judged = judge(existsSync(file) ? readFileSync(file, "utf8") : null, (f) => proofOk(join(ctx.out, f)), issueRefs(ctx), flagKeys(ctx));
  } finally {
    teardownErrors = await teardown(ctx, r);
  }
  const failedRequired = alongside.filter((a) => a.required && a.exit !== 0);
  let outcome = judged.outcome;
  if (failedRequired.length) {
    outcome = "FAIL";
    judged.problems.push(...failedRequired.map((a) => `alongside check "${a.name}" ${a.exit === null ? "did not finish" : `exited ${a.exit}`}`));
  }
  const access = readAccess(ctx.work);
  if (access.length) judged.access = access;
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

/** The run a work dir belongs to, as `prepare` left it there. */
export function contextOf(work: string): RunContext {
  const file = join(work, "context.json");
  if (!existsSync(file)) throw new Error(`${work} is no work dir of a prepared run`);
  return JSON.parse(readFileSync(file, "utf8")) as RunContext;
}

/**
 * Switches one feature flag on the running copy with the recipe's `flags.switch`, in the recipe's
 * environment plus GESPANN_FLAG and GESPANN_FLAG_STATE. The tester calls it as `gespann verify flag`.
 */
export function switchFlag(ctx: RunContext, r: Recipe, key: string, state: "on" | "off"): { ok: boolean; output: string } {
  if (!r.flags?.switch) return { ok: false, output: "the recipe has no flags.switch" };
  useAccess(ctx, r, takeKeys(undefined, r.access.map((a) => a.name)));
  log(ctx, `▶ flag ${key} ${state}`);
  const res = spawnSync("bash", ["-c", r.flags.switch], { cwd: ctx.root, env: { ...env(ctx), GESPANN_FLAG: key, GESPANN_FLAG_STATE: state }, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const output = scrub(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  if (output) appendFileSync(logFile(ctx), output);
  const ok = res.status === 0;
  log(ctx, `${ok ? "✓" : "✗"} flag ${key} ${state}${ok ? "" : ` (exit ${res.status ?? res.signal ?? res.error?.message})`}`);
  return { ok, output };
}

/** The feature flags found in the PR's diff (`flag-changes.json` in the work dir, written with the tester's prompt). */
function flagKeys(ctx: RunContext): string[] {
  const file = join(ctx.work, FLAG_CHANGES);
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as { key?: unknown }[];
    return Array.isArray(list) ? list.map((f) => String(f?.key ?? "")).filter(Boolean) : [];
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

/** Where the copy runs: a web address, or an iOS app on the booted simulator (`ios-simulator://<bundle id>`). */
export function isCopyUrl(url: string): boolean {
  return /^https?:\/\/\S+$/.test(url) || /^ios-simulator:\/\/[A-Za-z0-9][A-Za-z0-9.-]*$/.test(url);
}

/** How `screenshot` tries to capture the screen, first try first. */
export function screenshotTries(file: string, platform: NodeJS.Platform = process.platform, display = process.env.DISPLAY || ":0"): string[] {
  const q = JSON.stringify(resolve(file));
  // A Mac: the booted iOS Simulator's screen (what the tester drives), else the whole desktop.
  if (platform === "darwin") return [`xcrun simctl io booted screenshot --type=png ${q}`, `screencapture -x -t png ${q}`];
  return [
    `import -display ${display} -window root -trim +repage ${q}`,
    `scrot -o ${q}`,
    `ffmpeg -loglevel error -y -f x11grab -i ${display} -frames:v 1 ${q}`,
    `xwd -root -display ${display} | convert xwd:- ${q}`,
  ];
}

/**
 * Saves a PNG of the sandbox screen. Tries the tools a Linux desktop usually has, or on a Mac the iOS
 * Simulator. The empty screen around a browser window smaller than the screen (a phone size) is cut off.
 */
export function screenshot(file: string): boolean {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const display = process.env.DISPLAY || ":0";
  for (const t of screenshotTries(file, process.platform, display)) {
    const r = spawnSync("bash", ["-c", t], { env: { ...process.env, DISPLAY: display }, timeout: 20_000 });
    if (r.status === 0 && existsSync(resolve(file))) return true;
  }
  return false;
}
