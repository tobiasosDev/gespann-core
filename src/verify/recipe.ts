import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * `.gespann/verify.yml`: how to bring up a production-near copy of one PR and what the
 * tester needs to know about it. Every command runs with `sh -c` in the repo root and
 * these variables set:
 *
 *   GESPANN_PR, GESPANN_HEAD, GESPANN_BASE   the PR and the two commits under test
 *   GESPANN_RUN                              short id of this run (12 hex chars)
 *   GESPANN_WORK                             scratch dir the tester can read (fixtures, flag state, logs)
 *   GESPANN_OUT                              the tester's output dir (verdict.json, screenshots)
 *   GESPANN_ENV                              append `KEY=value` lines to pass values to later steps
 */
export interface Recipe {
  version: 1;
  trigger: Trigger;
  /** Minutes for the whole run, setup to verdict. */
  timeout: number;
  /** Runs in order before anything else: install, build images, fetch fixtures. */
  setup: Step[];
  /** Background processes for the whole run (fakes, replay proxy). Stopped at the end. */
  services: Service[];
  /** Which feature flags the environment runs. Stdout is the tester's flag sheet. */
  flags?: Flags;
  env: Environment;
  /** Replayed provider answers. A request without a recording leaves a file in `misses`. */
  replay?: { misses: string };
  /** Scripted checks that run beside the tester on the same build. */
  alongside: Alongside[];
  login?: Login;
  /** Named data states the tester may load into the environment. */
  seeds: Seed[];
  /** Repo-relative file appended to the generic tester prompt. */
  prompt?: string;
  /** Always runs at the end, after env.down, even when an earlier step failed. */
  cleanup: Step[];
}

export interface Trigger {
  /** PR base branches. Empty: any. */
  branches: string[];
  /** A changed file matching one of these starts a run. */
  paths: string[];
  /** Changed files matching these never start a run (tests, docs). */
  ignore: string[];
  /** A PR with this label always runs. */
  label?: string;
}

export interface Step {
  name: string;
  run: string;
}

export interface Service extends Step {
  /** Polled every second until it exits 0. It may append to $GESPANN_ENV, e.g. the service's URL. */
  ready?: string;
  /** Seconds to wait for `ready`. */
  readyTimeout: number;
}

export interface Flags {
  run: string;
  /** Page where the tester switches a flag, to test both states. */
  admin?: string;
  /**
   * Command that switches one flag on the running copy, run in the repo checkout with GESPANN_FLAG
   * (the key) and GESPANN_FLAG_STATE (`on` or `off`), e.g. for a flag read from the environment that
   * needs a restart. Exits 0 once the copy runs in that state.
   */
  switch?: string;
}

export interface Environment {
  up: string;
  down: string;
  /** Base URL of the app under test; `$VAR` refers to $GESPANN_ENV or the process environment. */
  url: string;
}

export interface Alongside extends Step {
  /** File in $GESPANN_WORK the tester reads for the result. */
  output?: string;
  /** A non-zero exit fails the run, whatever the tester found. */
  required: boolean;
}

export interface Login {
  path?: string;
  user: string;
  password: string;
  note?: string;
}

export interface Seed {
  name: string;
  run: string;
  about: string;
}

export class RecipeError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid recipe:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads one mapping and collects every problem instead of stopping at the first. */
class Reader {
  private readonly o: Obj;
  private readonly at: string;
  private readonly problems: string[];
  constructor(o: Obj, at: string, problems: string[]) {
    this.o = o;
    this.at = at;
    this.problems = problems;
  }

  path(k: string): string {
    return this.at ? `${this.at}.${k}` : k;
  }

  str(k: string, required: true): string;
  str(k: string, required?: false): string | undefined;
  str(k: string, required = false): string | undefined {
    const v = this.o[k];
    if (v === undefined || v === null) {
      if (required) this.problems.push(`${this.path(k)}: required`);
      return required ? "" : undefined;
    }
    if (typeof v !== "string" || !v.trim()) {
      this.problems.push(`${this.path(k)}: must be a non-empty string`);
      return required ? "" : undefined;
    }
    return v;
  }

  num(k: string, fallback: number): number {
    const v = this.o[k];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      this.problems.push(`${this.path(k)}: must be a positive number`);
      return fallback;
    }
    return v;
  }

  bool(k: string, fallback: boolean): boolean {
    const v = this.o[k];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") {
      this.problems.push(`${this.path(k)}: must be true or false`);
      return fallback;
    }
    return v;
  }

  strings(k: string): string[] {
    const v = this.o[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
      this.problems.push(`${this.path(k)}: must be a list of strings`);
      return [];
    }
    return v as string[];
  }

  obj(k: string, required = false): Reader | undefined {
    const v = this.o[k];
    if (v === undefined || v === null) {
      if (required) this.problems.push(`${this.path(k)}: required`);
      return undefined;
    }
    if (!isObj(v)) {
      this.problems.push(`${this.path(k)}: must be a mapping`);
      return undefined;
    }
    return new Reader(v, this.path(k), this.problems);
  }

  /** Reports every field not in `allowed`: a typo must not silently drop a setting. */
  fields(allowed: string[]): this {
    for (const k of Object.keys(this.o)) if (!allowed.includes(k)) this.problems.push(`${this.path(k)}: unknown field`);
    return this;
  }

  list(k: string): Reader[] {
    const v = this.o[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.problems.push(`${this.path(k)}: must be a list`);
      return [];
    }
    return v.flatMap((x, i) => {
      if (isObj(x)) return [new Reader(x, `${this.path(k)}[${i}]`, this.problems)];
      this.problems.push(`${this.path(k)}[${i}]: must be a mapping`);
      return [];
    });
  }
}

function step(r: Reader, extra: string[] = []): Step {
  r.fields(["name", "run", ...extra]);
  return { name: r.str("name", true), run: r.str("run", true) };
}

export function parseRecipe(text: string): Recipe {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new RecipeError([`not valid YAML: ${(err as Error).message}`]);
  }
  if (!isObj(raw)) throw new RecipeError(["the recipe must be a mapping"]);
  const top = new Reader(raw, "", problems).fields(["version", "trigger", "timeout", "mode", "setup", "services", "flags", "env", "replay", "alongside", "login", "seeds", "prompt", "cleanup"]);

  if (raw.version !== 1) problems.push("version: must be 1");
  // `mode` is read no more: whether a FAIL blocks the merge is the project's merge gate, switched on
  // the project page. Recipes that still carry it stay valid.

  const t = top.obj("trigger", true)?.fields(["branches", "paths", "ignore", "label"]);
  const trigger: Trigger = { branches: t?.strings("branches") ?? [], paths: t?.strings("paths") ?? [], ignore: t?.strings("ignore") ?? [] };
  const label = t?.str("label");
  if (label) trigger.label = label;
  if (t && trigger.paths.length === 0 && !label) problems.push("trigger: needs paths or a label, or no PR would ever run");

  const e = top.obj("env", true)?.fields(["up", "down", "url"]);
  const env: Environment = { up: e?.str("up", true) ?? "", down: e?.str("down", true) ?? "", url: e?.str("url", true) ?? "" };

  const services = top.list("services").map((s) => {
    const base = step(s, ["ready", "readyTimeout"]);
    const ready = s.str("ready");
    return { ...base, ...(ready ? { ready } : {}), readyTimeout: s.num("readyTimeout", 60) };
  });

  const alongside = top.list("alongside").map((a) => {
    const base = step(a, ["output", "required"]);
    const output = a.str("output");
    if (output && (output.includes("/") || output.startsWith("."))) problems.push(`${a.path("output")}: a file name in $GESPANN_WORK, no path`);
    return { ...base, ...(output ? { output } : {}), required: a.bool("required", true) };
  });

  const seeds = top.list("seeds").map((s) => ({ ...step(s, ["about"]), about: s.str("about", true) }));
  const names = [...services, ...alongside, ...seeds].map((x) => x.name);
  for (const n of new Set(names.filter((n, i) => n && names.indexOf(n) !== i))) problems.push(`name "${n}" is used twice`);

  const recipe: Recipe = {
    version: 1,
    trigger,
    timeout: top.num("timeout", 25),
    setup: top.list("setup").map((s) => step(s)),
    services,
    env,
    alongside,
    seeds,
    cleanup: top.list("cleanup").map((s) => step(s)),
  };

  const f = top.obj("flags")?.fields(["run", "admin", "switch"]);
  if (f) {
    const admin = f.str("admin");
    const sw = f.str("switch");
    recipe.flags = { run: f.str("run", true), ...(admin ? { admin } : {}), ...(sw ? { switch: sw } : {}) };
  }
  const rp = top.obj("replay")?.fields(["misses"]);
  if (rp) recipe.replay = { misses: rp.str("misses", true) };
  const l = top.obj("login")?.fields(["path", "user", "password", "note"]);
  if (l) {
    const path = l.str("path");
    const note = l.str("note");
    recipe.login = { user: l.str("user", true), password: l.str("password", true), ...(path ? { path } : {}), ...(note ? { note } : {}) };
  }
  const prompt = top.str("prompt");
  if (prompt) {
    if (prompt.startsWith("/") || prompt.split("/").includes("..")) problems.push("prompt: a repo-relative path");
    recipe.prompt = prompt;
  }

  if (problems.length) throw new RecipeError(problems);
  return recipe;
}

export const RECIPE_PATH = ".gespann/verify.yml";

export function loadRecipe(file: string): Recipe {
  return parseRecipe(readFileSync(file, "utf8"));
}

/**
 * `gespann verify recipe`: one JSON line for the orchestrator, the recipe's timeout (minutes) and
 * prompt addendum, or why the file is no valid recipe.
 */
export function recipeLine(file: string): string {
  try {
    const r = loadRecipe(file);
    return JSON.stringify({ ok: true, timeout: r.timeout, prompt: r.prompt ?? null });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
