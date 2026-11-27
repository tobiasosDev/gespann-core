//! The shared SQLite database. The UI (`src/server/db.ts`) owns the schema of its tables; the
//! orchestrator adds its own (`job_steps`, `job_procs`, `outbox`) and the `jobs.owner` column.
//! WAL and a busy timeout, as the UI opens it, so both processes write side by side.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use rusqlite::types::Value;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::codex::Provider;

/// `new Date().toISOString()`: `2026-11-26T09:39:51.049Z`.
pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Project {
    pub id: i64,
    pub owner_id: i64,
    pub installation_id: i64,
    pub repo: String,
    pub default_branch: String,
    pub criteria: String,
    pub model: Option<String>,
    pub sandbox_id: Option<String>,
    pub bundle: i64,
    pub setup: String,
    pub setup_error: Option<String>,
    pub recipe: Option<String>,
    pub notes: Option<String>,
    pub viewports: String,
    /// "linux" or "macos" (`sandbox::Platform`); empty in a database from before platforms.
    pub platform: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Run {
    pub id: i64,
    pub project_id: i64,
    pub pr: i64,
    pub head: String,
    pub base: String,
    pub base_ref: String,
    pub status: String,
    pub outcome: Option<String>,
    pub check_run_id: Option<i64>,
    pub token: String,
    pub error: Option<String>,
    pub progress: Option<String>,
    pub conflict: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Job {
    pub id: i64,
    pub project_id: i64,
    /// "setup", "suggest", "run" or the retired "login".
    pub kind: String,
    pub status: String,
    pub run_id: Option<i64>,
    pub started: Option<String>,
    pub finished: Option<String>,
    pub restarts: i64,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Slot {
    pub id: i64,
    pub project_id: i64,
    pub sandbox_id: String,
    pub job_id: Option<i64>,
    pub bundle: i64,
}

/// A background command a job started under a journal key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub sandbox_id: String,
    pub pid: u64,
    /// When it started (`now()` format); its timeout counts from here, across restarts.
    pub started: String,
    /// The provider confirmed the start. False: stored before the start, which may or may not have
    /// happened (the orchestrator stopped while the provider answered); a takeover starts it again
    /// under the same handle, which does nothing when it did start.
    pub acked: bool,
}

#[derive(Debug, Clone)]
pub struct OutboxItem {
    pub id: i64,
    /// "ended": `POST /internal/jobs/<payload.jobId>/ended`.
    pub kind: String,
    pub payload: String,
}

/// Columns to change: `(name, value)`. Names are fixed strings from the code, never input.
pub type Fields<'a> = &'a [(&'a str, Value)];

pub fn text(s: impl Into<String>) -> Value {
    Value::Text(s.into())
}
pub fn opt_text(s: Option<impl Into<String>>) -> Value {
    s.map(|s| Value::Text(s.into())).unwrap_or(Value::Null)
}
pub fn int(n: i64) -> Value {
    Value::Integer(n)
}

/// SQL over `users`: the owner's agent can run on the provider they chose (`AGENT_READY` in src/server/db.ts).
pub const AGENT_READY: &str = "(case agent when 'openrouter' then openrouter_key is not null and openrouter_model is not null when 'claude' then claude_key is not null when 'copilot' then copilot_key is not null when 'grok' then grok_key is not null or grok_auth is not null else codex_state = 'connected' end)";

/// The users columns of Claude Code, Copilot and Grok: sealed key, its label, the chosen model.
/// Plus the device-code sign-ins of Copilot and Grok (state and progress for the UI) and Grok's sealed auth.json.
pub const AGENT_COLUMNS: [&str; 14] = [
    "claude_key text",
    "claude_label text",
    "claude_model text",
    "copilot_key text",
    "copilot_label text",
    "copilot_model text",
    "grok_key text",
    "grok_label text",
    "grok_model text",
    "copilot_login_state text",
    "copilot_login text",
    "grok_login_state text",
    "grok_login text",
    "grok_auth text",
];

/// The owner's agent provider from Settings, with that provider's model (Codex: the Codex model) and,
/// for OpenRouter, the model's context size. Keys stay in the database (`Db::agent_key`).
#[derive(Debug, Clone, Default)]
pub struct AgentRow {
    pub provider: Provider,
    pub model: Option<String>,
    pub context: Option<i64>,
    /// Grok signed in with xAI and has no API key: its steps use the sealed auth.json.
    pub auth: bool,
}

/// The UI's tables as `src/server/db.ts` makes them (SCHEMA plus the columns added later), for tests.
const UI_SCHEMA: &str = "
create table if not exists settings (key text primary key, value text not null);
create table if not exists users (
  id integer primary key, github_id integer unique not null, login text not null,
  name text, avatar text, created text not null,
  codex_state text not null default 'none', codex_login text, codex_auth text, codex_account text, codex_model text,
  repos_synced text, max_jobs integer, job_cap integer,
  agent text not null default 'codex', openrouter_key text, openrouter_label text, openrouter_model text, openrouter_context integer,
  claude_key text, claude_label text, claude_model text, copilot_key text, copilot_label text, copilot_model text, grok_key text, grok_label text, grok_model text,
  copilot_login_state text, copilot_login text, grok_login_state text, grok_login text, grok_auth text);
create table if not exists projects (
  id integer primary key, owner_id integer not null references users(id), installation_id integer not null,
  repo text not null unique, repo_id integer not null, default_branch text not null,
  criteria text not null default '', model text, sandbox_id text,
  codex text not null default 'none', codex_login text,
  setup text not null default 'none', setup_error text, recipe text, notes text,
  active integer not null default 0, created text not null,
  suggestion text, bundle integer not null default 0, viewports text not null default '', gate integer not null default 0,
  platform text not null default 'linux');
create table if not exists runs (
  id integer primary key, project_id integer not null references projects(id), pr integer not null, title text,
  head text not null, base text not null, base_ref text not null,
  status text not null, outcome text, verdict text, check_run_id integer, comment_id integer,
  token text not null, files text not null default '[]',
  created text not null, started text, finished text, error text, conflict text,
  progress text, media_cleared text);
create index if not exists runs_project on runs(project_id, id);
create table if not exists jobs (
  id integer primary key, project_id integer not null references projects(id), kind text not null,
  status text not null, run_id integer references runs(id),
  created text not null, started text, finished text, error text, log text not null default '',
  restarts integer not null default 0, heartbeat text, procs text not null default '[]', ended_noted text, not_before text);
create index if not exists jobs_status on jobs(status, id);
create table if not exists slots (
  id integer primary key, project_id integer not null references projects(id), sandbox_id text not null,
  job_id integer, bundle integer not null default 0);
create table if not exists project_access (
  project_id integer not null references projects(id), name text not null,
  sealed text not null, hint text not null, updated text not null, primary key (project_id, name));
";

/// The orchestrator's own tables.
const OWN_SCHEMA: &str = "
create table if not exists job_steps (job_id integer not null, key text not null, result text not null, primary key (job_id, key));
create table if not exists job_procs (job_id integer not null, key text not null, sandbox_id text not null, pid integer not null, started text not null, acked integer not null default 1, primary key (job_id, key));
create table if not exists outbox (id integer primary key, kind text not null, payload text not null, created text not null, tries integer not null default 0, next_try text, done text);
create index if not exists outbox_due on outbox(done, next_try);
";

/// `HH:MM:SS line\n`, as `appendLog` writes it.
fn log_line(line: &str) -> String {
    format!("{} {line}\n", &now()[11..19])
}

/// When an outbox item that failed `tries` times is tried again: 5 s doubling, at most 10 minutes.
fn outbox_backoff(tries: i64) -> chrono::Duration {
    let secs = 5i64.saturating_mul(1i64 << tries.clamp(0, 20)).min(600);
    chrono::Duration::seconds(secs)
}

fn ts(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get("id")?,
        owner_id: r.get("owner_id")?,
        installation_id: r.get("installation_id")?,
        repo: r.get("repo")?,
        default_branch: r.get("default_branch")?,
        criteria: r.get("criteria")?,
        model: r.get("model")?,
        sandbox_id: r.get("sandbox_id")?,
        bundle: r.get("bundle")?,
        setup: r.get("setup")?,
        setup_error: r.get("setup_error")?,
        recipe: r.get("recipe")?,
        notes: r.get("notes")?,
        viewports: r.get("viewports")?,
        // The UI adds the column; an orchestrator that runs before it reads every project as Linux.
        platform: r.get("platform").unwrap_or_default(),
    })
}

fn run_row(r: &rusqlite::Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        pr: r.get("pr")?,
        head: r.get("head")?,
        base: r.get("base")?,
        base_ref: r.get("base_ref")?,
        status: r.get("status")?,
        outcome: r.get("outcome")?,
        check_run_id: r.get("check_run_id")?,
        token: r.get("token")?,
        error: r.get("error")?,
        progress: r.get("progress")?,
        conflict: r.get("conflict")?,
    })
}

fn job_row(r: &rusqlite::Row) -> rusqlite::Result<Job> {
    Ok(Job {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        kind: r.get("kind")?,
        status: r.get("status")?,
        run_id: r.get("run_id")?,
        started: r.get("started")?,
        finished: r.get("finished")?,
        restarts: r.get("restarts")?,
        owner: r.get("owner")?,
    })
}

fn slot_row(r: &rusqlite::Row) -> rusqlite::Result<Slot> {
    Ok(Slot { id: r.get("id")?, project_id: r.get("project_id")?, sandbox_id: r.get("sandbox_id")?, job_id: r.get("job_id")?, bundle: r.get("bundle")? })
}

/// `update <table> set a = ?, b = ? where id = ?`.
fn update(conn: &rusqlite::Connection, table: &str, id: i64, fields: Fields) -> rusqlite::Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let set = fields.iter().map(|(k, _)| format!("{k} = ?")).collect::<Vec<_>>().join(", ");
    let mut params: Vec<&dyn rusqlite::ToSql> = fields.iter().map(|(_, v)| v as &dyn rusqlite::ToSql).collect();
    params.push(&id);
    conn.execute(&format!("update {table} set {set} where id = ?"), params.as_slice())?;
    Ok(())
}

fn table_exists(conn: &rusqlite::Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("select count(*) from sqlite_master where type = 'table' and name = ?", [name], |r| r.get::<_, i64>(0)).map(|n| n > 0)
}

/// The orchestrator's tables and the `jobs.owner` column, on top of the UI's schema.
fn ensure_own(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(OWN_SCHEMA)?;
    let has_owner = {
        let mut st = conn.prepare("pragma table_info(jobs)")?;
        let names = st.query_map([], |r| r.get::<_, String>("name"))?.collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().any(|n| n == "owner")
    };
    if !has_owner {
        // The UI may add the same column at the same moment.
        if let Err(e) = conn.execute_batch("alter table jobs add column owner text") {
            if !e.to_string().contains("duplicate column") {
                return Err(e);
            }
        }
    }
    // The UI adds these users columns too; an orchestrator that opens the file first must not fail on them.
    for col in ["job_cap integer", "codex_model text", "agent text not null default 'codex'", "openrouter_key text", "openrouter_label text", "openrouter_model text", "openrouter_context integer"].into_iter().chain(AGENT_COLUMNS) {
        if let Err(e) = conn.execute_batch(&format!("alter table users add column {col}")) {
            if !e.to_string().contains("duplicate column") {
                return Err(e);
            }
        }
    }
    // job_procs from before `acked`: every process in it was started and confirmed.
    if let Err(e) = conn.execute_batch("alter table job_procs add column acked integer not null default 1") {
        if !e.to_string().contains("duplicate column") {
            return Err(e);
        }
    }
    Ok(())
}

fn pragmas(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.query_row("pragma journal_mode = wal", [], |r| r.get::<_, String>(0))?;
    conn.execute_batch("pragma foreign_keys = on; pragma busy_timeout = 5000;")
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

impl Db {
    /// Opens the database the UI made (it must exist, with its schema) and adds the orchestrator's tables.
    pub fn open(path: &str) -> Result<Db> {
        let conn = rusqlite::Connection::open(path)?;
        pragmas(&conn)?;
        if !table_exists(&conn, "jobs")? || !table_exists(&conn, "users")? {
            anyhow::bail!("no gespann tables yet: start the UI (gespann serve) first, it creates them");
        }
        ensure_own(&conn)?;
        Ok(Db { conn: Arc::new(Mutex::new(conn)) })
    }

    /// For tests: a fresh database with the UI's tables as `src/server/db.ts` makes them (the columns the orchestrator uses).
    pub fn memory() -> Result<Db> {
        let conn = rusqlite::Connection::open_in_memory()?;
        pragmas(&conn)?;
        conn.execute_batch(UI_SCHEMA)?;
        ensure_own(&conn)?;
        Ok(Db { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Runs `f` with the connection (tests and one-off queries).
    pub fn with<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().expect("db lock");
        Ok(f(&conn)?)
    }

    // ---- projects, runs, users

    pub fn project(&self, id: i64) -> Result<Option<Project>> {
        self.with(|c| c.query_row("select * from projects where id = ?", [id], project_row).optional())
    }
    pub fn update_project(&self, id: i64, fields: Fields) -> Result<()> {
        self.with(|c| update(c, "projects", id, fields))
    }
    pub fn run(&self, id: i64) -> Result<Option<Run>> {
        self.with(|c| c.query_row("select * from runs where id = ?", [id], run_row).optional())
    }
    pub fn update_run(&self, id: i64, fields: Fields) -> Result<()> {
        self.with(|c| update(c, "runs", id, fields))
    }
    /// The owner's sealed Codex sign-in.
    pub fn codex_auth(&self, user_id: i64) -> Result<Option<String>> {
        Ok(self.with(|c| c.query_row("select codex_auth from users where id = ?", [user_id], |r| r.get::<_, Option<String>>(0)).optional())?.flatten())
    }
    /// The owner's chosen Codex model from Settings; None means Codex's default.
    pub fn codex_model(&self, user_id: i64) -> Result<Option<String>> {
        Ok(self
            .with(|c| c.query_row("select codex_model from users where id = ?", [user_id], |r| r.get::<_, Option<String>>(0)).optional())?
            .flatten()
            .filter(|m| !m.is_empty()))
    }
    /// The provider the owner chose for their agent, with what it needs (`AGENT_READY` decides the same).
    pub fn agent(&self, user_id: i64) -> Result<Option<AgentRow>> {
        self.with(|c| {
            c.query_row("select agent, codex_model, openrouter_model, openrouter_context, claude_model, copilot_model, grok_model, grok_key is null and grok_auth is not null from users where id = ?", [user_id], |r| {
                let provider = Provider::parse(r.get::<_, Option<String>>(0)?.as_deref());
                let col = match provider {
                    Provider::Codex => 1,
                    Provider::Openrouter => 2,
                    Provider::Claude => 4,
                    Provider::Copilot => 5,
                    Provider::Grok => 6,
                };
                let context = if provider == Provider::Openrouter { r.get(3)? } else { None };
                let auth = provider == Provider::Grok && r.get::<_, bool>(7)?;
                Ok(AgentRow { provider, model: r.get::<_, Option<String>>(col)?.filter(|m| !m.is_empty()), context, auth })
            })
            .optional()
        })
    }
    /// The project's sealed keys for its outside services (docs/access.md), by variable name. Empty
    /// while the UI has not made the table yet.
    pub fn access_keys(&self, project_id: i64) -> Result<Vec<(String, String)>> {
        self.with(|c| {
            let mut st = match c.prepare("select name, sealed from project_access where project_id = ? order by name") {
                Ok(st) => st,
                Err(e) if e.to_string().contains("no such table") => return Ok(vec![]),
                Err(e) => return Err(e),
            };
            let rows = st.query_map([project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect()
        })
    }
    /// The owner's sealed key for `provider`; None for Codex, whose sign-in is `codex_auth`.
    pub fn agent_key(&self, user_id: i64, provider: Provider) -> Result<Option<String>> {
        let col = match provider {
            Provider::Codex => return Ok(None),
            Provider::Openrouter => "openrouter_key",
            Provider::Claude => "claude_key",
            Provider::Copilot => "copilot_key",
            Provider::Grok => "grok_key",
        };
        Ok(self.with(|c| c.query_row(&format!("select {col} from users where id = ?"), [user_id], |r| r.get::<_, Option<String>>(0)).optional())?.flatten())
    }
    /// Sets `codex_state`, `codex_login`, `codex_auth`, `codex_account` as given.
    pub fn set_codex(&self, user_id: i64, fields: Fields) -> Result<()> {
        self.with(|c| update(c, "users", user_id, fields))
    }
    /// The user's `codex_state` ("none", "pending", "connected", "failed").
    pub fn codex_state(&self, user_id: i64) -> Result<Option<String>> {
        self.with(|c| c.query_row("select codex_state from users where id = ?", [user_id], |r| r.get(0)).optional())
    }
    /// `enqueue`: a queued job; its id.
    pub fn enqueue(&self, project_id: i64, kind: &str, run_id: Option<i64>) -> Result<i64> {
        self.with(|c| {
            c.execute("insert into jobs (project_id, kind, status, run_id, created) values (?, ?, 'queued', ?, ?)", rusqlite::params![project_id, kind, run_id, now()])?;
            Ok(c.last_insert_rowid())
        })
    }
    /// `autoSetup`: queues the setup of the owner's projects that never had one, once their agent can run.
    pub fn auto_setup(&self, owner_id: i64) -> Result<()> {
        self.with(|c| {
            let ready: Option<bool> = c.query_row(&format!("select {AGENT_READY} from users where id = ?"), [owner_id], |r| r.get(0)).optional()?;
            if ready != Some(true) {
                return Ok(());
            }
            let ids = {
                let mut st = c.prepare("select id from projects where owner_id = ? and setup = 'none' order by id")?;
                let ids = st.query_map([owner_id], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                ids
            };
            for id in ids {
                c.execute("update projects set setup = 'queued', setup_error = null where id = ?", [id])?;
                c.execute("insert into jobs (project_id, kind, status, run_id, created) values (?, 'setup', 'queued', null, ?)", rusqlite::params![id, now()])?;
            }
            Ok(())
        })
    }
    /// Sets `fields` on the user only while `column` still holds `expected` (null: None). True when it did:
    /// a sign-out, a new key or another job in between wins.
    pub fn update_user_if(&self, user_id: i64, fields: Fields, column: &str, expected: Option<&str>) -> Result<bool> {
        self.with(|c| {
            let set = fields.iter().map(|(k, _)| format!("{k} = ?")).collect::<Vec<_>>().join(", ");
            let mut params: Vec<&dyn rusqlite::ToSql> = fields.iter().map(|(_, v)| v as &dyn rusqlite::ToSql).collect();
            params.push(&user_id);
            params.push(&expected);
            Ok(c.execute(&format!("update users set {set} where id = ? and {column} is ?"), params.as_slice())? == 1)
        })
    }
    /// The owner's sealed Grok sign-in (auth.json).
    pub fn grok_auth(&self, user_id: i64) -> Result<Option<String>> {
        Ok(self.with(|c| c.query_row("select grok_auth from users where id = ?", [user_id], |r| r.get::<_, Option<String>>(0)).optional())?.flatten())
    }
    /// Copilot and Grok sign-ins waiting for the orchestrator.
    pub fn pending_agent_logins(&self) -> Result<Vec<(i64, Provider)>> {
        self.with(|c| {
            let mut st = c.prepare("select id, coalesce(copilot_login_state, '') = 'pending', coalesce(grok_login_state, '') = 'pending' from users where copilot_login_state = 'pending' or grok_login_state = 'pending' order by id")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().flat_map(|(u, copilot, grok)| [(copilot, Provider::Copilot), (grok, Provider::Grok)].into_iter().filter(|(on, _)| *on).map(move |(_, p)| (u, p))).collect())
        })
    }
    /// Users whose Codex sign-in waits for the orchestrator (`codex_state = 'pending'`).
    pub fn pending_logins(&self) -> Result<Vec<i64>> {
        self.with(|c| {
            let mut st = c.prepare("select id from users where codex_state = 'pending' order by id")?;
            let ids = st.query_map([], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
    }
    pub fn user_login(&self, user_id: i64) -> Result<Option<String>> {
        self.with(|c| c.query_row("select login from users where id = ?", [user_id], |r| r.get(0)).optional())
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| c.execute("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", [key, value]).map(|_| ()))
    }
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| c.query_row("select value from settings where key = ?", [key], |r| r.get(0)).optional())
    }

    // ---- jobs and leases

    pub fn job(&self, id: i64) -> Result<Option<Job>> {
        self.with(|c| c.query_row("select * from jobs where id = ?", [id], job_row).optional())
    }
    /// The job's log as the UI shows it.
    pub fn job_log(&self, id: i64) -> Result<Option<String>> {
        self.with(|c| c.query_row("select log from jobs where id = ?", [id], |r| r.get(0)).optional())
    }
    /// `appendLog`: `HH:MM:SS line\n`, the log kept to its last 200,000 characters.
    pub fn append_log(&self, id: i64, line: &str) -> Result<()> {
        self.with(|c| c.execute("update jobs set log = substr(log || ?, -200000) where id = ?", rusqlite::params![log_line(line), id]).map(|_| ()))
    }
    /// `endJob`: status, finished now, error; also clears the lease.
    pub fn end_job(&self, id: i64, status: &str, error: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("update jobs set status = ?, finished = ?, error = ?, owner = null where id = ?", rusqlite::params![status, now(), error, id]).map(|_| ()))
    }
    /// `end_job` and the outbox item that tells the UI (`POST /internal/jobs/:id/ended`), in one
    /// transaction, so the note is never lost across a restart.
    pub fn finish_job(&self, id: i64, status: &str, error: Option<&str>) -> Result<()> {
        self.finish_job_and(id, status, error, None)
    }
    /// `finish_job` plus one more outbox item in the same transaction (a failed run's report).
    pub fn finish_job_and(&self, id: i64, status: &str, error: Option<&str>, also: Option<(&str, &str)>) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let at = now();
        tx.execute("update jobs set status = ?, finished = ?, error = ?, owner = null where id = ?", rusqlite::params![status, at, error, id])?;
        tx.execute(
            "insert into outbox (kind, payload, created, next_try) values ('ended', ?, ?, ?)",
            rusqlite::params![serde_json::json!({ "jobId": id }).to_string(), at, at],
        )?;
        if let Some((kind, payload)) = also {
            tx.execute("insert into outbox (kind, payload, created, next_try) values (?, ?, ?, ?)", rusqlite::params![kind, payload, at, at])?;
        }
        tx.commit()?;
        Ok(())
    }
    /// The oldest queued job that may start now, by the rules of `nextJob` in TypeScript.
    pub fn next_job(&self) -> Result<Option<Job>> {
        Ok(self.next_jobs(0, 1)?.into_iter().next().map(|(j, _)| j))
    }
    /// Up to `limit` queued jobs after job `after` that may start now, oldest first, each with its
    /// project's owner: the worker pages through them for the first whose owner's provider has room.
    pub fn next_jobs(&self, after: i64, limit: u32) -> Result<Vec<(Job, i64)>> {
        self.with(|c| {
            let mut st = c.prepare(
                "select j.*, p.owner_id as gespann_owner from jobs j join projects p on p.id = j.project_id join users u on u.id = p.owner_id where j.status = 'queued' and j.id > ?3
         and (j.not_before is null or j.not_before <= ?1)
         and not exists (select 1 from jobs r where r.project_id = j.project_id and r.status = 'running' and (r.kind = 'setup' or j.kind = 'setup'))
         and not exists (select 1 from jobs s where s.project_id = j.project_id and s.kind = 'setup' and s.status = 'queued' and s.id < j.id)
         and (u.max_jobs is null or (select count(*) from jobs o join projects op on op.id = o.project_id where o.status = 'running' and op.owner_id = u.id) < u.max_jobs)
         and (u.job_cap is null or (select count(*) from jobs o join projects op on op.id = o.project_id where o.status = 'running' and op.owner_id = u.id) < u.job_cap)
       order by j.id limit ?2",
            )?;
            let rows = st.query_map(rusqlite::params![now(), limit, after], |r| Ok((job_row(r)?, r.get::<_, i64>("gespann_owner")?)))?;
            rows.collect()
        })
    }
    /// `endUnstarted`: ends a job that never touched a sandbox (its PR failed CI first); no sandbox time.
    pub fn end_unstarted(&self, id: i64) -> Result<()> {
        self.with(|c| c.execute("update jobs set status = 'done', started = null, heartbeat = null, owner = null, finished = ? where id = ?", rusqlite::params![now(), id]))?;
        Ok(())
    }
    /// A job the UI put back into the queue (`deferJob`) starts over when it is taken again: nothing of
    /// it ran yet, and the next pass must ask everything again.
    pub fn forget_deferred(&self, id: i64) -> Result<()> {
        self.with(|c| {
            c.execute("delete from job_steps where job_id = ?", [id])?;
            c.execute("delete from job_procs where job_id = ?", [id])?;
            c.execute("update jobs set owner = null where id = ? and status = 'queued'", [id])
        })?;
        Ok(())
    }
    /// Takes a queued job for `owner`; false when someone else took it first.
    pub fn claim_job(&self, id: i64, owner: &str) -> Result<bool> {
        let at = now();
        self.with(|c| {
            c.execute("update jobs set status = 'running', started = coalesce(started, ?), heartbeat = ?, owner = ? where id = ? and status = 'queued'", rusqlite::params![at, at, owner, id])
                .map(|n| n == 1)
        })
    }
    /// Beats for the running jobs this owner holds.
    pub fn beat(&self, owner: &str, ids: &[i64]) -> Result<()> {
        let at = now();
        self.with(|c| {
            let mut st = c.prepare("update jobs set heartbeat = ? where id = ? and status = 'running' and owner = ?")?;
            for id in ids {
                st.execute(rusqlite::params![at, id, owner])?;
            }
            Ok(())
        })
    }
    /// Takes over running jobs whose owner stopped beating before `before` (or that have no owner):
    /// they become this owner's, `restarts + 1`, and a log line says the job is picked up again.
    pub fn adopt_stale(&self, owner: &str, before: &str) -> Result<Vec<Job>> {
        const STALE: &str = "status = 'running' and (owner is null or heartbeat is null or heartbeat < ?1) and (owner is null or owner != ?2)";
        let line = log_line("the orchestrator restarted during this job; it picks the job up where it was");
        let at = now();
        self.with(|c| {
            let ids = {
                let mut st = c.prepare(&format!("select id from jobs where {STALE} order by id"))?;
                let ids = st.query_map(rusqlite::params![before, owner], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                ids
            };
            let mut taken = Vec::new();
            for id in ids {
                // Conditional: another instance may take the same job at the same moment.
                let n = c.execute(
                    &format!("update jobs set owner = ?2, heartbeat = ?3, restarts = restarts + 1, log = substr(log || ?4, -200000) where id = ?5 and {STALE}"),
                    rusqlite::params![before, owner, at, line, id],
                )?;
                if n == 1 {
                    taken.push(c.query_row("select * from jobs where id = ?", [id], job_row)?);
                }
            }
            Ok(taken)
        })
    }
    /// On shutdown: this owner's running jobs lose their lease, so the next orchestrator takes them at once.
    pub fn release_leases(&self, owner: &str) -> Result<()> {
        self.with(|c| c.execute("update jobs set heartbeat = null, owner = null where owner = ? and status = 'running'", [owner]).map(|_| ()))
    }

    // ---- slots

    pub fn take_slot(&self, project_id: i64, job_id: i64) -> Result<Option<Slot>> {
        self.with(|c| {
            // Projects from before slots: their one sandbox becomes the first slot.
            let old: Option<Option<String>> = c.query_row("select sandbox_id from projects where id = ?", [project_id], |r| r.get(0)).optional()?;
            if let Some(Some(sandbox)) = old {
                let any: i64 = c.query_row("select count(*) from slots where project_id = ?", [project_id], |r| r.get(0))?;
                if any == 0 {
                    c.execute("insert into slots (project_id, sandbox_id) values (?, ?)", rusqlite::params![project_id, sandbox])?;
                }
            }
            if let Some(mine) = c.query_row("select * from slots where project_id = ? and job_id = ? order by id limit 1", [project_id, job_id], slot_row).optional()? {
                return Ok(Some(mine));
            }
            let free = {
                let mut st = c.prepare(
                    "select s.* from slots s where s.project_id = ? and (s.job_id is null or not exists (select 1 from jobs j where j.id = s.job_id and j.status in ('queued', 'running'))) order by s.id",
                )?;
                let free = st.query_map([project_id], slot_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
                free
            };
            for s in free {
                // Conditional, so a second process cannot take the same slot.
                if c.execute("update slots set job_id = ? where id = ? and job_id is ?", rusqlite::params![job_id, s.id, s.job_id])? == 1 {
                    return Ok(Some(Slot { job_id: Some(job_id), ..s }));
                }
            }
            Ok(None)
        })
    }
    pub fn add_slot(&self, project_id: i64, sandbox_id: &str, job_id: i64) -> Result<Slot> {
        self.with(|c| {
            c.execute("insert into slots (project_id, sandbox_id, job_id) values (?, ?, ?)", rusqlite::params![project_id, sandbox_id, job_id])?;
            c.query_row("select * from slots where id = ?", [c.last_insert_rowid()], slot_row)
        })
    }
    pub fn slot(&self, id: i64) -> Result<Option<Slot>> {
        self.with(|c| c.query_row("select * from slots where id = ?", [id], slot_row).optional())
    }
    pub fn slots(&self, project_id: i64) -> Result<Vec<Slot>> {
        self.with(|c| {
            let mut st = c.prepare("select * from slots where project_id = ? order by id")?;
            let all = st.query_map([project_id], slot_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(all)
        })
    }
    pub fn set_slot_bundle(&self, id: i64, bundle: i64) -> Result<()> {
        self.with(|c| c.execute("update slots set bundle = ? where id = ?", [bundle, id]).map(|_| ()))
    }
    pub fn drop_slot(&self, id: i64) -> Result<()> {
        self.with(|c| {
            let s = c.query_row("select * from slots where id = ?", [id], slot_row).optional()?;
            c.execute("delete from slots where id = ?", [id])?;
            if let Some(s) = s {
                c.execute("update projects set sandbox_id = null where id = ? and sandbox_id = ?", rusqlite::params![s.project_id, s.sandbox_id])?;
            }
            Ok(())
        })
    }
    pub fn release_slots(&self, job_id: i64) -> Result<()> {
        self.with(|c| c.execute("update slots set job_id = null where job_id = ?", [job_id]).map(|_| ()))
    }
    /// Status of the job a slot holds, for "is this sandbox busy".
    pub fn job_status(&self, id: i64) -> Result<Option<String>> {
        self.with(|c| c.query_row("select status from jobs where id = ?", [id], |r| r.get(0)).optional())
    }

    // ---- journal

    pub fn step_get(&self, job_id: i64, key: &str) -> Result<Option<String>> {
        self.with(|c| c.query_row("select result from job_steps where job_id = ? and key = ?", rusqlite::params![job_id, key], |r| r.get(0)).optional())
    }
    pub fn step_put(&self, job_id: i64, key: &str, json: &str) -> Result<()> {
        self.with(|c| c.execute("insert or replace into job_steps (job_id, key, result) values (?, ?, ?)", rusqlite::params![job_id, key, json]).map(|_| ()))
    }
    pub fn step_count(&self, job_id: i64) -> Result<i64> {
        self.with(|c| c.query_row("select count(*) from job_steps where job_id = ?", [job_id], |r| r.get(0)))
    }
    pub fn proc_get(&self, job_id: i64, key: &str) -> Result<Option<Proc>> {
        self.with(|c| {
            c.query_row("select sandbox_id, pid, started, acked from job_procs where job_id = ? and key = ?", rusqlite::params![job_id, key], |r| {
                Ok(Proc { sandbox_id: r.get(0)?, pid: r.get::<_, i64>(1)? as u64, started: r.get(2)?, acked: r.get::<_, i64>(3)? != 0 })
            })
            .optional()
        })
    }
    /// The background commands a job started whose result is not stored yet, by key: they may still run.
    pub fn open_procs(&self, job_id: i64) -> Result<Vec<(String, Proc)>> {
        self.with(|c| {
            let mut st = c.prepare("select key, sandbox_id, pid, started, acked from job_procs p where job_id = ? and not exists (select 1 from job_steps s where s.job_id = p.job_id and s.key = p.key)")?;
            let rows = st.query_map([job_id], |r| Ok((r.get(0)?, Proc { sandbox_id: r.get(1)?, pid: r.get::<_, i64>(2)? as u64, started: r.get(3)?, acked: r.get::<_, i64>(4)? != 0 })))?;
            rows.collect()
        })
    }
    /// Journal keys of the job that end with `suffix`.
    pub fn step_keys(&self, job_id: i64, suffix: &str) -> Result<Vec<String>> {
        self.with(|c| {
            let mut st = c.prepare("select key from job_steps where job_id = ? and substr(key, -length(?)) = ? order by key")?;
            let rows = st.query_map(rusqlite::params![job_id, suffix, suffix], |r| r.get(0))?;
            rows.collect()
        })
    }
    pub fn proc_put(&self, job_id: i64, key: &str, p: &Proc) -> Result<()> {
        self.with(|c| {
            c.execute(
                "insert or replace into job_procs (job_id, key, sandbox_id, pid, started, acked) values (?, ?, ?, ?, ?, ?)",
                rusqlite::params![job_id, key, p.sandbox_id, p.pid as i64, p.started, p.acked as i64],
            )
            .map(|_| ())
        })
    }

    // ---- outbox

    pub fn outbox_add(&self, kind: &str, payload: &str) -> Result<()> {
        let at = now();
        self.with(|c| c.execute("insert into outbox (kind, payload, created, next_try) values (?, ?, ?, ?)", rusqlite::params![kind, payload, at, at]).map(|_| ()))
    }
    pub fn outbox_due(&self) -> Result<Vec<OutboxItem>> {
        let at = now();
        self.with(|c| {
            let mut st = c.prepare("select id, kind, payload from outbox where done is null and (next_try is null or next_try <= ?) order by id")?;
            let all = st.query_map([at], |r| Ok(OutboxItem { id: r.get(0)?, kind: r.get(1)?, payload: r.get(2)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(all)
        })
    }
    pub fn outbox_done(&self, id: i64) -> Result<()> {
        self.with(|c| c.execute("update outbox set done = ? where id = ?", rusqlite::params![now(), id]).map(|_| ()))
    }
    /// A delivery failed: tries + 1, and the next try later (5 s doubling, at most 10 minutes).
    pub fn outbox_failed(&self, id: i64) -> Result<()> {
        self.with(|c| {
            let tries: i64 = c.query_row("select tries from outbox where id = ?", [id], |r| r.get(0))?;
            let next = ts(chrono::Utc::now() + outbox_backoff(tries));
            c.execute("update outbox set tries = tries + 1, next_try = ? where id = ?", rusqlite::params![next, id]).map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A user with two projects, as `owner` in test/boxes.test.ts.
    fn owner(db: &Db, id: i64, login: &str) -> (i64, i64, i64) {
        db.with(|c| {
            c.execute("insert into users (github_id, login, created) values (?, ?, ?)", rusqlite::params![id, login, now()])?;
            let u = c.last_insert_rowid();
            let mut p = Vec::new();
            for n in 1..=2 {
                c.execute(
                    "insert into projects (owner_id, installation_id, repo, repo_id, default_branch, created) values (?, 9, ?, ?, 'main', ?)",
                    rusqlite::params![u, format!("{login}/{n}"), id * 10 + n, now()],
                )?;
                p.push(c.last_insert_rowid());
            }
            Ok((u, p[0], p[1]))
        })
        .unwrap()
    }

    fn set(db: &Db, sql: &str, p: impl rusqlite::Params) {
        db.with(|c| c.execute(sql, p)).unwrap();
    }

    #[test]
    fn now_is_js_iso() {
        let n = now();
        assert_eq!(n.len(), 24);
        assert!(n.ends_with('Z') && &n[10..11] == "T" && &n[19..20] == ".");
    }

    #[test]
    fn claim_is_exclusive_between_owners() {
        let db = Db::memory().unwrap();
        let (_, a, _) = owner(&db, 1, "t");
        let j = db.enqueue(a, "run", None).unwrap();
        assert!(db.claim_job(j, "one").unwrap());
        assert!(!db.claim_job(j, "two").unwrap());
        let job = db.job(j).unwrap().unwrap();
        assert_eq!(job.owner.as_deref(), Some("one"));
        assert_eq!(job.status, "running");
        assert!(job.started.is_some());
    }

    #[test]
    fn adopt_stale_takes_only_stale_jobs() {
        let db = Db::memory().unwrap();
        let (_, a, _) = owner(&db, 1, "t");
        let fresh = db.enqueue(a, "run", None).unwrap();
        let stale = db.enqueue(a, "run", None).unwrap();
        let orphan = db.enqueue(a, "run", None).unwrap();
        let mine = db.enqueue(a, "run", None).unwrap();
        let queued = db.enqueue(a, "run", None).unwrap();
        for (j, o) in [(fresh, "other"), (stale, "other"), (orphan, "other"), (mine, "me")] {
            assert!(db.claim_job(j, o).unwrap());
        }
        set(&db, "update jobs set heartbeat = '2026-01-01T00:00:00.000Z' where id in (?, ?)", [stale, mine]);
        // A job from before the orchestrator: no owner.
        set(&db, "update jobs set owner = null where id = ?", [orphan]);
        let before = ts(chrono::Utc::now() - chrono::Duration::seconds(60));
        let got: Vec<i64> = db.adopt_stale("me", &before).unwrap().iter().map(|j| j.id).collect();
        assert_eq!(got, vec![stale, orphan], "not the fresh one, not my own, not a queued one");
        for j in [stale, orphan] {
            let job = db.job(j).unwrap().unwrap();
            assert_eq!(job.owner.as_deref(), Some("me"));
            assert_eq!(job.restarts, 1);
            let log = db.job_log(j).unwrap().unwrap();
            assert!(log.ends_with(" the orchestrator restarted during this job; it picks the job up where it was\n"), "{log}");
            assert_eq!(log.as_bytes()[2], b':');
        }
        assert_eq!(db.job(fresh).unwrap().unwrap().restarts, 0);
        assert_eq!(db.job(queued).unwrap().unwrap().status, "queued");
        assert!(db.adopt_stale("me", &before).unwrap().is_empty(), "they beat now");
    }

    #[test]
    fn beat_touches_only_own_rows() {
        let db = Db::memory().unwrap();
        let (_, a, _) = owner(&db, 1, "t");
        let j1 = db.enqueue(a, "run", None).unwrap();
        let j2 = db.enqueue(a, "run", None).unwrap();
        db.claim_job(j1, "me").unwrap();
        db.claim_job(j2, "other").unwrap();
        set(&db, "update jobs set heartbeat = 'old'", []);
        db.beat("me", &[j1, j2]).unwrap();
        let hb = |j| db.with(|c| c.query_row("select heartbeat from jobs where id = ?", [j], |r| r.get::<_, String>(0))).unwrap();
        assert_ne!(hb(j1), "old");
        assert_eq!(hb(j2), "old");
    }

    #[test]
    fn release_leases_and_end_job() {
        let db = Db::memory().unwrap();
        let (_, a, _) = owner(&db, 1, "t");
        let j1 = db.enqueue(a, "run", None).unwrap();
        let j2 = db.enqueue(a, "run", None).unwrap();
        db.claim_job(j1, "me").unwrap();
        db.claim_job(j2, "other").unwrap();
        db.release_leases("me").unwrap();
        let j = db.job(j1).unwrap().unwrap();
        assert_eq!((j.owner, j.status.as_str()), (None, "running"));
        assert_eq!(db.job(j2).unwrap().unwrap().owner.as_deref(), Some("other"));
        // Released: the next instance takes it at once, whatever the time.
        let before = ts(chrono::Utc::now() - chrono::Duration::seconds(60));
        assert_eq!(db.adopt_stale("next", &before).unwrap().len(), 1);
        db.finish_job(j2, "done", None).unwrap();
        let j = db.job(j2).unwrap().unwrap();
        assert_eq!((j.owner, j.status.as_str(), j.finished.is_some()), (None, "done", true));
        let due = db.outbox_due().unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].kind, "ended");
        assert_eq!(due[0].payload, format!("{{\"jobId\":{j2}}}"));
        db.outbox_failed(due[0].id).unwrap();
        assert!(db.outbox_due().unwrap().is_empty(), "backs off");
        db.outbox_done(due[0].id).unwrap();
    }

    #[test]
    fn next_job_honours_max_jobs() {
        let db = Db::memory().unwrap();
        let (t, ta, tb) = owner(&db, 1, "tobi");
        let (_, ea, _) = owner(&db, 2, "eve");
        set(&db, "update users set max_jobs = 1 where id = ?", [t]);
        let j1 = db.enqueue(ta, "suggest", None).unwrap();
        let j2 = db.enqueue(tb, "suggest", None).unwrap();
        let j3 = db.enqueue(ea, "suggest", None).unwrap();
        let next = || db.next_job().unwrap().map(|j| j.id);
        assert_eq!(next(), Some(j1));
        assert!(db.claim_job(j1, "me").unwrap());
        assert_eq!(next(), Some(j3), "tobi has 1 of 1 running; eve's job goes first");
        assert!(db.claim_job(j3, "me").unwrap());
        assert_eq!(next(), None, "tobi's second job waits");
        db.end_job(j1, "done", None).unwrap();
        assert_eq!(next(), Some(j2));
    }

    #[test]
    fn next_job_honours_the_server_modules_cap() {
        let db = Db::memory().unwrap();
        let (t, a, b) = owner(&db, 1, "tobi");
        set(&db, "update users set job_cap = 1 where id = ?", [t]);
        let j1 = db.enqueue(a, "suggest", None).unwrap();
        let j2 = db.enqueue(b, "suggest", None).unwrap();
        assert_eq!(db.next_job().unwrap().map(|j| j.id), Some(j1));
        assert!(db.claim_job(j1, "me").unwrap());
        assert!(db.next_job().unwrap().is_none(), "the plan allows one at a time");
        set(&db, "update users set job_cap = null where id = ?", [t]);
        assert_eq!(db.next_job().unwrap().map(|j| j.id), Some(j2));
    }

    #[test]
    fn a_deferred_job_waits_for_not_before_and_starts_over() {
        let db = Db::memory().unwrap();
        let (_, a, _) = owner(&db, 1, "t");
        let j = db.enqueue(a, "run", None).unwrap();
        assert!(db.claim_job(j, "me").unwrap());
        db.step_put(j, "pull", "null").unwrap();
        // What the UI's deferJob does while the PR's other checks run.
        set(&db, "update jobs set status = 'queued', started = null, heartbeat = null, not_before = '2999-01-01T00:00:00.000Z' where id = ?", [j]);
        db.forget_deferred(j).unwrap();
        assert_eq!(db.step_count(j).unwrap(), 0, "the next pass asks everything again");
        assert_eq!(db.job(j).unwrap().unwrap().owner, None);
        assert!(db.next_job().unwrap().is_none(), "not before its time");
        set(&db, "update jobs set not_before = '2000-01-01T00:00:00.000Z' where id = ?", [j]);
        assert_eq!(db.next_job().unwrap().map(|x| x.id), Some(j));
        assert!(db.claim_job(j, "me").unwrap());
        db.end_unstarted(j).unwrap();
        let ended = db.job(j).unwrap().unwrap();
        assert_eq!((ended.status.as_str(), ended.started, ended.owner), ("done", None, None));
    }

    #[test]
    fn next_job_honours_a_running_setup() {
        let db = Db::memory().unwrap();
        let (_, a, b) = owner(&db, 1, "t");
        let start = || {
            let j = db.next_job().unwrap();
            if let Some(j) = &j {
                db.claim_job(j.id, "me").unwrap();
            }
            j.map(|j| j.id)
        };
        let r1 = db.enqueue(a, "run", None).unwrap();
        let r2 = db.enqueue(a, "run", None).unwrap();
        let sb = db.enqueue(b, "setup", None).unwrap();
        let r3 = db.enqueue(b, "run", None).unwrap();
        assert_eq!([start(), start(), start()], [Some(r1), Some(r2), Some(sb)]);
        assert_eq!(start(), None, "b's run waits for b's setup");
        db.end_job(sb, "done", None).unwrap();
        assert_eq!(start(), Some(r3));
        let sa = db.enqueue(a, "setup", None).unwrap();
        let r4 = db.enqueue(a, "run", None).unwrap();
        assert_eq!(start(), None, "a's setup waits for a's runs, and a's newer run waits for the setup");
        db.end_job(r1, "done", None).unwrap();
        db.end_job(r2, "done", None).unwrap();
        assert_eq!(start(), Some(sa));
        assert_eq!(start(), None);
        db.end_job(sa, "done", None).unwrap();
        assert_eq!(start(), Some(r4));
    }

    #[test]
    fn slots_keep_their_job_and_the_old_sandbox_becomes_the_first() {
        let db = Db::memory().unwrap();
        let (_, p, _) = owner(&db, 1, "t");
        db.update_project(p, &[("sandbox_id", text("old"))]).unwrap();
        let j1 = db.enqueue(p, "run", None).unwrap();
        let j2 = db.enqueue(p, "run", None).unwrap();
        db.claim_job(j1, "me").unwrap();
        db.claim_job(j2, "me").unwrap();
        assert_eq!(db.take_slot(p, j1).unwrap().unwrap().sandbox_id, "old");
        assert!(db.take_slot(p, j2).unwrap().is_none());
        let s2 = db.add_slot(p, "new", j2).unwrap();
        assert_eq!(db.take_slot(p, j2).unwrap().unwrap().id, s2.id);
        db.release_slots(j1).unwrap();
        db.drop_slot(s2.id).unwrap();
        assert_eq!(db.slots(p).unwrap().len(), 1);
    }

    #[test]
    fn auto_setup_and_codex() {
        let db = Db::memory().unwrap();
        let (u, a, _) = owner(&db, 1, "t");
        db.auto_setup(u).unwrap();
        assert_eq!(db.next_job().unwrap().map(|j| j.id), None, "not connected yet");
        db.set_codex(u, &[("codex_state", text("connected")), ("codex_auth", text("sealed"))]).unwrap();
        assert_eq!(db.codex_auth(u).unwrap().as_deref(), Some("sealed"));
        db.auto_setup(u).unwrap();
        let j = db.next_job().unwrap().unwrap();
        assert_eq!((j.kind.as_str(), j.project_id), ("setup", a));
        assert_eq!(db.project(a).unwrap().unwrap().setup, "queued");
    }

    #[test]
    fn auto_setup_with_openrouter_needs_key_and_model() {
        let db = Db::memory().unwrap();
        let (u, a, _) = owner(&db, 1, "t");
        db.set_codex(u, &[("agent", text("openrouter")), ("openrouter_key", text("sealed"))]).unwrap();
        db.auto_setup(u).unwrap();
        assert_eq!(db.next_job().unwrap().map(|j| j.id), None, "no model yet");
        db.set_codex(u, &[("openrouter_model", text("anthropic/claude-x")), ("openrouter_context", int(200_000))]).unwrap();
        let row = db.agent(u).unwrap().unwrap();
        assert_eq!(row.provider, Provider::Openrouter);
        assert_eq!((row.model.as_deref(), row.context), (Some("anthropic/claude-x"), Some(200_000)));
        assert_eq!(db.agent_key(u, Provider::Openrouter).unwrap().as_deref(), Some("sealed"));
        db.auto_setup(u).unwrap();
        assert_eq!(db.next_job().unwrap().map(|j| j.project_id), Some(a));
    }

    #[test]
    fn auto_setup_with_claude_copilot_or_grok_needs_only_the_key() {
        for (agent, col) in [("claude", "claude_key"), ("copilot", "copilot_key"), ("grok", "grok_key")] {
            let db = Db::memory().unwrap();
            let (u, a, _) = owner(&db, 1, "t");
            db.set_codex(u, &[("agent", text(agent)), ("codex_state", text("connected"))]).unwrap();
            db.auto_setup(u).unwrap();
            assert_eq!(db.next_job().unwrap().map(|j| j.id), None, "{agent}: a Codex sign-in is not its key");
            db.set_codex(u, &[(col, text("sealed"))]).unwrap();
            let row = db.agent(u).unwrap().unwrap();
            assert_eq!((row.provider, row.model), (Provider::parse(Some(agent)), None), "no model: the CLI's default");
            assert_eq!(db.agent_key(u, row.provider).unwrap().as_deref(), Some("sealed"));
            assert_eq!(db.agent_key(u, Provider::Openrouter).unwrap(), None, "each provider has its own key");
            db.auto_setup(u).unwrap();
            assert_eq!(db.next_job().unwrap().map(|j| j.project_id), Some(a), "{agent}");
        }
    }

    #[test]
    fn open_adds_own_tables_to_the_uis_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("g.sqlite");
        let path = path.to_str().unwrap();
        assert!(Db::open(path).is_err(), "without the UI's tables");
        {
            let c = rusqlite::Connection::open(path).unwrap();
            // The UI's jobs table as an older UI made it: no owner column yet.
            c.execute_batch(UI_SCHEMA).unwrap();
        }
        let db = Db::open(path).unwrap();
        assert_eq!(db.step_count(1).unwrap(), 0);
        drop(db);
        let db = Db::open(path).unwrap();
        let mode: String = db.with(|c| c.query_row("pragma journal_mode", [], |r| r.get(0))).unwrap();
        assert_eq!(mode, "wal");
    }
}
