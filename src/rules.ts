import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configDir, now, readJson, sha, userName, writeJson } from "./util.ts";

/** Where a rule acts. Ranked like pstack /correct: a check that runs beats an instruction the agent may skip. */
export type Level = "observe" | "skill" | "hook";
/** CI behaviour of `gespann run --ci`: report = annotate only (trial), block = fail the job. */
export type CiMode = "off" | "report" | "block";

export interface Requirement {
  env?: string;
  command?: string;
}

export interface Check {
  command: string;
  /** Directory relative to the repo root. */
  cwd?: string;
  /** Regex that recognises the agent running this check itself. Defaults to the command text. */
  match?: string;
  requires?: Requirement[];
  timeoutSec?: number;
}

export interface RuleVersion {
  id: string;
  version: number;
  title: string;
  why: string;
  /** Globs (repo-relative) whose change makes the check expected. */
  paths: string[];
  check?: Check;
  level: Level;
  ci: CiMode;
  /** Instruction text distributed as an agent skill. */
  skill?: string;
  origin?: { proposal?: string; importedFrom?: string };
}

export type RuleStatus = "observing" | "trial" | "adopted" | "rolled_back";

export interface HistoryEntry {
  at: string;
  by: string;
  action: string;
  version: number;
  note?: string;
}

export interface RuleState {
  active: number;
  status: RuleStatus;
  trial?: { version: number; previous: number | null; started: string; days: number };
  /** The version that was active before the current one (null: the rule did not exist). Survives adoption. */
  previous?: number | null;
  /** sha256 of each version file when it was activated. Catches a version edited after approval. */
  digests?: Record<string, string>;
  history: HistoryEntry[];
}

export interface State {
  rules: Record<string, RuleState>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function statePath(root: string): string {
  return join(configDir(root), "state.json");
}

export function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid rule id "${id}" (lowercase letters, digits, dashes)`);
}

export function versionPath(root: string, id: string, version: number): string {
  assertId(id);
  if (!Number.isInteger(version) || version < 1) throw new Error(`invalid version ${version}`);
  return join(configDir(root), "rules", id, `v${version}.json`);
}

export function loadState(root: string): State {
  return readJson<State>(statePath(root)) ?? { rules: {} };
}

export function saveState(root: string, state: State): void {
  writeJson(statePath(root), state);
}

export function loadVersion(root: string, id: string, version: number): RuleVersion {
  const v = readJson<RuleVersion>(versionPath(root, id, version));
  if (!v) throw new Error(`rule ${id} has no version ${version}`);
  return v;
}

export function versions(root: string, id: string): number[] {
  assertId(id);
  const dir = join(configDir(root), "rules", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b);
}

export function validate(v: RuleVersion): void {
  if (!ID_RE.test(v.id)) throw new Error(`invalid rule id "${v.id}" (lowercase letters, digits, dashes)`);
  if (!Number.isInteger(v.version) || v.version < 1) throw new Error(`invalid version ${v.version}`);
  if (!v.title) throw new Error("rule needs a title");
  if (!Array.isArray(v.paths) || v.paths.length === 0) throw new Error("rule needs at least one path glob");
  if (!["observe", "skill", "hook"].includes(v.level)) throw new Error(`invalid level ${v.level}`);
  if (!["off", "report", "block"].includes(v.ci)) throw new Error(`invalid ci mode ${v.ci}`);
  if (v.level === "hook" && !v.check) throw new Error("level hook needs a check command");
  if (v.level === "skill" && !v.skill) throw new Error("level skill needs skill text");
  if (v.ci !== "off" && !v.check) throw new Error("ci needs a check command");
  if (v.check?.match) new RegExp(v.check.match);
}

/** Versions are immutable: a change is always a new file. */
export function saveVersion(root: string, v: RuleVersion): void {
  validate(v);
  const path = versionPath(root, v.id, v.version);
  if (existsSync(path)) {
    // An identical file is a retry of an interrupted write, not a change.
    if (readFileSync(path, "utf8") === `${JSON.stringify(v, null, 2)}\n`) return;
    throw new Error(`rule ${v.id} v${v.version} already exists; versions are immutable`);
  }
  writeJson(path, v);
}

/**
 * Active versions, verified against the digest taken at activation. This catches an approved
 * version edited in place; it is not a security boundary (anyone who can edit the repo can edit
 * the scripts a check runs).
 */
export function activeRules(root: string, state = loadState(root)): RuleVersion[] {
  return Object.entries(state.rules)
    .map(([id, s]) => {
      const digest = s.digests?.[String(s.active)];
      if (digest && digest !== sha(readFileSync(versionPath(root, id, s.active), "utf8"))) {
        throw new Error(`${versionPath(root, id, s.active)} changed after approval; restore it or propose a new version`);
      }
      return loadVersion(root, id, s.active);
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function activeVersions(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, s] of Object.entries(loadState(root).rules)) out[id] = s.active;
  return out;
}

export function record(root: string, state: State, id: string, action: string, version: number, note?: string): void {
  const rs = state.rules[id];
  if (!rs) throw new Error(`unknown rule ${id}`);
  rs.history.push({ at: now(), by: userName(root), action, version, ...(note ? { note } : {}) });
  const path = versionPath(root, id, version);
  if (existsSync(path)) {
    rs.digests ??= {};
    rs.digests[String(version)] ??= sha(readFileSync(path, "utf8"));
  }
}

export function checkMatcher(v: RuleVersion): RegExp | undefined {
  if (!v.check) return undefined;
  if (v.check.match) return new RegExp(v.check.match);
  const escaped = v.check.command.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(escaped);
}

export interface Invocation {
  /** The command runs the check, from the right directory. */
  ran: boolean;
  /** Its exit code is the check's own: last step, foreground, not piped. */
  ownExit: boolean;
}

const HEREDOC_BODY = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g;
const PREFIX = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|command|exec)\s+)*/;
/** What may stand before the check in its step: a runner, not `echo` or `grep`. */
const RUNNER = /^(?:(?:npx|bunx|bun\s+x|pnpm(?:\s+exec)?|yarn|sh|bash|node)\s+|\S*node_modules\/\.bin\/)*$/;

/**
 * Whether a shell command ran a rule's check. The check must start a step (`echo npm test` does
 * not count), and run where the rule says (a passing `npm test` in package A says nothing about B).
 * `npm run lint | tail`, `npm run lint; git status` or `npm run lint &` ran it, but their exit code
 * belongs to something else.
 */
export function invocation(command: string, rule: RuleVersion, root: string, cwd: string): Invocation {
  const re = checkMatcher(rule);
  if (!re) return { ran: false, ownExit: false };
  // Keep the operators: `a || check` may skip the check, `check & wait` hides its status.
  // `2>&1` and `<&3` are redirections, not background operators; `# …` is a comment.
  const parts = command
    .replace(HEREDOC_BODY, " ")
    .replace(/(^|\s)#[^\n]*/g, "$1")
    .split(/(\n|;|&&|\|\||(?<![<>&])&(?![&>]))/);
  const steps: string[] = [];
  const before: string[] = [];
  const after: string[] = [];
  let op = "";
  for (let i = 0; i < parts.length; i += 2) {
    const step = (parts[i] ?? "").trim();
    const next = parts[i + 1] ?? "";
    if (step) {
      steps.push(step);
      before.push(op);
      after.push(next);
    }
    // `a ||` + newline + `b` continues the list: the pending operator still applies to b.
    if (step || !["||", "&&"].includes(op)) op = next || op;
  }
  const ruleDir = join(root, rule.check?.cwd ?? ".");
  let dir = cwd;
  let found = -1;
  steps.forEach((step, i) => {
    const cd = /^cd\s+['"]?([^'"\s]+)['"]?$/.exec(step);
    if (cd) {
      dir = resolve(dir, (cd[1] as string).replace(/^~(?=\/|$)/, homedir()));
      return;
    }
    const body = step.replace(PREFIX, "");
    const m = re.exec(body);
    if (!m || !RUNNER.test(body.slice(0, m.index))) return;
    if (before[i] === "||") return;
    // A package-manager option that selects the rule's directory, e.g. `npm --prefix apps/web run lint`.
    const opt = /(?:^|\s)(?:--prefix|--cwd|--dir|-C)[=\s]+['"]?([^'"\s]+)['"]?/.exec(body);
    const target = opt ? resolve(dir, opt[1] as string) : resolve(dir);
    if (target === resolve(ruleDir)) found = i;
  });
  if (found < 0) return { ran: false, ownExit: false };
  const step = steps[found] as string;
  const last = found === steps.length - 1;
  return { ran: true, ownExit: last && !/\|/.test(step) && after[found] !== "&" && !after.slice(found).includes("&") };
}
