//! The queue loop: claims jobs up to the parallel limit, beats for the ones it runs, takes over jobs
//! whose orchestrator stopped beating, runs pending Codex sign-ins, delivers the outbox, publishes
//! `settings.orchestrator`, and drains on shutdown.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::task::{Id, JoinSet};

use crate::Ctx;

/// A running job whose orchestrator has not beaten for this long is taken over.
pub const STALE_SECS: i64 = 60;
/// A job taken over this often (a crash loop) fails instead of starting again.
pub const MAX_TAKEOVERS: i64 = 10;

/// What one job takes on the sandbox host at its peak (`PER_JOB` in capacity.ts).
const PER_JOB_CPUS: u32 = 4;
const PER_JOB_MEMORY_GB: f64 = 8.0;
/// Without a reading of the host.
const DEFAULT_PARALLEL: u32 = 2;

const TICK: Duration = Duration::from_secs(2);
const PUBLISH_EVERY: Duration = Duration::from_secs(10);
const OUTBOX_EVERY: Duration = Duration::from_secs(5);

pub struct Parallel {
    pub jobs: u32,
    /// For the log and Settings → Sandboxes.
    pub why: String,
}

/// `jobsFor`: jobs that fit a host of this size; at least one.
pub fn jobs_for(cpus: u32, memory_gb: f64) -> u32 {
    let by_cpu = cpus / PER_JOB_CPUS;
    let by_mem = (memory_gb / PER_JOB_MEMORY_GB).floor().max(0.0) as u32;
    by_cpu.min(by_mem).max(1)
}

/// `parallelJobs` from `src/server/capacity.ts`: MAX_PARALLEL_JOBS, else 4 CPUs and 8 GB per job of the host, else 2.
pub async fn parallel_jobs(ctx: &Ctx) -> Parallel {
    if let Some(max) = ctx.cfg.max_parallel {
        return Parallel { jobs: max, why: "MAX_PARALLEL_JOBS".into() };
    }
    match ctx.sb.capacity().await {
        Ok(None) => Parallel { jobs: DEFAULT_PARALLEL, why: "default: the sandbox provider does not report its size".into() },
        Ok(Some((cpus, mem))) if cpus > 0 && mem > 0.0 => Parallel {
            jobs: jobs_for(cpus, mem),
            why: format!("{cpus} CPUs and {} GB on the sandbox host, {PER_JOB_CPUS} CPUs and {PER_JOB_MEMORY_GB} GB per job", mem.round() as i64),
        },
        Ok(Some((cpus, mem))) => default_because(&format!("it reported {cpus} CPUs and {mem} GB")),
        Err(e) => default_because(&format!("{e:#}")),
    }
}

fn default_because(why: &str) -> Parallel {
    let why: String = why.chars().take(200).collect();
    Parallel { jobs: DEFAULT_PARALLEL, why: format!("default: could not read the sandbox host's size ({why})") }
}

fn ago(secs: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(secs)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The jobs this instance runs, by task.
struct Running {
    tasks: JoinSet<()>,
    jobs: HashMap<Id, i64>,
}

impl Running {
    fn ids(&self) -> Vec<i64> {
        self.jobs.values().copied().collect()
    }
    fn has(&self, id: i64) -> bool {
        self.jobs.values().any(|&j| j == id)
    }
    fn spawn(&mut self, ctx: &Arc<Ctx>, job: crate::db::Job) {
        let id = job.id;
        let handle = self.tasks.spawn(crate::jobs::process(ctx.clone(), job));
        self.jobs.insert(handle.id(), id);
    }
    /// Forgets the jobs whose task ended. A task that panicked loses its lease, so the job is
    /// picked up again (and fails once it was taken over `MAX_TAKEOVERS` times).
    fn reap(&mut self, ctx: &Ctx, instance: &str) {
        while let Some(done) = self.tasks.try_join_next_with_id() {
            let (task, panic) = match done {
                Ok((task, ())) => (task, None),
                Err(e) => (e.id(), Some(e.to_string())),
            };
            let Some(job) = self.jobs.remove(&task) else { continue };
            if let Some(p) = panic {
                crate::log("error", &format!("job {job} crashed the orchestrator's task: {p}"));
                let _ = ctx.db.with(|c| c.execute("update jobs set owner = null, heartbeat = null where id = ? and owner = ? and status = 'running'", rusqlite::params![job, instance]));
            }
        }
    }
}

/// Runs until `shutdown` is cancelled, then stops claiming, aborts its job tasks (their background
/// processes keep running), releases its leases and returns.
pub async fn run(ctx: Arc<Ctx>, parallel: Parallel, instance: String, shutdown: tokio_util::sync::CancellationToken) {
    let mut running = Running { tasks: JoinSet::new(), jobs: HashMap::new() };
    let mut logins: JoinSet<()> = JoinSet::new();
    let mut signing_in: HashMap<Id, i64> = HashMap::new();
    let mut last_publish: Option<Instant> = None;
    // Its own task: a UI that is down must not hold up the beats and the queue.
    let outbox = tokio::spawn({
        let (ctx, shutdown) = (ctx.clone(), shutdown.clone());
        async move {
            let mut every = tokio::time::interval(OUTBOX_EVERY);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = every.tick() => deliver_outbox(&ctx, &shutdown).await,
                }
            }
        }
    });
    let mut timer = tokio::time::interval(TICK);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = timer.tick() => {}
        }
        running.reap(&ctx, &instance);
        while let Some(done) = logins.try_join_next_with_id() {
            let task = match done {
                Ok((task, ())) => task,
                Err(e) => e.id(),
            };
            signing_in.remove(&task);
        }
        if let Err(e) = tick(&ctx, &parallel, &instance, &mut running) {
            crate::log("error", &format!("queue: {e:#}"));
        }
        // Codex sign-ins the UI started (WORKER=external): one per user at a time.
        match ctx.db.pending_logins() {
            Ok(users) => {
                let busy: HashSet<i64> = signing_in.values().copied().collect();
                for user in users.into_iter().filter(|u| !busy.contains(u)) {
                    let c = ctx.clone();
                    let handle = logins.spawn(async move {
                        if let Err(e) = crate::codex::run_login(&c, user).await {
                            crate::log("warn", &format!("Codex sign-in of user {user} failed: {e:#}"));
                        }
                    });
                    signing_in.insert(handle.id(), user);
                }
            }
            Err(e) => crate::log("error", &format!("pending Codex sign-ins: {e:#}")),
        }
        if last_publish.is_none_or(|t| t.elapsed() >= PUBLISH_EVERY) {
            last_publish = Some(Instant::now());
            let state = serde_json::json!({ "kind": ctx.sb.kind(), "parallel": parallel.jobs, "why": parallel.why, "instance": instance, "beat": crate::db::now() });
            if let Err(e) = ctx.db.set_setting("orchestrator", &state.to_string()) {
                crate::log("error", &format!("settings.orchestrator: {e:#}"));
            }
        }
    }
    // Drain: the tasks stop at their next await; their background processes keep running on the
    // sandbox host, and the next orchestrator attaches to them.
    let n = running.jobs.len();
    running.tasks.shutdown().await;
    logins.shutdown().await;
    let _ = outbox.await;
    match ctx.db.release_leases(&instance) {
        Ok(()) => crate::log("info", &format!("orchestrator {instance} stopped; {n} running jobs released for the next instance")),
        Err(e) => crate::log("error", &format!("could not release the leases of {instance}: {e:#}")),
    }
}

/// One pass: beat, take over stale jobs, claim queued ones.
fn tick(ctx: &Arc<Ctx>, parallel: &Parallel, instance: &str, running: &mut Running) -> anyhow::Result<()> {
    ctx.db.beat(instance, &running.ids())?;
    for job in ctx.db.adopt_stale(instance, &ago(STALE_SECS))? {
        if running.has(job.id) {
            continue;
        }
        crate::log("info", &format!("job {} was running when its orchestrator stopped; picking it up where it was", job.id));
        running.spawn(ctx, job);
    }
    while (running.jobs.len() as u32) < parallel.jobs {
        let Some(job) = ctx.db.next_job()? else { break };
        if running.has(job.id) {
            break;
        }
        if !ctx.db.claim_job(job.id, instance)? {
            continue;
        }
        let job = ctx.db.job(job.id)?.unwrap_or(job);
        running.spawn(ctx, job);
    }
    Ok(())
}

/// Delivers due outbox items; a failed one waits longer each time.
async fn deliver_outbox(ctx: &Ctx, shutdown: &tokio_util::sync::CancellationToken) {
    let items = match ctx.db.outbox_due() {
        Ok(items) => items,
        Err(e) => return crate::log("error", &format!("outbox: {e:#}")),
    };
    for item in items {
        if shutdown.is_cancelled() {
            return;
        }
        let payload = serde_json::from_str::<serde_json::Value>(&item.payload).unwrap_or_default();
        let field = |k: &str| payload.get(k).and_then(|j| j.as_i64());
        // The client would retry for 20 minutes per call; the outbox retries anyway, so a short try per
        // pass keeps the loop moving while the UI is down.
        let ui = ctx.ui.clone().with_patience(Duration::from_secs(10));
        let sent = match (item.kind.as_str(), field("jobId"), field("runId")) {
            ("ended", Some(job), _) => tokio::select! {
                r = ui.ended(job) => r,
                _ = shutdown.cancelled() => return,
            },
            // A failed run's report: the run already says failed; the UI completes its check and comment.
            ("report", Some(job), Some(run)) => tokio::select! {
                r = ui.report(run, job, None, &[]) => r,
                _ = shutdown.cancelled() => return,
            },
            (other, ..) => Err(anyhow::anyhow!("unusable outbox item {other}: {}", item.payload)),
        };
        let r = match sent {
            Ok(()) => ctx.db.outbox_done(item.id),
            Err(e) => {
                crate::log("warn", &format!("outbox {} ({}): {e:#}", item.id, item.kind));
                ctx.db.outbox_failed(item.id)
            }
        };
        if let Err(e) = r {
            crate::log("error", &format!("outbox {}: {e:#}", item.id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_for_host_size() {
        assert_eq!(jobs_for(16, 64.0), 4);
        assert_eq!(jobs_for(16, 15.9), 1);
        assert_eq!(jobs_for(2, 4.0), 1, "at least one");
        assert_eq!(jobs_for(48, 128.0), 12);
    }
}
