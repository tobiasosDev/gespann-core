//! A job picked up again by another orchestrator resumes where it was: with a fake sandbox provider
//! that records every call and a stub of the UI's internal API.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use gespann_orchestrator::config::Config;
use gespann_orchestrator::db::{now, Db};
use gespann_orchestrator::sandbox::{CommandResult, CreateOpts, ProcState, ProcessStatus, Sandboxes};
use gespann_orchestrator::ui::Ui;
use gespann_orchestrator::{codex, jobs, Ctx, Locks};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SECRET: &str = "test-session-secret-of-some-length-0123";
const TOKEN: &str = "0123456789abcdef01234567";
const SB: &str = "/sb/1";

#[derive(Default)]
struct State {
    next_pid: u64,
    /// Every background command: (pid, command).
    starts: Vec<(u64, String)>,
    kills: Vec<u64>,
    stops: usize,
    execs: Vec<String>,
    recordings: usize,
    files: HashMap<String, Vec<u8>>,
    /// The fake tester runs until this is set.
    tester_done: bool,
    /// Status polls of the tester's process.
    tester_polls: usize,
    /// Processes another worker left, by pid: running or not.
    foreign: HashMap<u64, bool>,
}

#[derive(Default)]
struct FakeSandboxes {
    s: Mutex<State>,
}

impl FakeSandboxes {
    fn state<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.s.lock().unwrap())
    }
    fn started(&self, needle: &str) -> usize {
        self.state(|s| s.starts.iter().filter(|(_, c)| c.contains(needle)).count())
    }
    fn executed(&self, needle: &str) -> usize {
        self.state(|s| s.execs.iter().filter(|c| c.contains(needle)).count())
    }
}

fn is_tester(command: &str) -> bool {
    command.contains("codex exec") && command.contains("/work/prompt.txt")
}

fn ok(stdout: &str) -> CommandResult {
    CommandResult { exit_code: Some(0), stdout: stdout.into(), stderr: String::new(), timed_out: false }
}

#[async_trait]
impl Sandboxes for FakeSandboxes {
    fn kind(&self) -> &str {
        "fake"
    }
    async fn create(&self, _opts: CreateOpts) -> Result<String> {
        Ok(SB.into())
    }
    async fn exists(&self, _id: &str) -> Result<bool> {
        Ok(true)
    }
    fn home(&self, id: &str) -> String {
        id.into()
    }
    async fn ensure_running(&self, _id: &str) -> Result<()> {
        Ok(())
    }
    async fn keep_alive(&self, _id: &str) -> Result<()> {
        Ok(())
    }
    async fn stop(&self, _id: &str) -> Result<()> {
        self.state(|s| s.stops += 1);
        Ok(())
    }
    async fn remove(&self, _id: &str) -> Result<()> {
        Ok(())
    }
    async fn exec(&self, _id: &str, command: &str, _timeout: u64) -> Result<CommandResult> {
        self.state(|s| s.execs.push(command.into()));
        Ok(if command.contains("gespann verify recipe") {
            ok("{\"ok\":true,\"timeout\":30,\"prompt\":null}\n")
        } else if command.contains("test -f") && command.contains("state.json") {
            CommandResult { exit_code: Some(1), ..ok("") }
        } else if command.contains("rev-parse HEAD") {
            ok(&format!("{}\n", "c".repeat(40)))
        } else {
            ok("")
        })
    }
    async fn start(&self, _id: &str, command: &str) -> Result<u64> {
        Ok(self.state(|s| {
            s.next_pid += 1;
            s.starts.push((s.next_pid, command.into()));
            s.next_pid
        }))
    }
    async fn status(&self, _id: &str, pid: u64, _tail: usize) -> Result<ProcessStatus> {
        self.state(|s| {
            let exited = |stdout: &str| ProcessStatus { state: ProcState::Exited, exit_code: Some(0), stdout: stdout.into(), stderr: String::new() };
            if let Some(running) = s.foreign.get(&pid) {
                return Ok(if *running { ProcessStatus { state: ProcState::Running, exit_code: None, stdout: String::new(), stderr: String::new() } } else { exited("") });
            }
            let command = s.starts.iter().find(|(p, _)| *p == pid).map(|(_, c)| c.clone()).unwrap_or_default();
            Ok(if is_tester(&command) {
                s.tester_polls += 1;
                if s.tester_done {
                    exited("")
                } else {
                    ProcessStatus { state: ProcState::Running, exit_code: None, stdout: String::new(), stderr: String::new() }
                }
            } else if command.contains("verify prepare") {
                exited("copy coming up\n{\"ok\":true,\"url\":\"http://127.0.0.1:4000/\",\"run\":\"r\"}\n")
            } else if command.contains("verify finish") {
                exited("{\"outcome\":\"PASS\",\"teardownErrors\":[]}\n")
            } else {
                exited("")
            })
        })
    }
    async fn kill(&self, _id: &str, pid: u64) -> Result<()> {
        self.state(|s| s.kills.push(pid));
        Ok(())
    }
    async fn read_file(&self, _id: &str, path: &str) -> Result<Option<String>> {
        if path.ends_with("/work/result.json") {
            let judged = serde_json::json!({
                "verdict": {"verdict": "PASS", "summary": "works", "checks": [{"expect": "e", "observed": "o", "result": "pass", "proof": ["a.png"]}], "proof": ["a.png"]},
                "outcome": "PASS", "problems": []
            });
            return Ok(Some(serde_json::json!({ "judged": judged, "outcome": "PASS" }).to_string()));
        }
        Ok(self.state(|s| s.files.get(path).map(|b| String::from_utf8_lossy(b).into_owned())))
    }
    async fn write_file(&self, _id: &str, path: &str, content: &[u8]) -> Result<()> {
        self.state(|s| s.files.insert(path.into(), content.to_vec()));
        Ok(())
    }
    async fn download(&self, _id: &str, _path: &str) -> Result<Vec<u8>> {
        Ok(b"tgz".to_vec())
    }
    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        Ok(None)
    }
    async fn start_recording(&self, _id: &str, _file: &str) -> Result<()> {
        self.state(|s| s.recordings += 1);
        Ok(())
    }
    async fn stop_recording(&self, _id: &str) -> Result<()> {
        Ok(())
    }
}

/// The UI's internal API with canned answers; records each path it was asked.
async fn ui_stub(refuse: Option<&'static str>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                while buf.len() < head_end + length {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let path = head.split(' ').nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(path.clone());
                let body = if path.ends_with("/admit") {
                    serde_json::json!({ "refused": refuse }).to_string()
                } else if path.ends_with("/pull") {
                    r#"{"pull":{"state":"open","merged":false,"head":"h"}}"#.to_string()
                } else if path.ends_with("/await-checks") {
                    r#"{"step":"go"}"#.to_string()
                } else if path.ends_with("/git-token") {
                    r#"{"token":"ghs_test"}"#.to_string()
                } else if path.ends_with("/context") {
                    r##"{"prText":"# Title\n\nBody\n","issues":[],"issuesMd":"","unread":null}"##.to_string()
                } else {
                    "{}".to_string()
                };
                let res = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(res.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (url, seen)
}

struct World {
    ctx: Arc<Ctx>,
    sb: Arc<FakeSandboxes>,
    seen: Arc<Mutex<Vec<String>>>,
    _data: tempfile::TempDir,
}

async fn world(kind: &str, refuse: Option<&'static str>) -> World {
    let (url, seen) = ui_stub(refuse).await;
    let db = Db::memory().unwrap();
    let auth = serde_json::json!({ "last_refresh": chrono::Utc::now().to_rfc3339(), "tokens": {} }).to_string();
    let sealed = codex::seal(SECRET, &auth);
    let t = now();
    db.with(|c| {
        c.execute("insert into users (id, github_id, login, created, codex_state, codex_auth) values (1, 1, 'tobi', ?1, 'connected', ?2)", [&t, &sealed])?;
        c.execute("insert into projects (id, owner_id, installation_id, repo, repo_id, default_branch, setup, recipe, created) values (1, 1, 9, 'acme/shop', 11, 'main', 'ready', 'version: 1', ?1)", [&t])?;
        c.execute(
            "insert into runs (id, project_id, pr, head, base, base_ref, status, token, check_run_id, created) values (1, 1, 4, ?1, ?2, 'main', 'queued', ?3, 77, ?4)",
            [&"a".repeat(40), &"b".repeat(40), &TOKEN.to_string(), &t],
        )?;
        c.execute("insert into jobs (id, project_id, kind, status, run_id, created, started) values (1, 1, ?1, 'running', 1, ?2, ?2)", [kind, &t])?;
        Ok(())
    })
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let sb = Arc::new(FakeSandboxes::default());
    let cfg = Config { base_url: "https://gespann.test".into(), ui_url: url.clone(), data_dir: data.path().to_string_lossy().into(), session_secret: SECRET.into(), gespann_ref: "main".into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db, sb: sb.clone(), ui: Ui::new(&url, SECRET).with_patience(Duration::from_secs(5)), cfg, locks: Locks::default() });
    World { ctx, sb, seen, _data: data }
}

async fn until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < Duration::from_secs(secs), "timed out waiting until {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn outbox_ended(w: &World) -> usize {
    w.ctx.db.outbox_due().unwrap().iter().filter(|o| o.kind == "ended" && o.payload.contains("\"jobId\":1")).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_taken_over_mid_test_attaches_to_its_tester_and_repeats_nothing() {
    let w = world("run", None).await;
    let job = w.ctx.db.job(1).unwrap().unwrap();
    let first = tokio::spawn(jobs::process(w.ctx.clone(), job));
    until("the tester runs", 60, || w.sb.started("codex exec") == 1).await;
    // The orchestrator stores the process right after it started; then it dies.
    tokio::time::sleep(Duration::from_millis(500)).await;
    first.abort();
    let _ = first.await;
    assert_eq!(w.sb.state(|s| s.stops), 0, "the sandbox keeps running while its tester works");

    // The next orchestrator takes the job over.
    w.ctx.db.with(|c| c.execute("update jobs set restarts = 1 where id = 1", [])).unwrap();
    let job = w.ctx.db.job(1).unwrap().unwrap();
    assert_eq!(job.status, "running");
    let polls = w.sb.state(|s| s.tester_polls);
    let second = tokio::spawn(jobs::process(w.ctx.clone(), job));
    until("the new orchestrator watches the tester", 60, || w.sb.state(|s| s.tester_polls) > polls).await;
    assert_eq!(w.sb.state(|s| s.stops), 0, "the takeover does not stop the sandbox under the tester");
    w.sb.state(|s| s.tester_done = true);
    tokio::time::timeout(Duration::from_secs(60), second).await.expect("the job ends once the tester exited").unwrap();

    let dir = format!("{SB}/gespann/runs/0123456789ab");
    assert_eq!(w.sb.started("codex exec"), 1, "the tester started once");
    assert_eq!(w.sb.state(|s| s.kills.clone()), Vec::<u64>::new(), "nothing was killed");
    assert_eq!(w.sb.started("verify prepare"), 1, "the copy came up once");
    assert_eq!(w.sb.started("verify finish"), 1, "finish ran once");
    assert_eq!(w.sb.started("npm prefix -g"), 1, "gespann was installed once");
    assert_eq!(w.sb.executed(&format!("rm -rf {dir} && mkdir")), 1, "the attempt's dir was made once");
    assert_eq!(w.sb.executed("merge --quiet"), 1, "the PR was merged into the checkout once");
    assert_eq!(w.sb.executed("gespann verify prompt tester"), 1, "the prompt was written once");
    assert_eq!(w.sb.state(|s| s.recordings), 1, "one recording");

    let job = w.ctx.db.job(1).unwrap().unwrap();
    assert_eq!(job.status, "done");
    let run = w.ctx.db.run(1).unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(run.outcome.as_deref(), Some("PASS"));
    let reports = w.seen.lock().unwrap().iter().filter(|p| p.ends_with("/report")).count();
    assert_eq!(reports, 1, "the PR got one report");
    let admits = w.seen.lock().unwrap().iter().filter(|p| p.ends_with("/admit")).count();
    assert_eq!(admits, 1, "the server module was asked once");
    let checks = w.seen.lock().unwrap().iter().filter(|p| p.ends_with("/await-checks")).count();
    assert_eq!(checks, 1, "the PR's other checks were asked once: after the takeover the test had started");
    assert_eq!(outbox_ended(&w), 1, "the UI hears once that the job ended");
    let progress: serde_json::Value = serde_json::from_str(run.progress.as_deref().unwrap()).unwrap();
    for stage in ["sandbox", "copy", "read", "verdict"] {
        assert!(progress["at"][stage].is_string(), "progress has the {stage} stage: {progress}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_superseded_while_no_orchestrator_watched_stops_its_tester_and_copy_on_takeover() {
    let w = world("run", None).await;
    let job = w.ctx.db.job(1).unwrap().unwrap();
    let first = tokio::spawn(jobs::process(w.ctx.clone(), job));
    until("the tester runs", 60, || w.sb.started("codex exec") == 1).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    first.abort();
    let _ = first.await;
    // A newer push supersedes the run while the orchestrator is down.
    w.ctx.db.with(|c| c.execute("update runs set status = 'cancelled' where id = 1", [])).unwrap();
    w.ctx.db.with(|c| c.execute("update jobs set restarts = 1 where id = 1", [])).unwrap();
    let tester = w.sb.state(|s| s.starts.iter().find(|(_, c)| c.contains("codex exec")).map(|(p, _)| *p)).unwrap();
    let job = w.ctx.db.job(1).unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(60), jobs::process(w.ctx.clone(), job)).await.expect("ends");
    assert_eq!(w.sb.state(|s| s.kills.clone()), vec![tester], "the tester that still ran is stopped");
    assert_eq!(w.sb.started("--wait 0"), 1, "its copy is taken down");
    assert_eq!(w.sb.started("codex exec"), 1, "no second tester");
    assert_eq!(w.ctx.db.job(1).unwrap().unwrap().status, "cancelled");
    assert_eq!(outbox_ended(&w), 1, "its sandbox time still counts");
    assert_eq!(w.seen.lock().unwrap().iter().filter(|p| p.ends_with("/report")).count(), 0, "the newer push's run reports");
    assert!(w.sb.executed("rm -f ~/.codex/auth.json") >= 1, "the cut-off tester's sign-in leaves the sandbox");
    assert!(w.ctx.db.step_get(1, "a1.signin.done").unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_the_typescript_worker_left_stops_its_running_commands_first() {
    let w = world("login", None).await;
    w.sb.state(|s| {
        s.foreign.insert(41, true);
        s.foreign.insert(42, false);
    });
    w.ctx.db.with(|c| c.execute(r#"update jobs set restarts = 1, procs = '[["/sb/1",41],["/sb/1",42]]' where id = 1"#, [])).unwrap();
    let job = w.ctx.db.job(1).unwrap().unwrap();
    jobs::process(w.ctx.clone(), job).await;
    assert_eq!(w.sb.state(|s| s.kills.clone()), vec![41], "only the command that still ran is stopped");
    let job = w.ctx.db.job(1).unwrap().unwrap();
    assert_eq!(job.procs, "[]");
    assert_eq!(job.status, "failed");
    assert_eq!(outbox_ended(&w), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_the_server_module_refuses_fails_without_a_sandbox() {
    let w = world("setup", Some("the plan allows 2 jobs at once")).await;
    let job = w.ctx.db.job(1).unwrap().unwrap();
    jobs::process(w.ctx.clone(), job).await;
    let error: Option<String> = w.ctx.db.with(|c| c.query_row("select error from jobs where id = 1", [], |r| r.get(0))).unwrap();
    assert_eq!(error.as_deref(), Some("not started: the plan allows 2 jobs at once"));
    assert_eq!(w.ctx.db.job(1).unwrap().unwrap().status, "failed");
    assert!(w.sb.state(|s| s.starts.is_empty() && s.execs.is_empty()), "no sandbox work");
    assert_eq!(outbox_ended(&w), 1);
}
