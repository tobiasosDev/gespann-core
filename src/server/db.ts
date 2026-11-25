import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CodexState = "none" | "pending" | "connected" | "failed";
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
  sandbox_id: string | null;
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
  created text not null, started text, finished text, error text);
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
create table if not exists api_tokens (
  id integer primary key, user_id integer not null references users(id), name text not null,
  hash text not null unique, hint text not null, created text not null, last_used text);
`;

/** A personal token for the read-only MCP endpoint. Only its hash is stored. */
export interface ApiToken {
  id: number;
  name: string;
  /** The last characters, so the user can tell tokens apart. */
  hint: string;
  created: string;
  last_used: string | null;
}

const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

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
      ["repos_synced", "text"],
    ] as const) {
      if (!cols.has(name)) this.sql.exec(`alter table users add column ${name} ${def}`);
    }
    const pcols = new Set((this.sql.prepare("pragma table_info(projects)").all() as { name: string }[]).map((c) => c.name));
    if (!pcols.has("suggestion")) this.sql.exec("alter table projects add column suggestion text");
    if (!pcols.has("gate")) {
      // New projects start with the gate off; projects from before the setting keep the gate they had.
      this.sql.exec("alter table projects add column gate integer not null default 0");
      this.sql.exec("update projects set gate = 1");
    }
    const hcols = new Set((this.sql.prepare("pragma table_info(holds)").all() as { name: string }[]).map((c) => c.name));
    if (!hcols.has("comment_id")) this.sql.exec("alter table holds add column comment_id integer");
    const jcols = new Set((this.sql.prepare("pragma table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, def] of [
      ["restarts", "integer not null default 0"],
      ["heartbeat", "text"],
      ["procs", "text not null default '[]'"],
    ] as const) {
      if (!jcols.has(name)) this.sql.exec(`alter table jobs add column ${name} ${def}`);
    }
  }

  codex(userId: number): { codex_state: CodexState; codex_login: string | null; codex_account: string | null } | undefined {
    return this.one("select codex_state, codex_login, codex_account from users where id = ?", userId);
  }

  codexAuth(userId: number): string | null {
    return this.one<{ codex_auth: string | null }>("select codex_auth from users where id = ?", userId)?.codex_auth ?? null;
  }

  setCodex(userId: number, fields: Partial<{ codex_state: CodexState; codex_login: string | null; codex_auth: string | null; codex_account: string | null }>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.run(`update users set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, ...keys.map((k) => (fields as Record<string, string | null>)[k] ?? null), userId);
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

  createSession(id: string, userId: number, days = 7): void {
    this.run("insert into sessions (id, user_id, created, expires) values (?, ?, ?, ?)", id, userId, now(), new Date(Date.now() + days * 86_400_000).toISOString());
  }

  sessionUser(id: string): User | undefined {
    return this.one<User>("select u.* from sessions s join users u on u.id = s.user_id where s.id = ? and s.expires > ?", id, now());
  }

  deleteSession(id: string): void {
    this.run("delete from sessions where id = ?", id);
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

  /** Queues the one-time setup for projects that never had one: it needs nothing from the user but Codex. */
  autoSetup(ownerId: number): void {
    if (this.codex(ownerId)?.codex_state !== "connected") return;
    for (const p of this.all<Project>("select * from projects where owner_id = ? and setup = 'none'", ownerId)) {
      this.updateProject(p.id, { setup: "queued", setup_error: null });
      this.enqueue(p.id, "setup");
    }
  }

  enqueue(projectId: number, kind: JobKind, runId: number | null = null): number {
    return this.run("insert into jobs (project_id, kind, status, run_id, created) values (?, ?, 'queued', ?, ?)", projectId, kind, runId, now());
  }

  /** The oldest queued job whose project and owner have no running job: one sandbox and one Codex sign-in, one job at a time. */
  nextJob(): Job | undefined {
    return this.one<Job>(
      `select j.* from jobs j join projects p on p.id = j.project_id where j.status = 'queued' and not exists (
         select 1 from jobs r join projects rp on rp.id = r.project_id where r.status = 'running' and (r.project_id = j.project_id or rp.owner_id = p.owner_id)
       ) order by j.id limit 1`,
    );
  }

  job(id: number): Job | undefined {
    return this.one<Job>("select * from jobs where id = ?", id);
  }

  jobs(projectId: number, limit = 20): Job[] {
    return this.all<Job>("select * from jobs where project_id = ? order by id desc limit ?", projectId, limit);
  }

  pendingJobs(projectId: number): number {
    return this.one<{ n: number }>("select count(*) n from jobs where project_id = ? and status in ('queued', 'running')", projectId)?.n ?? 0;
  }

  startJob(id: number): void {
    this.run("update jobs set status = 'running', started = coalesce(started, ?), heartbeat = ? where id = ?", now(), now(), id);
  }

  /** Takes a queued job; false when another server (the old one, during a rolling deploy) took it first. */
  claimJob(id: number): boolean {
    return Number(this.sql.prepare("update jobs set status = 'running', started = coalesce(started, ?), heartbeat = ? where id = ? and status = 'queued'").run(now(), now(), id).changes) === 1;
  }

  /** The worker still runs these jobs. */
  beat(ids: number[]): void {
    for (const id of ids) this.run("update jobs set heartbeat = ? where id = ? and status = 'running'", now(), id);
  }

  addProc(id: number, sandboxId: string, processId: number): void {
    const procs = JSON.parse(this.job(id)?.procs ?? "[]") as [string, number][];
    this.run("update jobs set procs = ? where id = ?", JSON.stringify([...procs, [sandboxId, processId]]), id);
  }

  clearProcs(id: number): void {
    this.run("update jobs set procs = '[]' where id = ?", id);
  }

  endJob(id: number, status: JobStatus, error: string | null = null): void {
    this.run("update jobs set status = ?, finished = ?, error = ? where id = ?", status, now(), error, id);
  }

  appendLog(id: number, line: string): void {
    this.run("update jobs set log = substr(log || ?, -200000) where id = ?", `${now().slice(11, 19)} ${line}\n`, id);
  }

  /**
   * Jobs whose server stopped beating before `before` (a restart, a deploy, a crash) go back into the
   * queue and start again from the beginning; their run and setup wait with them. A run or setup left
   * running without a job fails.
   */
  requeueStale(before: string): number[] {
    const ids = this.all<{ id: number }>("select id from jobs where status = 'running' and (heartbeat is null or heartbeat < ?)", before).map((j) => j.id);
    for (const id of ids) {
      this.run(
        "update jobs set status = 'queued', heartbeat = null, restarts = restarts + 1, log = substr(log || ?, -200000) where id = ?",
        `${now().slice(11, 19)} the server restarted during this job; it starts again\n`,
        id,
      );
      this.run("update runs set status = 'queued' where status = 'running' and id = (select run_id from jobs where id = ?)", id);
      this.run("update projects set setup = 'queued' where setup = 'running' and id = (select project_id from jobs where id = ? and kind = 'setup')", id);
    }
    this.run(
      "update runs set status = 'failed', finished = ?, error = 'the server restarted during this run' where status = 'running' and not exists (select 1 from jobs where run_id = runs.id and status in ('queued', 'running'))",
      now(),
    );
    this.run(
      "update projects set setup = 'failed', setup_error = 'the server restarted during setup' where setup = 'running' and not exists (select 1 from jobs where project_id = projects.id and kind = 'setup' and status in ('queued', 'running'))",
    );
    return ids;
  }

  /** A Codex sign-in lives in the server process; one that was waiting when it stopped is over. */
  failPendingLogins(): void {
    this.run("update users set codex_state = 'failed', codex_login = '{\"url\":null,\"code\":null,\"lines\":\"The server restarted during the sign-in. Start it again.\"}' where codex_state = 'pending'");
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

  run_(id: number): Run | undefined {
    return this.one<Run>("select * from runs where id = ?", id);
  }

  /** The newest run of this PR head that was not superseded. */
  runForHead(projectId: number, pr: number, head: string): Run | undefined {
    return this.one<Run>("select * from runs where project_id = ? and pr = ? and head = ? and status != 'cancelled' order by id desc limit 1", projectId, pr, head);
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
    return this.all<ApiToken>("select id, name, hint, created, last_used from api_tokens where user_id = ? order by id desc", userId);
  }

  deleteToken(userId: number, id: number): void {
    this.run("delete from api_tokens where user_id = ? and id = ?", userId, id);
  }

  /** The user a token belongs to; notes when it was used. */
  tokenUser(raw: string): User | undefined {
    if (!raw.startsWith("gsp_")) return undefined;
    const hash = tokenHash(raw);
    const user = this.one<User>("select u.* from api_tokens t join users u on u.id = t.user_id where t.hash = ?", hash);
    if (user) this.run("update api_tokens set last_used = ? where hash = ?", now(), hash);
    return user;
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
