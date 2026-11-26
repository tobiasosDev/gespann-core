//! The job steps (setup, suggest, PR run, repair) on top of the journal, so another orchestrator can pick a job up where it was.
//!
//! The code of a job runs again from the top after a takeover. Every step that changes state runs
//! under a journal key, so on the second pass it returns what it returned the first time instead of
//! running again; the long command that was running is attached to, never started again or killed.
//! Reads (result files, progress.json) run again, they change nothing.

mod boxes;
mod repair;
mod run;
mod setup;
mod suggest;

use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::db::{self, Job, Project};
use crate::journal::Journal;
use crate::sandbox::Sandboxes;
use crate::{worker, Ctx};

/// One job on its way: what every step needs.
pub(crate) struct Cx<'a> {
    pub ctx: &'a Ctx,
    pub jr: Journal,
    pub job: &'a Job,
}

impl Cx<'_> {
    /// A line for the job log, which the UI and MCP show.
    pub fn log(&self, line: &str) {
        let _ = self.ctx.db.append_log(self.job.id, line);
    }

    /// A log line written once under `key`: after a takeover it does not claim again that a step starts.
    pub async fn note(&self, key: &str, line: &str) {
        let _ = self
            .jr
            .step(key, || async move {
                self.log(line);
                Ok(())
            })
            .await;
    }

    pub fn sb(&self) -> &dyn Sandboxes {
        &*self.ctx.sb
    }

    /// The job was cancelled, or a newer push superseded its run: what it still runs stops, and it reports nothing.
    pub fn stopped(&self) -> bool {
        let db = &self.ctx.db;
        db.job(self.job.id).ok().flatten().is_some_and(|j| j.status == "cancelled")
            || self.job.run_id.is_some_and(|id| db.run(id).ok().flatten().is_some_and(|r| r.status == "cancelled"))
    }
}

/// The first `n` characters (`slice(0, n)`).
pub(crate) fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The last `n` characters (`slice(-n)`).
pub(crate) fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

/// A command that never gets cancelled.
pub(crate) fn never() -> bool {
    false
}

enum Flow {
    /// The job's work is done: free its sandboxes, end it, tell the UI.
    Done,
    /// The job already ended (cancelled before it started); nothing more to do.
    Ended,
}

/// `processJob`: runs one job to its end (done, failed or cancelled) and tells the UI it ended.
/// Called for a freshly claimed job and, after a takeover, for a job another orchestrator ran.
/// Never panics on job errors: they end the job as failed, as in TypeScript.
pub async fn process(ctx: Arc<Ctx>, job: Job) {
    let ctx = &*ctx;
    let p = match ctx.db.project(job.project_id) {
        Ok(Some(p)) => p,
        Ok(None) => {
            let _ = ctx.db.end_job(job.id, "failed", Some("project gone"));
            return;
        }
        // The lease runs out and another pass picks the job up again.
        Err(e) => return crate::log("error", &format!("job {}: could not read its project: {e:#}", job.id)),
    };
    let cx = Cx { ctx, jr: Journal::new(ctx.db.clone(), job.id), job: &job };
    match body(&cx, &p).await {
        Ok(Flow::Ended) => {}
        Ok(Flow::Done) => {
            // Stopped and freed while the job still counts as running, so no other job takes a sandbox mid-stop.
            release_slots(&cx).await;
            finish(&cx, if cx.stopped() { "cancelled" } else { "done" }, None);
        }
        Err(e) => failed(&cx, &p, &format!("{e:#}")).await,
    }
}

async fn body(cx: &Cx<'_>, p: &Project) -> Result<Flow> {
    let (ctx, job) = (cx.ctx, cx.job);
    if job.restarts > worker::MAX_TAKEOVERS {
        return Err(anyhow!("the orchestrator restarted during this job {} times; it does not start again", job.restarts));
    }
    // A job an attempt left before it stored anything: a run takes down the copy it may have left up.
    // Decided once and kept, so later takeovers decide the same.
    let was_empty = cx.jr.is_empty()?;
    let legacy = cx.jr.step("takeover", || async move { Ok(was_empty && job.restarts > 0) }).await?;
    match job.kind.as_str() {
        "login" => Err(anyhow!("Codex sign-in moved to Settings")),
        "setup" => {
            admit(cx).await?;
            setup::setup(cx, p, "", false).await?;
            Ok(Flow::Done)
        }
        "suggest" => {
            admit(cx).await?;
            suggest::suggest(cx, p).await?;
            Ok(Flow::Done)
        }
        _ => {
            let run = job.run_id.map(|id| ctx.db.run(id)).transpose()?.flatten().ok_or_else(|| anyhow!("run gone"))?;
            // A run whose test started goes on to its own stop, which ends what still runs of it.
            let started = ctx.db.step_get(job.id, "started")?.is_some();
            if run.status == "cancelled" && !started {
                ctx.db.end_job(job.id, "cancelled", None)?;
                return Ok(Flow::Ended);
            }
            // A PR merged or closed while its run waited (also before gespann heard of it) is not tested.
            // When GitHub does not answer, the run goes ahead as before. Asked once: after a takeover the test has started.
            let run_id = run.id;
            let pull = cx.jr.step("pull", || async move { Ok(ctx.ui.pull(run_id).await.unwrap_or(None)) }).await?;
            // Only this run: an answer that is already stale must not cancel a run queued after a reopen.
            // Reopened (or GitHub silent) when the UI asked again: the run goes ahead.
            if let Some(pr) = pull.filter(|pr| pr.state != "open" && !started) {
                if ctx.ui.skip_closed(run.id).await? {
                    cx.log(&format!("skipped: the PR was {} before its test started", if pr.merged { "merged" } else { "closed" }));
                    ctx.db.end_job(job.id, "cancelled", None)?;
                    return Ok(Flow::Ended);
                }
            }
            // The other checks first: a run whose CI is red or still running never asks the server module or
            // takes a sandbox. "go" is kept: after a takeover the test has started.
            let step = match ctx.db.step_get(job.id, "checks")? {
                Some(_) => "go".to_string(),
                None => ctx.ui.await_checks(run.id, job.id).await?,
            };
            match step.as_str() {
                "go" => {
                    ctx.db.step_put(job.id, "checks", "\"go\"")?;
                    // Passed its CI checks: no longer shown as waiting for them, also after a restart.
                    ctx.db.with(|c| c.execute("update jobs set not_before = null where id = ?", [job.id]))?;
                }
                "later" => {
                    ctx.db.forget_deferred(job.id)?;
                    return Ok(Flow::Ended);
                }
                _ => {
                    ctx.db.end_unstarted(job.id)?;
                    return Ok(Flow::Ended);
                }
            }
            let refused = admit(cx).await.err();
            // Closed or superseded while GitHub (or the server module) answered.
            if !started && ctx.db.run(run.id)?.is_some_and(|r| r.status == "cancelled") {
                ctx.db.end_job(job.id, "cancelled", None)?;
                return Ok(Flow::Ended);
            }
            if let Some(err) = refused {
                return Err(err);
            }
            run::verify_run(cx, p, &run, legacy).await?;
            Ok(Flow::Done)
        }
    }
}

/// The end of a job that threw: it fails (or counts as cancelled when it was stopped), and a run
/// reports the failure on its PR.
async fn failed(cx: &Cx<'_>, p: &Project, message: &str) {
    let (ctx, job) = (cx.ctx, cx.job);
    cx.log(&format!("✗ {message}"));
    release_slots(cx).await;
    if job.kind == "run" && cx.stopped() {
        return finish(cx, "cancelled", None);
    }
    let error = cut(message, 4000);
    if job.kind == "setup" && ctx.db.project(p.id).ok().flatten().is_some_and(|p| p.setup == "queued") {
        let _ = ctx.db.update_project(p.id, &[("setup", db::text("failed")), ("setup_error", db::text(error.clone()))]);
    }
    // The run's failure is stored before the job ends: an orchestrator that stops in between leaves no
    // run in progress. The report follows the end, as in TypeScript, so a UI that is down adds no
    // sandbox time.
    let failed_run = match (job.kind == "run", job.run_id) {
        (true, Some(run_id)) => ctx.db.run(run_id).ok().flatten().filter(|r| r.status != "done"),
        _ => None,
    };
    if let Some(run) = &failed_run {
        let _ = ctx.db.update_run(run.id, &[("status", db::text("failed")), ("outcome", db::text("FAIL")), ("error", db::text(error.clone())), ("finished", db::text(db::now()))]);
    }
    // The report goes into the outbox with the job's end, so an orchestrator that stops right after
    // still reports it, and a UI that is down adds no sandbox time.
    let report = failed_run.map(|run| serde_json::json!({ "runId": run.id, "jobId": job.id }).to_string());
    if let Err(e) = ctx.db.finish_job_and(job.id, "failed", Some(&error), report.as_deref().map(|r| ("report", r))) {
        crate::log("error", &format!("job {}: could not end it: {e:#}", job.id));
    }
}

/// Errors unless the server module lets this job start. Asked once per job: a job that runs already
/// is not asked again after a takeover.
async fn admit(cx: &Cx<'_>) -> Result<()> {
    let (ui, id) = (&cx.ctx.ui, cx.job.id);
    cx.jr
        .step("admit", || async move {
            match ui.admit(id).await {
                Ok(None) => Ok(()),
                Ok(Some(refused)) => Err(anyhow!("not started: {refused}")),
                Err(e) => Err(anyhow!("could not check this job: {e:#}")),
            }
        })
        .await
}

/// Ends the job and queues "ended" for the UI in one transaction, so the server module hears of every
/// job that held a sandbox, also when the UI is down right now or the orchestrator stops in between.
fn finish(cx: &Cx<'_>, status: &str, error: Option<&str>) {
    if let Err(e) = cx.ctx.db.finish_job(cx.job.id, status, error) {
        crate::log("error", &format!("job {}: could not end it: {e:#}", cx.job.id));
    }
}

/// Frees the job's sandboxes, stopped first, also when the job failed halfway.
async fn release_slots(cx: &Cx<'_>) {
    let db = &cx.ctx.db;
    for s in db.slots(cx.job.project_id).unwrap_or_default().into_iter().filter(|s| s.job_id == Some(cx.job.id)) {
        let _ = cx.sb().stop(&s.sandbox_id).await;
    }
    let _ = db.release_slots(cx.job.id);
}

/// The worker spawns `process` on the runtime, so its future has to be Send.
#[allow(dead_code)]
fn process_is_send(ctx: Arc<Ctx>, job: Job) {
    fn send<T: Send>(_: &T) {}
    send(&process(ctx, job));
}
