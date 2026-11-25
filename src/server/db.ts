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
create table if not exists slots (
  id integer primary key, project_id integer not null references projects(id), sandbox_id text not null,
  job_id integer, bundle integer not null default 0);
create table if not exists api_tokens (
  id integer primary key, user_id integer not null references users(id), name text not null,
  hash text not null unique, hint text not null, created text not null, last_used text);
`;

/**
 * Access to the read-only MCP endpoint: a personal token, or an agent's OAuth sign-in (`client` set),
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
      ["repos_synced", "text"],
      ["max_jobs", "integer"],
    ] as const) {
      if (!cols.has(name)) this.sql.exec(`alter table users add column ${name} ${def}`);
    }
    const pcols = new Set((this.sql.prepare("pragma table_info(projects)").all() as { name: string }[]).map((c) => c.name));
    if (!pcols.has("suggestion")) this.sql.exec("alter table projects add column suggestion text");
    if (!pcols.has("bundle")) this.sql.exec("alter table projects add column bundle integer not null default 0");
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

  /**
   * The oldest queued job that may start now. Jobs run side by side, also of one project and one owner,
   * each in its own sandbox; only a setup runs alone in its project, no job overtakes a queued setup,
   * and an owner never has more jobs running than the limit they set in Settings.
   */
  nextJob(): Job | undefined {
    return this.one<Job>(
      `select j.* from jobs j join projects p on p.id = j.project_id join users u on u.id = p.owner_id where j.status = 'queued'
         and not exists (select 1 from jobs r where r.project_id = j.project_id and r.status = 'running' and (r.kind = 'setup' or j.kind = 'setup'))
         and not exists (select 1 from jobs s where s.project_id = j.project_id and s.kind = 'setup' and s.status = 'queued' and s.id < j.id)
         and (u.max_jobs is null or (select count(*) from jobs o join projects op on op.id = o.project_id where o.status = 'running' and op.owner_id = u.id) < u.max_jobs)
       order by j.id limit 1`,
    );
  }

  /** How many jobs of the user's projects may run at once; null leaves it to the sandbox host. */
  maxJobs(userId: number): number | null {
    return this.one<{ max_jobs: number | null }>("select max_jobs from users where id = ?", userId)?.max_jobs ?? null;
  }

  setMaxJobs(userId: number, max: number | null): void {
    this.run("update users set max_jobs = ? where id = ?", max, userId);
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

  /** Jobs of the user's projects that wait for a free sandbox. */
  queuedJobs(userId: number): number {
    return this.one<{ n: number }>("select count(*) as n from jobs j join projects p on p.id = j.project_id where p.owner_id = ? and j.status = 'queued'", userId)?.n ?? 0;
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

  /**
   * The project sandbox this job uses: the one it held before a restart, or a free one. A slot is free
   * when no queued or running job holds it. Undefined when all are taken: the caller makes a new one.
   */
  takeSlot(projectId: number, jobId: number): Slot | undefined {
    // Projects from before slots: their one sandbox becomes the first slot.
    const p = this.project(projectId);
    if (p?.sandbox_id && !this.one("select 1 from slots where project_id = ?", projectId)) this.run("insert into slots (project_id, sandbox_id) values (?, ?)", projectId, p.sandbox_id);
    const mine = this.one<Slot>("select * from slots where project_id = ? and job_id = ? order by id limit 1", projectId, jobId);
    if (mine) return mine;
    const free = this.all<Slot>(
      "select s.* from slots s where s.project_id = ? and (s.job_id is null or not exists (select 1 from jobs j where j.id = s.job_id and j.status in ('queued', 'running'))) order by s.id",
      projectId,
    );
    for (const s of free) {
      // Conditional, so a second server (during a rolling deploy) cannot take the same slot.
      const taken = Number(this.sql.prepare("update slots set job_id = ? where id = ? and job_id is ?").run(jobId, s.id, s.job_id).changes) === 1;
      if (taken) return { ...s, job_id: jobId };
    }
    return undefined;
  }

  addSlot(projectId: number, sandboxId: string, jobId: number): Slot {
    const id = this.run("insert into slots (project_id, sandbox_id, job_id) values (?, ?, ?)", projectId, sandboxId, jobId);
    return this.one<Slot>("select * from slots where id = ?", id) as Slot;
  }

  slot(id: number): Slot | undefined {
    return this.one<Slot>("select * from slots where id = ?", id);
  }

  slots(projectId: number): Slot[] {
    return this.all<Slot>("select * from slots where project_id = ? order by id", projectId);
  }

  setSlotBundle(id: number, bundle: number): void {
    this.run("update slots set bundle = ? where id = ?", bundle, id);
  }

  /** A slot whose sandbox is gone for good. */
  dropSlot(id: number): void {
    const s = this.slot(id);
    this.run("delete from slots where id = ?", id);
    if (s) this.run("update projects set sandbox_id = null where id = ? and sandbox_id = ?", s.project_id, s.sandbox_id);
  }

  releaseSlots(jobId: number): void {
    this.run("update slots set job_id = null where job_id = ?", jobId);
  }

  job(id: number): Job | undefined {
    return this.one<Job>("select * from jobs where id = ?", id);
  }

  jobs(projectId: number, limit = 20): Job[] {
    return this.all<Job>("select * from jobs where project_id = ? order by id desc limit ?", projectId, limit);
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
