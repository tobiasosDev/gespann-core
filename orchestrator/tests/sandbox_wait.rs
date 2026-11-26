//! `wait_long` against a fake provider whose `status` answers come from a script.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::FutureExt;
use gespann_orchestrator::sandbox::*;

/// One `status` answer: Err for a failing call; the last one repeats.
type Answer = Result<ProcessStatus, String>;

struct Fake {
    answers: Mutex<VecDeque<Answer>>,
    kills: Mutex<Vec<u64>>,
    calls: Mutex<usize>,
}

impl Fake {
    fn new(answers: Vec<Answer>) -> Fake {
        Fake { answers: Mutex::new(answers.into()), kills: Mutex::new(vec![]), calls: Mutex::new(0) }
    }

    fn killed(&self) -> Vec<u64> {
        self.kills.lock().unwrap().clone()
    }
}

fn st(state: ProcState, exit_code: Option<i32>, stdout: &str, stderr: &str) -> Answer {
    Ok(ProcessStatus { state, exit_code, stdout: stdout.into(), stderr: stderr.into() })
}

#[async_trait]
impl Sandboxes for Fake {
    fn kind(&self) -> &str {
        "fake"
    }
    async fn create(&self, _: CreateOpts) -> Result<String> {
        unimplemented!()
    }
    async fn exists(&self, _: &str) -> Result<bool> {
        Ok(true)
    }
    fn home(&self, id: &str) -> String {
        id.into()
    }
    async fn ensure_running(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn keep_alive(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn stop(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn remove(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn exec(&self, _: &str, _: &str, _: u64) -> Result<CommandResult> {
        unimplemented!()
    }
    async fn start(&self, _: &str, _: &str) -> Result<u64> {
        Ok(7)
    }
    async fn status(&self, _: &str, pid: u64, _: usize) -> Result<ProcessStatus> {
        assert_eq!(pid, 7);
        *self.calls.lock().unwrap() += 1;
        let mut a = self.answers.lock().unwrap();
        let next = if a.len() > 1 { a.pop_front().unwrap() } else { a[0].clone() };
        match next {
            Ok(s) => Ok(s),
            Err(e) => bail!(e),
        }
    }
    async fn kill(&self, _: &str, pid: u64) -> Result<()> {
        self.kills.lock().unwrap().push(pid);
        Ok(())
    }
    async fn read_file(&self, _: &str, _: &str) -> Result<Option<String>> {
        Ok(None)
    }
    async fn write_file(&self, _: &str, _: &str, _: &[u8]) -> Result<()> {
        Ok(())
    }
    async fn download(&self, _: &str, _: &str) -> Result<Vec<u8>> {
        Ok(vec![])
    }
    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        Ok(None)
    }
    async fn start_recording(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn stop_recording(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

fn never() -> bool {
    false
}

fn opts(cancelled: &(dyn Fn() -> bool + Send + Sync), secs: i64) -> WaitOpts<'_> {
    WaitOpts { deadline: chrono::Utc::now() + chrono::Duration::seconds(secs), cancelled, on_tick: None, poll: Duration::from_millis(5) }
}

#[tokio::test]
async fn finishes_with_exit_code_and_tail() {
    let fake = Fake::new(vec![st(ProcState::Running, None, "half", ""), st(ProcState::Exited, Some(3), "out", "err")]);
    let ticks = Mutex::new(Vec::<String>::new());
    let tick = |t: String| -> BoxFuture<'_, ()> {
        ticks.lock().unwrap().push(t);
        async {}.boxed()
    };
    let mut o = opts(&never, 60);
    o.on_tick = Some(&tick);
    let r = wait_long(&fake, "box", 7, o).await.unwrap();
    assert_eq!(r, LongResult { exit_code: Some(3), tail: "out\nerr".into(), timed_out: false });
    assert_eq!(*ticks.lock().unwrap(), vec!["half".to_string(), "out\nerr".to_string()]);
    assert!(fake.killed().is_empty());
}

#[tokio::test]
async fn kills_on_deadline() {
    let fake = Fake::new(vec![st(ProcState::Running, None, "still", "")]);
    let mut o = opts(&never, 0);
    o.deadline = chrono::Utc::now() + chrono::Duration::milliseconds(50);
    let r = wait_long(&fake, "box", 7, o).await.unwrap();
    assert_eq!(r, LongResult { exit_code: None, tail: "still".into(), timed_out: true });
    assert_eq!(fake.killed(), vec![7]);
}

#[tokio::test]
async fn kills_on_cancel() {
    let fake = Fake::new(vec![st(ProcState::Running, None, "", "")]);
    let flag = AtomicBool::new(false);
    let cancelled = || flag.swap(true, Ordering::SeqCst);
    let r = wait_long(&fake, "box", 7, opts(&cancelled, 60)).await.unwrap();
    assert!(r.timed_out && r.exit_code.is_none());
    assert_eq!(fake.killed(), vec![7]);
    assert_eq!(*fake.calls.lock().unwrap(), 2);
}

#[tokio::test]
async fn lost_ends_without_exit_code() {
    let fake = Fake::new(vec![st(ProcState::Lost, None, "partial", "")]);
    let r = wait_long(&fake, "box", 7, opts(&never, 60)).await.unwrap();
    assert_eq!(r, LongResult { exit_code: None, tail: "partial".into(), timed_out: false });
    assert!(fake.killed().is_empty());
}

#[tokio::test]
async fn survives_failing_status_calls() {
    let fake = Fake::new(vec![
        st(ProcState::Running, None, "a", ""),
        Err("ssh host: Connection reset".into()),
        Err("ssh host: Connection reset".into()),
        Err("ssh host: Connection reset".into()),
        st(ProcState::Exited, Some(0), "done", ""),
    ]);
    let r = wait_long(&fake, "box", 7, opts(&never, 60)).await.unwrap();
    assert_eq!(r, LongResult { exit_code: Some(0), tail: "done".into(), timed_out: false });
}

#[tokio::test]
async fn run_long_does_not_start_when_cancelled() {
    let fake = Fake::new(vec![st(ProcState::Exited, Some(0), "", "")]);
    let yes = || true;
    let r = run_long(&fake, "box", "true", opts(&yes, 60)).await.unwrap();
    assert!(r.timed_out);
    assert_eq!(*fake.calls.lock().unwrap(), 0);
}
