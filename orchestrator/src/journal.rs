//! A job's journal: what lets another orchestrator pick a job up where it was.
//!
//! A job's code runs again from the top after a takeover. `step` returns a finished step's stored result
//! instead of running it again; `long` attaches to the background process an earlier orchestrator
//! started under the same key instead of starting it again. Keys must be the same on every run of the
//! code (e.g. `"a1.tester"` for attempt 1's tester).

use std::future::Future;
use std::time::Duration;

use anyhow::Result;
use serde::{de::DeserializeOwned, Serialize};

use crate::db::{Db, Proc};
use crate::sandbox::{wait_long, LongResult, Sandboxes, Tick, WaitOpts};

#[derive(Clone)]
pub struct Journal {
    db: Db,
    pub job_id: i64,
    /// How often `long` looks at its process; 2 s.
    poll: Duration,
}

pub struct Long<'a> {
    pub timeout: Duration,
    pub cancelled: &'a (dyn Fn() -> bool + Send + Sync),
    pub on_tick: Option<Tick<'a>>,
}

impl Journal {
    pub fn new(db: Db, job_id: i64) -> Journal {
        Journal { db, job_id, poll: Duration::from_secs(2) }
    }

    /// For tests: poll background processes this often.
    pub fn with_poll(mut self, poll: Duration) -> Journal {
        self.poll = poll;
        self
    }

    /// True when the job has no stored step yet (a fresh job, or one the TypeScript worker started).
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.db.step_count(self.job_id)? == 0)
    }

    /// True when `key` has a stored result.
    pub fn step_done(&self, key: &str) -> Result<bool> {
        Ok(self.db.step_get(self.job_id, key)?.is_some())
    }

    /// The stored result of `key`, or runs `f` and stores its result. An error is not stored, so the
    /// step runs again on the next takeover.
    pub async fn step<T, F, Fut>(&self, key: &str, f: F) -> Result<T>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        if let Some(stored) = self.db.step_get(self.job_id, key)? {
            return serde_json::from_str(&stored).map_err(|e| anyhow::anyhow!("journal step {key} of job {}: {e}", self.job_id));
        }
        let value = f().await?;
        self.db.step_put(self.job_id, key, &serde_json::to_string(&value)?)?;
        Ok(value)
    }

    /// Runs `command` in the background under `key`, or attaches to the process stored under `key`.
    /// The timeout counts from the process's first start. A finished result is stored like a step's.
    pub async fn long(&self, sb: &dyn Sandboxes, sandbox_id: &str, key: &str, command: &str, opts: Long<'_>) -> Result<LongResult> {
        if let Some(stored) = self.db.step_get(self.job_id, key)? {
            return serde_json::from_str(&stored).map_err(|e| anyhow::anyhow!("journal step {key} of job {}: {e}", self.job_id));
        }
        let proc = match self.db.proc_get(self.job_id, key)? {
            // Confirmed, or past its time (a long outage, its records on the host may be gone): never
            // started again. The wait below takes the result of one that ran, stops one still running,
            // and ends a missing one without an exit code.
            Some(p) if p.acked || deadline_of(&p, opts.timeout) < chrono::Utc::now() => p,
            // Stored, but the orchestrator stopped before the provider confirmed the start: start it
            // again under the same handle, which does nothing when it did start.
            Some(p) => self.start(sb, key, command, p).await?,
            None => {
                // Cancelled while the caller prepared: the command never starts (as `runLong`).
                if (opts.cancelled)() {
                    let r = LongResult { exit_code: None, tail: String::new(), timed_out: true };
                    self.db.step_put(self.job_id, key, &serde_json::to_string(&r)?)?;
                    return Ok(r);
                }
                // Stored before the start, so a takeover never starts a second process for this key.
                let p = Proc { sandbox_id: sandbox_id.to_string(), pid: crate::sandbox::new_handle(), started: crate::db::now(), acked: false };
                self.db.proc_put(self.job_id, key, &p)?;
                self.start(sb, key, command, p).await?
            }
        };
        let deadline = deadline_of(&proc, opts.timeout);
        let r = wait_long(sb, &proc.sandbox_id, proc.pid, WaitOpts { deadline, cancelled: opts.cancelled, on_tick: opts.on_tick, poll: self.poll }).await?;
        self.db.step_put(self.job_id, key, &serde_json::to_string(&r)?)?;
        Ok(r)
    }

    async fn start(&self, sb: &dyn Sandboxes, key: &str, command: &str, p: Proc) -> Result<Proc> {
        let pid = sb.start_as(&p.sandbox_id, p.pid, command).await?;
        let p = Proc { pid, acked: true, ..p };
        self.db.proc_put(self.job_id, key, &p)?;
        Ok(p)
    }
}

/// When a process's time runs out: its timeout from its first start.
fn deadline_of(p: &Proc, timeout: Duration) -> chrono::DateTime<chrono::Utc> {
    let started = chrono::DateTime::parse_from_rfc3339(&p.started).map(|t| t.with_timezone(&chrono::Utc)).unwrap_or_else(|_| chrono::Utc::now());
    chrono::Duration::from_std(timeout).ok().and_then(|d| started.checked_add_signed(d)).unwrap_or(chrono::DateTime::<chrono::Utc>::MAX_UTC)
}
