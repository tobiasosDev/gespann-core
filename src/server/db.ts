import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KEY_AGENTS, type KeyAgent } from "./agentkeys.ts";

export type CodexState = "none" | "pending" | "connected" | "failed";
/**
 * Who runs the agent for a user's projects: Codex on their ChatGPT plan, Codex on OpenRouter with their own key,
 * or Claude Code, the Copilot CLI or the Grok CLI with their own key (src/server/agentkeys.ts).
 */
export type AgentProvider = "codex" | "openrouter" | KeyAgent;
export const AGENT_PROVIDERS: readonly AgentProvider[] = ["codex", "openrouter", ...KEY_AGENTS];

/** SQL over `users`: the agent can run, on the provider the user chose. The orchestrator's db.rs has the same. */
export const AGENT_READY =
  "(case agent when 'openrouter' then openrouter_key is not null and openrouter_model is not null when 'claude' then claude_key is not null when 'copilot' then copilot_key is not null when 'grok' then grok_key is not null or grok_auth is not null else codex_state = 'connected' end)";

/** A key agent's connection in Settings, without the key. */
export interface KeyAgentState {
  connected: boolean;
  label: string | null;
  model: string | null;
  /** The device-code sign-in (Copilot, Grok): its state and what the CLI printed so far. */
  login: { state: string; url: string | null; code: string | null; lines: string } | null;
}

/** Agents that sign in with a device code in the orchestrator (`<agent>_login_state`, `<agent>_login`). */
export const SIGN_IN_AGENTS = ["copilot", "grok"] as const;
export type SetupState = "none" | "queued" | "running" | "ready" | "failed";
export type JobKind = "login" | "setup" | "run" | "suggest";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface User {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  avatar: string | null;
  /** When GitHub last reported this user's repositories (sign-in). */
  repos_synced?: string | null;
  /** Where gespann sends this user's mail; null until a sign-in brought one or the user confirmed one. */
  email?: string | null;
  /** Who vouched for `email`: `github`, another sign-in's id, or `user` (confirmed by a link in a mail). */
  email_source?: string | null;
  /** An address the user typed and has not confirmed yet. */
  email_pending?: string | null;
}

/** A user's choice for one kind of mail (alerts.ts); missing rows use the kind's default. */
export interface AlertRule {
  category: string;
  on: number;
  after: number;
}

/** How many ended jobs of a project in a row fell into one category, and whether that streak was mailed. */
export interface AlertStreak {
  count: number;
  mailed: number;
}

export interface UserRepo {
  repo_id: number;
  installation_id: number;
  account: string;
  full_name: string;
  private: number | boolean;
  default_branch: string;
}

export interface Project {
  id: number;
  owner_id: number;
  installation_id: number;
  repo: string;
  repo_id: number;
  default_branch: string;
  criteria: string;
  model: string | null;
  /** The project's first sandbox, from before projects had several; `slots` holds them all now. */
  sandbox_id: string | null;
  /** Version of the recipe bundle on the server (DATA_DIR/projects/<id>/recipe.tgz); 0 while there is none. */
  bundle: number;
  codex: CodexState;
  /** JSON {url, code, lines} while a device login waits for the user. */
  codex_login: string | null;
  setup: SetupState;
  setup_error: string | null;
  recipe: string | null;
  notes: string | null;
  /** Checks Codex proposed on request, until the user takes or dismisses them. */
  suggestion: string | null;
  active: number;
  /** Merge gate on: PRs with the gespann label are held as drafts until they pass. */
  gate: number;
  /** Screen sizes the tester checks every PR at, preset ids joined with commas (`phone-s,desktop`); empty: the browser's own size. */
  viewports: string;
  created: string;
}

export interface Job {
  id: number;
  project_id: number;
  kind: JobKind;
  status: JobStatus;
  run_id: number | null;
  created: string;
  started: string | null;
  finished: string | null;
  error: string | null;
  log: string;
  /** How often the job went back into the queue because the server stopped while it ran. */
  restarts: number;
  /** When the server running it last said it still does; a stale beat means that server is gone. */
  heartbeat: string | null;
  /** JSON [[sandboxId, processId], ...]: the background commands it started, stopped when it starts again. */
  procs: string;
  /** Set while a run waits for its PR's other checks: not taken before then. Null: starts as soon as there is room. */
  not_before: string | null;
  /** When the server module heard that the job ended; set once, so a job is never billed twice. */
  ended_noted: string | null;
}

/** One of a project's sandboxes. A job holds one at a time, so parallel jobs never share a checkout. */
export interface Slot {
  id: number;
  project_id: number;
  sandbox_id: string;
  job_id: number | null;
  /** The recipe bundle version this sandbox has; 0 when unknown. */
  bundle: number;
}

export interface Run {
  id: number;
  project_id: number;
  pr: number;
  title: string | null;
  head: string;
  base: string;
  base_ref: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outcome: "PASS" | "FAIL" | "BLOCKED" | "SKIP" | null;
  /** JSON: the judged verdict (verdict, problems). */
  verdict: string | null;
  check_run_id: number | null;
  comment_id: number | null;
  /** Unguessable part of the public proof URLs. */
  token: string;
  files: string;
  created: string;
  started: string | null;
  finished: string | null;
  error: string | null;
  /** JSON: live progress while the run runs (see verify/progress.ts). */
  progress: string | null;
  /** When the screenshots and recording were deleted after the PR closed; null while they are kept. */
  media_cleared: string | null;
  /**
   * JSON list of the files in conflict when the PR head does not merge onto its base. Such a run is
   * not tested: it has no outcome, and the PR's agent brings the branch up to date.
   */
  conflict: string | null;
}

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);
create table if not exists users (
  id integer primary key, github_id integer unique not null, login text not null,
  name text, avatar text, created text not null);
create table if not exists sessions (
  id text primary key, user_id integer not null references users(id), created text not null, expires text not null);
create table if not exists user_repos (
  user_id integer not null, repo_id integer not null, installation_id integer not null, account text not null,
  full_name text not null, private integer not null, default_branch text not null,
  primary key (user_id, repo_id));
create table if not exists projects (
  id integer primary key, owner_id integer not null references users(id), installation_id integer not null,
  repo text not null unique, repo_id integer not null, default_branch text not null,
  criteria text not null default '', model text, sandbox_id text,
  codex text not null default 'none', codex_login text,
  setup text not null default 'none', setup_error text, recipe text, notes text,
  active integer not null default 0, created text not null);
create table if not exists runs (
  id integer primary key, project_id integer not null references projects(id), pr integer not null, title text,
  head text not null, base text not null, base_ref text not null,
  status text not null, outcome text, verdict text, check_run_id integer, comment_id integer,
  token text not null, files text not null default '[]',
  created text not null, started text, finished text, error text, conflict text);
create index if not exists runs_project on runs(project_id, id);
create table if not exists jobs (
  id integer primary key, project_id integer not null references projects(id), kind text not null,
  status text not null, run_id integer references runs(id),
  created text not null, started text, finished text, error text, log text not null default '');
create index if not exists jobs_status on jobs(status, id);
create table if not exists holds (
  project_id integer not null references projects(id), pr integer not null,
  held integer not null default 0, approved_by text, approved_head text, comment_id integer, updated text not null,
  primary key (project_id, pr));
create table if not exists pulls (
  project_id integer not null references projects(id), pr integer not null,
  closed text not null, merged integer not null default 0,
  primary key (project_id, pr));
create table if not exists slots (
  id integer primary key, project_id integer not null references projects(id), sandbox_id text not null,
  job_id integer, bundle integer not null default 0);
create table if not exists api_tokens (
  id integer primary key, user_id integer not null references users(id), name text not null,
  hash text not null unique, hint text not null, created text not null, last_used text);
create table if not exists alert_rules (
  user_id integer not null references users(id), category text not null, "on" integer not null, after integer not null,
  primary key (user_id, category));
create table if not exists alert_streaks (
  project_id integer not null references projects(id), category text not null,
  count integer not null default 0, mailed integer not null default 0, primary key (project_id, category));
create table if not exists identities (
  provider text not null, subject text not null, user_id integer not null references users(id),
  email text, created text not null, primary key (provider, subject));
`;

/**
 * Access to the MCP endpoint: a personal token, or an agent's OAuth sign-in (`client` set),
 * whose access token expires and is renewed with a refresh token. Only hashes are stored.
 */
export interface ApiToken {
  id: number;
  name: string;
  /** The last characters, so the user can tell tokens apart. */
  hint: string;
  created: string;
  last_used: string | null;
  /** The OAuth client id, or null for a personal token. */
  client: string | null;
}

/** An OAuth access token lives this long; the agent renews it with its refresh token. */
export const ACCESS_SECONDS = 3600;
/** A refresh token stays valid this long after the last renewal. */
const REFRESH_DAYS = 30;

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
/**
 * `gsr_<sign-in id>_<sign-in secret>_<random>`: the secret stays the same across renewals, so a spent
 * token is told apart from a made-up one.
 */
const refreshToken = (id: number, family: string) => `gsr_${id}_${family}_${randomBytes(24).toString("hex")}`;

/** The merge gate's memory per PR: whether gespann made it a draft, and who released which head. */
export interface Hold {
  project_id: number;
  pr: number;
  held: number;
  approved_by: string | null;
  approved_head: string | null;
  /** gespann's one comment on this PR. */
  comment_id: number | null;
}

export const now = () => new Date().toISOString();

/** A job of the user's projects that holds a sandbox right now. */
export interface RunningBox {
  job_id: number;
  kind: JobKind;
  project_id: number;
  repo: string;
  pr: number | null;
  sandbox_id: string | null;
  started: string;
}

/** Sandbox time of a user's projects: seconds per UTC day of the month, the month, and all time. */
export interface BoxTime {
  month: string;
  days: { day: string; seconds: number }[];
  monthSeconds: number;
  totalSeconds: number;
  jobs: number;
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.sql.exec(SCHEMA);
    // Columns added after the first deploy.
    const cols = new Set((this.sql.prepare("pragma table_info(users)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, def] of [
      ["codex_state", "text not null default 'none'"],
      ["codex_login", "text"],
      ["codex_auth", "text"],
      ["codex_account", "text"],
      ["codex_model", "text"],
      ["repos_synced", "text"],
      ["max_jobs", "integer"],
      ["job_cap", "integer"],
      ["agent", "text not null default 'codex'"],
      ["openrouter_key", "text"],
      ["openrouter_label", "text"],
      ["openrouter_model", "text"],
      ["openrouter_context", "integer"],
      ...KEY_AGENTS.flatMap((a) => [[`${a}_key`, "text"], [`${a}_label`, "text"], [`${a}_model`, "text"]] as const),
      ...SIGN_IN_AGENTS.flatMap((a) => [[`${a}_login_state`, "text"], [`${a}_login`, "text"]] as const),
      ["grok_auth", "text"],
      ["email", "text"],
      ["email_source", "text"],
      ["email_pending", "text"],
      ["github_token", "text"],
    ] as const) {
      if (cols.has(name)) continue;
      try {
        this.sql.exec(`alter table users add column ${name} ${def}`);
      } catch (err) {
        // The orchestrator adds the same columns and may have done so since `table_info` was read.
        if (!String((err as Error).message).includes("duplicate column")) throw err;
      }
    }
    const pcols = new Set((this.sql.prepare("pragma table_info(projects)").all() as { name: string }[]).map((c) => c.name));
    if (!pcols.has("suggestion")) this.sql.exec("alter table projects add column suggestion text");
    if (!pcols.has("bundle")) this.sql.exec("alter table projects add column bundle integer not null default 0");
    if (!pcols.has("viewports")) this.sql.exec("alter table projects add column viewports text not null default ''");
    if (!pcols.has("gate")) {
      // New projects start with the gate off; projects from before the setting keep the gate they had.
      this.sql.exec("alter table projects add column gate integer not null default 0");
      this.sql.exec("update projects set gate = 1");
    }
    const tcols = new Set((this.sql.prepare("pragma table_info(api_tokens)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, def] of [
      ["client", "text"],
      ["refresh_hash", "text"],
      ["expires", "text"],
      ["family", "text"],
    ] as const) {
      if (!tcols.has(name)) this.sql.exec(`alter table api_tokens add column ${name} ${def}`);
    }
    this.sql.exec("create unique index if not exists api_tokens_refresh on api_tokens(refresh_hash)");
    const rcols = new Set((this.sql.prepare("pragma table_info(runs)").all() as { name: string }[]).map((c) => c.name));
    if (!rcols.has("progress")) this.sql.exec("alter table runs add column progress text");
    if (!rcols.has("media_cleared")) this.sql.exec("alter table runs add column media_cleared text");
    if (!rcols.has("conflict")) this.sql.exec("alter table runs add column conflict text");
    const hcols = new Set((this.sql.prepare("pragma table_info(holds)").all() as { name: string }[]).map((c) => c.name));
    if (!hcols.has("comment_id")) this.sql.exec("alter table holds add column comment_id integer");
    const jcols = new Set((this.sql.prepare("pragma table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, def] of [
      ["restarts", "integer not null default 0"],
      ["heartbeat", "text"],
      ["procs", "text not null default '[]'"],
      ["not_before", "text"],
      ["ended_noted", "text"],
    ] as const) {
      if (!jcols.has(name)) this.sql.exec(`alter table jobs add column ${name} ${def}`);
    }
  }

  codex(userId: number): { codex_state: CodexState; codex_login: string | null; codex_account: string | null; codex_model: string | null } | undefined {
    return this.one("select codex_state, codex_login, codex_account, codex_model from users where id = ?", userId);
  }

  setCodex(userId: number, fields: Partial<{ codex_state: CodexState; codex_login: string | null; codex_auth: string | null; codex_account: string | null; codex_model: string | null }>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.run(`update users set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...keys.map((k) => (fields as Record<string, string | null>)[k] ?? null), userId);
  }

  /** The user's agent provider and their connections, without the keys. */
  agent(userId: number): ({ agent: AgentProvider; openrouter: boolean; openrouter_label: string | null; openrouter_model: string | null; openrouter_context: number | null; ready: boolean } & Record<KeyAgent, KeyAgentState>) | undefined {
    const keyCols = [
      ...KEY_AGENTS.map((a) => `${a}_key is not null as ${a}_has, ${a}_label, ${a}_model`),
      ...SIGN_IN_AGENTS.map((a) => `${a}_login_state, ${a}_login`),
      "grok_auth is not null as grok_signed_in",
    ].join(", ");
    const r = this.one<Record<string, string | number | null>>(
      `select agent, openrouter_key is not null as has_key, openrouter_label, openrouter_model, openrouter_context, ${keyCols}, ${AGENT_READY} as ready from users where id = ?`,
      userId,
    );
    if (!r) return undefined;
    const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    const login = (a: KeyAgent): KeyAgentState["login"] => {
      const state = s(`${a}_login_state`);
      if (!state) return null;
      let progress = { url: null, code: null, lines: "" };
      try {
        progress = { ...progress, ...JSON.parse(s(`${a}_login`) ?? "{}") };
      } catch {
        // A half-written progress: the state alone.
      }
      return { state, ...progress };
    };
    const keyed = Object.fromEntries(
      KEY_AGENTS.map((a) => [a, { connected: !!r[`${a}_has`] || (a === "grok" && !!r.grok_signed_in), label: s(`${a}_label`), model: s(`${a}_model`), login: login(a) }]),
    ) as Record<KeyAgent, KeyAgentState>;
    const agent = AGENT_PROVIDERS.find((p) => p === r.agent) ?? "codex";
    return { agent, openrouter: !!r.has_key, openrouter_label: s("openrouter_label"), openrouter_model: s("openrouter_model"), openrouter_context: typeof r.openrouter_context === "number" ? r.openrouter_context : null, ready: !!r.ready, ...keyed };
  }

  setAgent(userId: number, fields: Partial<{ agent: AgentProvider; openrouter_key: string | null; openrouter_label: string | null; openrouter_model: string | null; openrouter_context: number | null }>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.run(`update users set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), userId);
  }

  /** Sets a key agent's sealed key, its label or its model. */
  setKeyAgent(userId: number, agent: KeyAgent, fields: Partial<{ key: string | null; label: string | null; model: string | null; login_state: string | null; login: string | null; auth: string | null }>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.run(`update users set ${keys.map((k) => `${agent}_${k} = ?`).join(", ")} where id = ?`, ...keys.map((k) => fields[k] ?? null), userId);
  }

  /** The agent of the user's projects can run: Codex connected, or an OpenRouter key and model. */
  agentReady(userId: number): boolean {
    return this.agent(userId)?.ready ?? false;
  }

  private one<T>(q: string, ...p: (string | number | null)[]): T | undefined {
    return this.sql.prepare(q).get(...p) as T | undefined;
  }

  private all<T>(q: string, ...p: (string | number | null)[]): T[] {
    return this.sql.prepare(q).all(...p) as T[];
  }

  private run(q: string, ...p: (string | number | null)[]): number {
    return Number(this.sql.prepare(q).run(...p).lastInsertRowid);
  }

  setting(key: string): string | undefined {
    return this.one<{ value: string }>("select value from settings where key = ?", key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.run("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }

  upsertUser(u: Omit<User, "id">): User {
    this.run(
      "insert into users (github_id, login, name, avatar, created) values (?, ?, ?, ?, ?) on conflict(github_id) do update set login = excluded.login, name = excluded.name, avatar = excluded.avatar",
      u.github_id,
      u.login,
      u.name,
      u.avatar,
      now(),
    );
    return this.one<User>("select * from users where github_id = ?", u.github_id) as User;
  }

  /**
   * An address a sign-in vouches for (GitHub's verified primary address, or another sign-in's). It
   * fills an empty address and follows changes at the same source, but never replaces one the user
   * chose themselves or another source gave.
   */
  offerEmail(userId: number, email: string, source: string): void {
    this.run("update users set email = ?, email_source = ? where id = ? and (email is null or email_source = ?)", email, source, userId, source);
  }

  /** An address the user typed; it counts once they open the link mailed to it (`confirmEmail`). */
  setPendingEmail(userId: number, email: string | null): void {
    this.run("update users set email_pending = ? where id = ?", email, userId);
  }

  /** The link in the confirmation mail was opened: false when the user has since typed another address. */
  confirmEmail(userId: number, email: string): boolean {
    return Number(this.sql.prepare("update users set email = ?, email_source = 'user', email_pending = null where id = ? and email_pending = ?").run(email, userId, email).changes) > 0;
  }

  alertRules(userId: number): AlertRule[] {
    return this.all<AlertRule>('select category, "on", after from alert_rules where user_id = ?', userId);
  }

  setAlertRule(userId: number, r: AlertRule): void {
    this.run('insert into alert_rules (user_id, category, "on", after) values (?, ?, ?, ?) on conflict(user_id, category) do update set "on" = excluded."on", after = excluded.after', userId, r.category, r.on, r.after);
  }

  /** One more job of the project in this category; the streak as it is now. */
  bumpStreak(projectId: number, category: string): AlertStreak {
    this.run("insert into alert_streaks (project_id, category, count) values (?, ?, 1) on conflict(project_id, category) do update set count = count + 1", projectId, category);
    return this.one<AlertStreak>("select count, mailed from alert_streaks where project_id = ? and category = ?", projectId, category) as AlertStreak;
  }

  /** A job of the project ended outside these categories: their streaks start over. */
  endStreaks(projectId: number, categories: string[]): void {
    for (const c of categories) this.run("delete from alert_streaks where project_id = ? and category = ?", projectId, c);
  }

  /** Marks the streak mailed; false when another call already did. */
  markStreakMailed(projectId: number, category: string): boolean {
    return Number(this.sql.prepare("update alert_streaks set mailed = 1 where project_id = ? and category = ? and mailed = 0").run(projectId, category).changes) > 0;
  }

  createSession(id: string, userId: number, days = 7): void {
    this.run("insert into sessions (id, user_id, created, expires) values (?, ?, ?, ?)", id, userId, now(), new Date(Date.now() + days * 86_400_000).toISOString());
  }

  user(id: number): User | undefined {
    return this.one<User>("select * from users where id = ?", id);
  }

  sessionUser(id: string): User | undefined {
    return this.one<User>("select u.* from sessions s join users u on u.id = s.user_id where s.id = ? and s.expires > ?", id, now());
  }

  deleteSession(id: string): void {
    this.run("delete from sessions where id = ?", id);
  }

  /** The user a module's sign-in (provider, subject) is linked to. */
  identityUser(provider: string, subject: string): User | undefined {
    return this.one<User>("select u.* from identities i join users u on u.id = i.user_id where i.provider = ? and i.subject = ?", provider, subject);
  }

  /** Links a module's sign-in to a user; a later link of the same sign-in replaces it. */
  linkIdentity(provider: string, subject: string, userId: number, email: string | null): void {
    this.run(
      "insert into identities (provider, subject, user_id, email, created) values (?, ?, ?, ?, ?) on conflict(provider, subject) do update set user_id = excluded.user_id, email = excluded.email",
      provider,
      subject,
      userId,
      email,
      now(),
    );
  }

  /** The user's GitHub token, sealed; kept only on instances with other sign-ins, to re-read repositories. */
  githubToken(userId: number): string | null {
    return this.one<{ github_token: string | null }>("select github_token from users where id = ?", userId)?.github_token ?? null;
  }

  setGithubToken(userId: number, sealed: string | null): void {
    this.run("update users set github_token = ? where id = ?", sealed, userId);
  }

  /** Replaces the GitHub token only if it is still `from`; false when another sign-in changed it. */
  swapGithubToken(userId: number, from: string, to: string | null): boolean {
    return Number(this.sql.prepare("update users set github_token = ? where id = ? and github_token = ?").run(to, userId, from).changes) > 0;
  }

  /** The repositories this user can access through the app, as GitHub reported at sign-in. */
  setRepos(userId: number, list: UserRepo[]): void {
    this.run("delete from user_repos where user_id = ?", userId);
    this.run("update users set repos_synced = ? where id = ?", now(), userId);
    for (const r of list) {
      this.run(
        "insert or replace into user_repos (user_id, repo_id, installation_id, account, full_name, private, default_branch) values (?, ?, ?, ?, ?, ?, ?)",
        userId,
        r.repo_id,
        r.installation_id,
        r.account,
        r.full_name,
        r.private ? 1 : 0,
        r.default_branch,
      );
    }
  }

  repos(userId: number): UserRepo[] {
    return this.all<UserRepo>("select repo_id, installation_id, account, full_name, private, default_branch from user_repos where user_id = ? order by account, full_name", userId);
  }

  /** Projects the user can see: those whose repository the user has access to. */
  projects(userId: number): Project[] {
    return this.all<Project>("select p.* from projects p join user_repos r on r.repo_id = p.repo_id and r.user_id = ? order by p.repo", userId);
  }

  allProjects(): Project[] {
    return this.all<Project>("select * from projects order by id");
  }

  project(id: number): Project | undefined {
    return this.one<Project>("select * from projects where id = ?", id);
  }

  projectByRepoId(repoId: number): Project | undefined {
    return this.one<Project>("select * from projects where repo_id = ?", repoId);
  }

  canSee(userId: number, p: Project): boolean {
    return !!this.one("select 1 from user_repos where user_id = ? and repo_id = ?", userId, p.repo_id);
  }

  createProject(p: { owner_id: number; installation_id: number; repo: string; repo_id: number; default_branch: string }): number {
    return this.run(
      "insert into projects (owner_id, installation_id, repo, repo_id, default_branch, created) values (?, ?, ?, ?, ?, ?)",
      p.owner_id,
      p.installation_id,
      p.repo,
      p.repo_id,
      p.default_branch,
      now(),
    );
  }

  updateProject(id: number, fields: Partial<Omit<Project, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const values = keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null);
    this.run(`update projects set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...values, id);
  }

  /** Queues the one-time setup for projects that never had one: it needs nothing from the user but a ready agent. */
  autoSetup(ownerId: number): void {
    if (!this.agentReady(ownerId)) return;
    for (const p of this.all<Project>("select * from projects where owner_id = ? and setup = 'none'", ownerId)) {
      this.updateProject(p.id, { setup: "queued", setup_error: null });
      this.enqueue(p.id, "setup");
    }
  }

  enqueue(projectId: number, kind: JobKind, runId: number | null = null): number {
    return this.run("insert into jobs (project_id, kind, status, run_id, created) values (?, ?, 'queued', ?, ?)", projectId, kind, runId, now());
  }

  /** How many jobs of the user's projects may run at once; null leaves it to the sandbox host. */
  maxJobs(userId: number): number | null {
    return this.one<{ max_jobs: number | null }>("select max_jobs from users where id = ?", userId)?.max_jobs ?? null;
  }

  setMaxJobs(userId: number, max: number | null): void {
    this.run("update users set max_jobs = ? where id = ?", max, userId);
  }

  /** Writes the server module's cap per user (`users.job_cap`), which the orchestrator reads when it picks the next job. */
  publishJobCaps(cap: (owner: { id: number; login: string }) => number | null): void {
    for (const u of this.all<{ id: number; login: string; job_cap: number | null }>("select id, login, job_cap from users")) {
      const c = cap(u);
      if (c !== u.job_cap) this.run("update users set job_cap = ? where id = ?", c, u.id);
    }
  }

  /** The user's jobs that hold a sandbox now, oldest first. */
  runningBoxes(userId: number): RunningBox[] {
    return this.all<RunningBox>(
      `select j.id as job_id, j.kind, j.project_id, p.repo, r.pr, (select s.sandbox_id from slots s where s.job_id = j.id order by s.id limit 1) as sandbox_id, j.started
         from jobs j join projects p on p.id = j.project_id left join runs r on r.id = j.run_id
        where p.owner_id = ? and j.status = 'running' and j.started is not null order by j.started, j.id`,
      userId,
    );
  }

  /** Jobs of the user's projects that wait for a free sandbox, and runs that wait for their PR's other checks first. */
  queuedJobs(userId: number): { sandbox: number; checks: number } {
    const r = this.one<{ sandbox: number | null; checks: number | null }>(
      "select sum(j.not_before is null) as sandbox, sum(j.not_before is not null) as checks from jobs j join projects p on p.id = j.project_id where p.owner_id = ? and j.status = 'queued'",
      userId,
    );
    return { sandbox: r?.sandbox ?? 0, checks: r?.checks ?? 0 };
  }

  /**
   * How long the user's projects held sandboxes: from a job's start to its end, a running job up to
   * `at`. A job counts on the UTC day and month it started. The basis for billing by sandbox time.
   */
  boxTime(userId: number, at = new Date()): BoxTime {
    const month = at.toISOString().slice(0, 7);
    const end = at.toISOString();
    const secs = `max(0, (julianday(min(coalesce(j.finished, ?), ?)) - julianday(j.started)) * 86400)`;
    const rows = this.all<{ day: string; seconds: number; jobs: number }>(
      `select substr(j.started, 1, 10) as day, sum(${secs}) as seconds, count(*) as jobs
         from jobs j join projects p on p.id = j.project_id
        where p.owner_id = ? and j.started is not null and substr(j.started, 1, 7) = ? group by day order by day`,
      end,
      end,
      userId,
      month,
    );
    const total = this.one<{ seconds: number | null }>(`select sum(${secs}) as seconds from jobs j join projects p on p.id = j.project_id where p.owner_id = ? and j.started is not null`, end, end, userId);
    const [y, m] = month.split("-").map(Number) as [number, number];
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const byDay = new Map(rows.map((r) => [r.day, r.seconds]));
    const days = Array.from({ length }, (_, i) => {
      const day = `${month}-${String(i + 1).padStart(2, "0")}`;
      return { day, seconds: Math.round(byDay.get(day) ?? 0) };
    });
    return { month, days, monthSeconds: days.reduce((a, d) => a + d.seconds, 0), totalSeconds: Math.round(total?.seconds ?? 0), jobs: rows.reduce((a, r) => a + r.jobs, 0) };
  }

  slots(projectId: number): Slot[] {
    return this.all<Slot>("select * from slots where project_id = ? order by id", projectId);
  }

  job(id: number): Job | undefined {
    return this.one<Job>("select * from jobs where id = ?", id);
  }

  jobs(projectId: number, limit = 20): Job[] {
    return this.all<Job>("select * from jobs where project_id = ? order by id desc limit ?", projectId, limit);
  }


  /** Runs of the project that wait in the queue for their PR's other checks (CI), not for a sandbox. */
  runsWaitingForChecks(projectId: number): Set<number> {
    return new Set(this.all<{ run_id: number }>("select run_id from jobs where project_id = ? and status = 'queued' and run_id is not null and not_before is not null", projectId).map((j) => j.run_id));
  }

  /** Puts a running job that has not touched a sandbox back into the queue until `until`; the wait is no sandbox time. */
  deferJob(id: number, until: string): void {
    this.run("update jobs set status = 'queued', started = null, heartbeat = null, not_before = ? where id = ? and status = 'running'", until, id);
  }

  /** Marks the job's end as told to the server module; false when it already was. */
  noteEnded(id: number): boolean {
    return Number(this.sql.prepare("update jobs set ended_noted = ? where id = ? and ended_noted is null").run(now(), id).changes) > 0;
  }

  appendLog(id: number, line: string): void {
    this.run("update jobs set log = substr(log || ?, -200000) where id = ?", `${now().slice(11, 19)} ${line}\n`, id);
  }

  createRun(r: { project_id: number; pr: number; title: string | null; head: string; base: string; base_ref: string; token: string }): number {
    return this.run(
      "insert into runs (project_id, pr, title, head, base, base_ref, status, token, created) values (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
      r.project_id,
      r.pr,
      r.title,
      r.head,
      r.base,
      r.base_ref,
      r.token,
      now(),
    );
  }

  /** Cancels the PR's queued runs: a newer push supersedes them, or the PR was merged or closed. */
  cancelQueuedRuns(projectId: number, pr: number, reason = "superseded by a newer push", only?: number): Run[] {
    const runs = this.all<Run>("select * from runs where project_id = ? and pr = ? and status = 'queued'", projectId, pr).filter((r) => only === undefined || r.id === only);
    for (const r of runs) {
      this.run("update runs set status = 'cancelled', finished = ?, error = ? where id = ?", now(), reason, r.id);
      this.run("update jobs set status = 'cancelled', finished = ? where run_id = ? and status = 'queued'", now(), r.id);
    }
    return runs;
  }

  /**
   * A newer push supersedes the PR's queued and running runs: one test per PR at a time, the newest.
   * A running run's job keeps its sandbox until the worker sees the cancel and has torn the copy down.
   */
  supersedeRuns(projectId: number, pr: number): Run[] {
    const reason = "superseded by a newer push";
    const running = this.all<Run>("select * from runs where project_id = ? and pr = ? and status = 'running'", projectId, pr);
    for (const r of running) this.run("update runs set status = 'cancelled', finished = ?, error = ? where id = ?", now(), reason, r.id);
    return [...this.cancelQueuedRuns(projectId, pr, reason), ...running];
  }

  run_(id: number): Run | undefined {
    return this.one<Run>("select * from runs where id = ?", id);
  }

  /** How often this PR head was tested or queued, superseded runs not counted. */
  runsAtHead(projectId: number, pr: number, head: string): number {
    return this.one<{ n: number }>("select count(*) n from runs where project_id = ? and pr = ? and head = ? and status != 'cancelled'", projectId, pr, head)?.n ?? 0;
  }

  /** The newest run of this PR head that was not superseded. */
  runForHead(projectId: number, pr: number, head: string): Run | undefined {
    return this.one<Run>("select * from runs where project_id = ? and pr = ? and head = ? and status != 'cancelled' order by id desc limit 1", projectId, pr, head);
  }

  /** The queued or running run of this PR head, if one is. */
  liveRunForHead(projectId: number, pr: number, head: string): Run | undefined {
    return this.one<Run>("select * from runs where project_id = ? and pr = ? and head = ? and status in ('queued', 'running') order by id desc limit 1", projectId, pr, head);
  }

  /** gespann keeps one comment per PR and edits it with each new result. */
  prComment(projectId: number, pr: number): number | null {
    return (
      this.hold(projectId, pr)?.comment_id ??
      this.one<{ comment_id: number }>("select comment_id from runs where project_id = ? and pr = ? and comment_id is not null order by id desc limit 1", projectId, pr)?.comment_id ??
      null
    );
  }

  /** The newest run whose result is in this comment (one comment per PR, edited by each run). */
  runWithComment(projectId: number, pr: number, commentId: number): Run | undefined {
    return this.one<Run>("select * from runs where project_id = ? and pr = ? and comment_id = ? order by id desc limit 1", projectId, pr, commentId);
  }

  /** PRs gespann holds as drafts right now. */
  heldPrs(projectId: number): number[] {
    return this.all<{ pr: number }>("select pr from holds where project_id = ? and held = 1", projectId).map((h) => h.pr);
  }

  hold(projectId: number, pr: number): Hold | undefined {
    return this.one<Hold>("select * from holds where project_id = ? and pr = ?", projectId, pr);
  }

  setHold(projectId: number, pr: number, fields: Partial<Pick<Hold, "held" | "approved_by" | "approved_head" | "comment_id">>): void {
    const h = this.hold(projectId, pr) ?? { held: 0, approved_by: null, approved_head: null, comment_id: null };
    const next = { ...h, ...fields };
    this.run(
      "insert into holds (project_id, pr, held, approved_by, approved_head, comment_id, updated) values (?, ?, ?, ?, ?, ?, ?) on conflict (project_id, pr) do update set held = excluded.held, approved_by = excluded.approved_by, approved_head = excluded.approved_head, comment_id = excluded.comment_id, updated = excluded.updated",
      projectId,
      pr,
      next.held,
      next.approved_by,
      next.approved_head,
      next.comment_id,
      now(),
    );
  }

  /** Creates a token and returns it; it cannot be read again. */
  createToken(userId: number, name: string): { id: number; token: string } {
    const token = `gsp_${randomBytes(24).toString("hex")}`;
    const id = this.run("insert into api_tokens (user_id, name, hash, hint, created) values (?, ?, ?, ?, ?)", userId, name, tokenHash(token), token.slice(-4), now());
    return { id, token };
  }

  tokens(userId: number): ApiToken[] {
    return this.all<ApiToken>("select id, name, hint, created, last_used, client from api_tokens where user_id = ? order by id desc", userId);
  }

  /** How many personal tokens a user has (OAuth sign-ins do not count). */
  personalTokens(userId: number): number {
    return this.one<{ n: number }>("select count(*) as n from api_tokens where user_id = ? and client is null", userId)?.n ?? 0;
  }

  /** Starts an agent's OAuth sign-in: an access token and a refresh token, returned once. */
  createOAuthToken(userId: number, client: string, name: string): { access: string; refresh: string } {
    // Sign-ins nobody renewed for a month cannot be renewed any more: drop them.
    this.run("delete from api_tokens where user_id = ? and client is not null and expires < ?", userId, new Date(Date.now() - REFRESH_DAYS * 86_400_000).toISOString());
    const access = `gsp_${randomBytes(24).toString("hex")}`;
    const id = this.run(
      "insert into api_tokens (user_id, name, hash, hint, created, client, expires) values (?, ?, ?, ?, ?, ?, ?)",
      userId,
      name,
      tokenHash(access),
      access.slice(-4),
      now(),
      client,
      new Date(Date.now() + ACCESS_SECONDS * 1000).toISOString(),
    );
    const family = randomBytes(16).toString("hex");
    const refresh = refreshToken(id, family);
    this.run("update api_tokens set refresh_hash = ?, family = ? where id = ?", tokenHash(refresh), tokenHash(family), id);
    return { access, refresh };
  }

  /**
   * Renews an OAuth sign-in: both tokens are replaced, the old refresh token stops working. When
   * `allowed` rejects the user, nothing changes and the result says so. A refresh token that was
   * already used ends the sign-in: either the agent or a thief holds a copy (RFC 9700 4.14.2).
   */
  refreshOAuthToken(refresh: string, client: string, allowed: (u: User) => boolean): { access: string; refresh: string } | "unknown" | "denied" {
    // A refresh token names its sign-in, so an old one is recognised however many renewals ago it was spent.
    const [, id, family] = /^gsr_(\d+)_([0-9a-f]{32})_[0-9a-f]{48}$/.exec(refresh) ?? [];
    const row = id ? this.one<{ id: number; user_id: number; expires: string; refresh_hash: string; family: string }>("select id, user_id, expires, refresh_hash, family from api_tokens where id = ? and client = ?", Number(id), client) : undefined;
    if (!row || row.family !== tokenHash(family!)) return "unknown";
    if (row.refresh_hash !== tokenHash(refresh)) {
      this.run("delete from api_tokens where id = ?", row.id);
      return "unknown";
    }
    if (Date.parse(row.expires) < Date.now() - REFRESH_DAYS * 86_400_000) {
      this.run("delete from api_tokens where id = ?", row.id);
      return "unknown";
    }
    if (!allowed(this.one<User>("select * from users where id = ?", row.user_id) as User)) return "denied";
    const access = `gsp_${randomBytes(24).toString("hex")}`;
    const next = refreshToken(row.id, family!);
    this.run(
      "update api_tokens set hash = ?, hint = ?, refresh_hash = ?, expires = ? where id = ?",
      tokenHash(access),
      access.slice(-4),
      tokenHash(next),
      new Date(Date.now() + ACCESS_SECONDS * 1000).toISOString(),
      row.id,
    );
    return { access, refresh: next };
  }

  deleteToken(userId: number, id: number): void {
    this.run("delete from api_tokens where user_id = ? and id = ?", userId, id);
  }

  /** The user a token belongs to; notes when it was used. */
  tokenUser(raw: string): User | undefined {
    if (!raw.startsWith("gsp_")) return undefined;
    const hash = tokenHash(raw);
    const user = this.one<User>("select u.* from api_tokens t join users u on u.id = t.user_id where t.hash = ? and (t.expires is null or t.expires > ?)", hash, now());
    if (user) this.run("update api_tokens set last_used = ? where hash = ?", now(), hash);
    return user;
  }

  /** Marks the PR merged or closed (at `closed`), or open again with null. */
  setPrClosed(projectId: number, pr: number, closed: { at: string; merged: boolean } | null): void {
    if (!closed) this.run("delete from pulls where project_id = ? and pr = ?", projectId, pr);
    else
      this.run(
        "insert into pulls (project_id, pr, closed, merged) values (?, ?, ?, ?) on conflict (project_id, pr) do update set closed = excluded.closed, merged = excluded.merged",
        projectId,
        pr,
        closed.at,
        closed.merged ? 1 : 0,
      );
  }

  /** The project's PRs that are merged or closed, as far as gespann heard. */
  closedPrs(projectId: number): { pr: number; merged: boolean }[] {
    return this.all<{ pr: number; merged: number }>("select pr, merged from pulls where project_id = ?", projectId).map((r) => ({ pr: r.pr, merged: r.merged === 1 }));
  }

  /** PRs with runs that gespann still counts as open, with their project's repo. */
  openPrsWithRuns(): { project_id: number; pr: number; repo: string; installation_id: number }[] {
    return this.all(
      "select distinct r.project_id, r.pr, p.repo, p.installation_id from runs r join projects p on p.id = r.project_id where not exists (select 1 from pulls u where u.project_id = r.project_id and u.pr = r.pr) order by r.project_id, r.pr",
    );
  }

  /** The newest runs of one PR, superseded ones included. */
  runsOfPr(projectId: number, pr: number, limit = 20): Run[] {
    return this.all<Run>("select * from runs where project_id = ? and pr = ? order by id desc limit ?", projectId, pr, limit);
  }

  jobOfRun(runId: number): Job | undefined {
    return this.one<Job>("select * from jobs where run_id = ? order by id desc limit 1", runId);
  }

  runByToken(token: string): Run | undefined {
    return this.one<Run>("select * from runs where token = ?", token);
  }

  /** Finished runs whose screenshots or recording are still kept, with their project's repo. */
  runsWithMedia(): (Run & { repo: string; installation_id: number })[] {
    return this.all<Run & { repo: string; installation_id: number }>(
      "select r.*, p.repo, p.installation_id from runs r join projects p on p.id = r.project_id where r.media_cleared is null and r.status in ('done', 'failed', 'cancelled') and r.files != '[]' order by r.id",
    );
  }

  runs(projectId: number, limit = 50): Run[] {
    return this.all<Run>("select * from runs where project_id = ? order by id desc limit ?", projectId, limit);
  }

  updateRun(id: number, fields: Partial<Omit<Run, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const values = keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null);
    this.run(`update runs set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...values, id);
  }
}
