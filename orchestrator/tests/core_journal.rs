//! The journal: a step runs once; a long command started under a key is attached to again after a
//! takeover instead of started again, and its timeout counts from the first start.

mod core_fake;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use core_fake::Fake;
use gespann_orchestrator::db::{Db, Proc};
use gespann_orchestrator::journal::{Journal, Long};

fn never() -> bool {
    false
}

fn assert_send<T: Send>(_: T) {}

#[test]
fn futures_are_send() {
    // Job tasks are spawned: `long` has to be usable inside them.
    let j = Journal::new(Db::memory().unwrap(), 1);
    let sb = Fake::default();
    assert_send(j.long(&sb, "box", "k", "c", Long { timeout: Duration::from_secs(1), cancelled: &never, on_tick: None }));
    assert_send(j.step("k", || async { Ok(1) }));
}

#[tokio::test]
async fn step_runs_once() {
    let j = Journal::new(Db::memory().unwrap(), 7);
    let runs = AtomicU64::new(0);
    let f = || async {
        runs.fetch_add(1, Ordering::SeqCst);
        Ok::<_, anyhow::Error>(vec!["a".to_string()])
    };
    assert_eq!(j.step("s", f).await.unwrap(), vec!["a"]);
    let again: Vec<String> = j.step("s", || async { anyhow::bail!("must not run") }).await.unwrap();
    assert_eq!(again, vec!["a"]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // An error is not stored: the step runs again.
    assert!(j.step::<i32, _, _>("e", || async { anyhow::bail!("no") }).await.is_err());
    assert_eq!(j.step("e", || async { Ok(3) }).await.unwrap(), 3);
}

#[tokio::test]
async fn long_attaches_to_the_process_after_a_takeover() {
    let db = Db::memory().unwrap();
    let sb = Fake::default();
    let j = Journal::new(db.clone(), 1).with_poll(Duration::from_millis(5));
    let opts = || Long { timeout: Duration::from_secs(3600), cancelled: &never, on_tick: None };
    // The orchestrator stops mid-wait: the future is dropped.
    let first = tokio::time::timeout(Duration::from_millis(60), j.long(&sb, "box", "a1.tester", "run it", opts())).await;
    assert!(first.is_err(), "still running");
    assert_eq!(sb.starts.load(Ordering::SeqCst), 1);
    let p = db.proc_get(1, "a1.tester").unwrap().unwrap();
    assert_eq!((p.sandbox_id.as_str(), p.pid), ("box", 100));
    // The next orchestrator runs the job again from the top.
    sb.finished.store(true, Ordering::SeqCst);
    let j2 = Journal::new(db.clone(), 1).with_poll(Duration::from_millis(5));
    let r = j2.long(&sb, "box", "a1.tester", "run it", opts()).await.unwrap();
    assert_eq!(sb.starts.load(Ordering::SeqCst), 1, "attached, not started again");
    assert_eq!(r.exit_code, Some(0));
    assert!(r.tail.contains("out of 100"));
    assert!(sb.polled.lock().unwrap().iter().all(|&pid| pid == 100));
    // Finished: the stored result, without looking at the sandbox.
    let n = sb.polled.lock().unwrap().len();
    assert_eq!(j2.long(&sb, "box", "a1.tester", "run it", opts()).await.unwrap(), r);
    assert_eq!(sb.polled.lock().unwrap().len(), n);
}

#[tokio::test]
async fn long_timeout_counts_from_the_first_start() {
    let db = Db::memory().unwrap();
    let sb = Fake::default();
    let j = Journal::new(db.clone(), 2).with_poll(Duration::from_millis(5));
    let opts = || Long { timeout: Duration::from_secs(30 * 60), cancelled: &never, on_tick: None };
    let _ = tokio::time::timeout(Duration::from_millis(30), j.long(&sb, "box", "verdict", "judge", opts())).await;
    // The first start was 40 minutes ago (the orchestrator was down that long).
    let p = db.proc_get(2, "verdict").unwrap().unwrap();
    let old = (chrono::Utc::now() - chrono::Duration::minutes(40)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    db.proc_put(2, "verdict", &Proc { started: old, ..p }).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(5), j.long(&sb, "box", "verdict", "judge", opts())).await.expect("ends at once").unwrap();
    assert!(r.timed_out);
    assert_eq!(*sb.killed.lock().unwrap(), vec![100]);
    assert_eq!(sb.starts.load(Ordering::SeqCst), 1);
    // A timed-out result is stored too.
    assert!(db.step_get(2, "verdict").unwrap().is_some());
}

#[tokio::test]
async fn long_starts_a_stored_but_unconfirmed_process_again_under_its_handle() {
    // The orchestrator stopped while the provider answered the start: the handle is stored, unconfirmed.
    let db = Db::memory().unwrap();
    db.proc_put(3, "a1.tester", &Proc { sandbox_id: "box".into(), pid: 42, started: gespann_orchestrator::db::now(), acked: false }).unwrap();
    let sb = Fake::default();
    sb.finished.store(true, Ordering::SeqCst);
    let j = Journal::new(db.clone(), 3).with_poll(Duration::from_millis(5));
    let r = j.long(&sb, "box", "a1.tester", "run it", Long { timeout: Duration::from_secs(60), cancelled: &never, on_tick: None }).await.unwrap();
    assert_eq!(r.exit_code, Some(0));
    assert_eq!(sb.starts.load(Ordering::SeqCst), 1, "started once, through start_as");
    assert!(db.proc_get(3, "a1.tester").unwrap().unwrap().acked);
}

#[tokio::test]
async fn an_unconfirmed_process_past_its_time_is_not_started_again() {
    let db = Db::memory().unwrap();
    let old = (chrono::Utc::now() - chrono::Duration::days(3)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    db.proc_put(4, "a1.tester", &Proc { sandbox_id: "box".into(), pid: 42, started: old, acked: false }).unwrap();
    let sb = Fake::default();
    let j = Journal::new(db.clone(), 4);
    let j = j.with_poll(Duration::from_millis(5));
    // Still running: stopped, timed out.
    let r = j.long(&sb, "box", "a1.tester", "run it", Long { timeout: Duration::from_secs(3600), cancelled: &never, on_tick: None }).await.unwrap();
    assert!(r.timed_out);
    assert_eq!(*sb.killed.lock().unwrap(), vec![42]);
    assert_eq!(sb.starts.load(Ordering::SeqCst), 0);
    // One that finished during the outage keeps its result.
    let old = (chrono::Utc::now() - chrono::Duration::days(3)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    db.proc_put(4, "a2.tester", &Proc { sandbox_id: "box".into(), pid: 43, started: old, acked: false }).unwrap();
    sb.finished.store(true, Ordering::SeqCst);
    let r = j.long(&sb, "box", "a2.tester", "run it", Long { timeout: Duration::from_secs(3600), cancelled: &never, on_tick: None }).await.unwrap();
    assert_eq!((r.exit_code, r.timed_out), (Some(0), false));
    assert_eq!(sb.starts.load(Ordering::SeqCst), 0);
}
