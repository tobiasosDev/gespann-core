//! The queue loop's parts that need no job steps: host size, takeover of a stale job, Codex sign-in,
//! outbox, `settings.orchestrator`, and the drain on shutdown. Also `with_codex` and `with_agent` around a Codex step.

mod core_fake;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_fake::Fake;
use gespann_orchestrator::codex::{open, seal, with_agent, with_codex, Agent, Provider};
use gespann_orchestrator::config::Config;
use gespann_orchestrator::db::{now, text, Db};
use gespann_orchestrator::journal::Journal;
use gespann_orchestrator::sandbox::pool::Pool;
use gespann_orchestrator::ui::Ui;
use gespann_orchestrator::{worker, Ctx, Locks};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SECRET: &str = "a-session-secret-of-at-least-32-characters";

fn ctx(sb: Arc<Fake>, ui: &str, max_parallel: Option<u32>) -> Arc<Ctx> {
    let cfg = Config { session_secret: SECRET.into(), max_parallel, ..Default::default() };
    let pool = Pool::single(sb, worker::Parallel { jobs: 0, why: "test".into() });
    Arc::new(Ctx { db: Db::memory().unwrap(), pool, ui: Ui::new(ui, SECRET), cfg, locks: Locks::default() })
}

fn user(db: &Db) -> (i64, i64) {
    db.with(|c| {
        c.execute("insert into users (github_id, login, created) values (1, 't', ?)", [now()])?;
        let u = c.last_insert_rowid();
        c.execute("insert into projects (owner_id, installation_id, repo, repo_id, default_branch, created) values (?, 9, 'o/a', 1, 'main', ?)", rusqlite::params![u, now()])?;
        Ok((u, c.last_insert_rowid()))
    })
    .unwrap()
}

/// A UI that answers every request with `{}` and remembers the request lines.
async fn ui_server() -> (String, Arc<Mutex<Vec<String>>>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let mut buf = vec![0u8; 8192];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
            seen2.lock().unwrap().push(head);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await;
        }
    });
    (base, seen)
}

#[tokio::test]
async fn parallel_jobs_from_config_or_host() {
    let sb = Arc::new(Fake::default());
    let p = worker::parallel_jobs(Some(3), sb.as_ref()).await;
    assert_eq!((p.jobs, p.why.as_str()), (3, "MAX_PARALLEL_JOBS"));
    let p = worker::parallel_jobs(None, sb.as_ref()).await;
    assert_eq!((p.jobs, p.why.as_str()), (2, "default: the sandbox provider does not report its size"));
    *sb.capacity.lock().unwrap() = Some((16, 62.7));
    let p = worker::parallel_jobs(None, sb.as_ref()).await;
    assert_eq!((p.jobs, p.why.as_str()), (4, "16 CPUs and 63 GB on the sandbox host, 4 CPUs and 8 GB per job"));
    *sb.capacity.lock().unwrap() = Some((0, 8.0));
    let p = worker::parallel_jobs(None, sb.as_ref()).await;
    assert_eq!((p.jobs, p.why.as_str()), (2, "default: could not read the sandbox host's size (it reported 0 CPUs and 8 GB)"));
}

#[tokio::test]
async fn a_stale_job_of_another_instance_is_adopted() {
    let c = ctx(Arc::new(Fake::default()), "http://127.0.0.1:1", None);
    let (_, p) = user(&c.db);
    let j = c.db.enqueue(p, "run", None).unwrap();
    assert!(c.db.claim_job(j, "old-instance").unwrap());
    let before = |secs: i64| (chrono::Utc::now() - chrono::Duration::seconds(secs)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    assert!(c.db.adopt_stale("new-instance", &before(worker::STALE_SECS)).unwrap().is_empty(), "the old one still beats");
    // The old instance died 61 s ago.
    c.db.with(|x| x.execute("update jobs set heartbeat = ? where id = ?", rusqlite::params![before(61), j])).unwrap();
    let got = c.db.adopt_stale("new-instance", &before(worker::STALE_SECS)).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].id, got[0].owner.as_deref(), got[0].restarts), (j, Some("new-instance"), 1));
}

#[tokio::test]
async fn the_loop_signs_in_delivers_the_outbox_publishes_and_drains() {
    let sb = Arc::new(Fake::default());
    let (base, seen) = ui_server().await;
    let c = ctx(sb.clone(), &base, Some(2));
    let (u, p) = user(&c.db);
    // A Codex sign-in the UI started, and a job end the UI has not heard of yet.
    c.db.set_codex(u, &[("codex_state", text("pending"))]).unwrap();
    c.db.outbox_add("ended", r#"{"jobId":42}"#).unwrap();
    // A running job this instance holds (not taken over, so no job steps run): its lease goes on shutdown.
    let j = c.db.enqueue(p, "run", None).unwrap();
    c.db.claim_job(j, "me").unwrap();
    let auth = r#"{"tokens":{"account_id":"acc"},"last_refresh":"2026-11-26T08:00:00Z"}"#;
    sb.set_file("/home/user/.codex/auth.json", auth);
    *sb.output.lock().unwrap() = "Open https://auth.openai.com/codex/device and enter AB12-CD345".into();
    *sb.exec_output.lock().unwrap() = "Logged in using ChatGPT\n".into();
    sb.finished.store(true, Ordering::SeqCst);

    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(c.clone(), "me".into(), stop.clone()));
    let mut connected = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        connected = c.db.codex_state(u).unwrap().as_deref() == Some("connected");
        if connected && c.db.outbox_due().unwrap().is_empty() {
            break;
        }
    }
    assert!(connected, "signed in");
    assert_eq!(open(SECRET, &c.db.codex_auth(u).unwrap().unwrap()).unwrap(), auth);
    assert_eq!(sb.started.lock().unwrap().as_slice(), ["codex login --device-auth 2>&1"]);
    assert_eq!(sb.removed.lock().unwrap().as_slice(), ["gespann-login-1-x1"], "the login sandbox is removed");
    assert!(seen.lock().unwrap().iter().any(|l| l.starts_with("POST /internal/jobs/42/ended ")));
    assert!(c.db.outbox_due().unwrap().is_empty());
    let state: serde_json::Value = serde_json::from_str(&c.db.setting("orchestrator").unwrap().unwrap()).unwrap();
    assert_eq!((state["kind"].as_str(), state["parallel"].as_u64(), state["instance"].as_str()), (Some("fake"), Some(0), Some("me")));
    // A setup was queued for the project that never had one.
    let setups: i64 = c.db.with(|x| x.query_row("select count(*) from jobs where kind = 'setup' and status = 'queued'", [], |r| r.get(0))).unwrap();
    assert_eq!(setups, 1);

    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();
    assert_eq!(c.db.job(j).unwrap().unwrap().owner, None, "lease released");
}

#[tokio::test]
async fn with_codex_writes_once_and_keeps_the_refreshed_sign_in() {
    let sb = Arc::new(Fake::default());
    let c = ctx(sb.clone(), "http://127.0.0.1:1", None);
    let (u, _) = user(&c.db);
    let fresh = |at: &str| format!(r#"{{"tokens":{{"account_id":"acc"}},"last_refresh":"{at}"}}"#);
    let first = fresh(&now());
    c.db.set_codex(u, &[("codex_state", text("connected")), ("codex_auth", text(seal(SECRET, &first)))]).unwrap();
    let j = Journal::new(c.db.clone(), 9);
    // Job tasks are spawned: `with_codex` has to be usable inside them.
    fn assert_send<T: Send>(_: T) {}
    assert_send(with_codex(&c, &j, "send", u, "box", || async { Ok(()) }));
    let file = "/home/user/.codex/auth.json";
    let refreshed = fresh(&(chrono::Utc::now() + chrono::Duration::seconds(5)).to_rfc3339());
    let got = with_codex(&c, &j, "a1.tester", u, "box", || async {
        assert_eq!(sb.file(file).as_deref(), Some(first.as_str()), "the sign-in is in the sandbox while the step runs");
        // Codex refreshed it in place.
        sb.set_file(file, &refreshed);
        Ok(7)
    })
    .await
    .unwrap();
    assert_eq!(got, 7);
    assert_eq!(open(SECRET, &c.db.codex_auth(u).unwrap().unwrap()).unwrap(), refreshed, "kept");
    assert_eq!(sb.file(file), None, "removed after the step");
    assert_eq!(sb.writes.lock().unwrap().len(), 1);
    // A takeover runs the same code again: the sign-in is not written again.
    sb.set_file(file, &refreshed);
    with_codex(&c, &j, "a1.tester", u, "box", || async { Ok(()) }).await.unwrap();
    assert_eq!(sb.writes.lock().unwrap().len(), 1);
    assert_eq!(sb.file(file).as_deref(), Some(refreshed.as_str()), "a finished step leaves the sign-in of the step running now alone");
    // Without a sign-in.
    c.db.set_codex(u, &[("codex_auth", rusqlite::types::Value::Null)]).unwrap();
    let err = with_codex(&c, &Journal::new(c.db.clone(), 10), "x", u, "box", || async { Ok(()) }).await.unwrap_err();
    assert!(err.to_string().starts_with("Connect Codex in Settings first"));
}

#[tokio::test]
async fn with_agent_on_openrouter_puts_the_key_in_the_sandbox_only_while_the_step_runs() {
    let sb = Arc::new(Fake::default());
    let c = ctx(sb.clone(), "http://127.0.0.1:1", None);
    let (u, _) = user(&c.db);
    let agent = Agent { provider: Provider::Openrouter, model: Some("anthropic/claude-x".into()), context: None };
    let j = Journal::new(c.db.clone(), 9);
    let err = with_agent(&c, &j, "a1.tester", u, "box", &agent, || async { Ok(()) }).await.unwrap_err();
    assert!(err.to_string().starts_with("Add your OpenRouter key in Settings first"), "{err}");
    let none = Agent { model: None, ..agent.clone() };
    let err = with_agent(&c, &j, "a1.tester", u, "box", &none, || async { Ok(()) }).await.unwrap_err();
    assert!(err.to_string().starts_with("Choose an OpenRouter model in Settings first"), "{err}");
    c.db.set_codex(u, &[("agent", text("openrouter")), ("openrouter_key", text(seal(SECRET, "sk-or-v1-secret")))]).unwrap();
    let file = "/home/user/.gespann-openrouter-key";
    let got = with_agent(&c, &j, "a1.tester", u, "box", &agent, || async {
        assert_eq!(sb.file(file).as_deref(), Some("sk-or-v1-secret"), "the key is in the sandbox while the step runs");
        assert_eq!(sb.file("/home/user/.codex/auth.json"), None, "no Codex sign-in");
        Ok(7)
    })
    .await
    .unwrap();
    assert_eq!(got, 7);
    assert_eq!(sb.file(file), None, "removed after the step");
    assert!(sb.execs.lock().unwrap().iter().all(|e| !e.contains("sk-or-v1-secret")), "the key never appears in a command");
    // A takeover after the step finished replays it without writing the key again.
    let writes = sb.writes.lock().unwrap().len();
    with_agent(&c, &j, "a1.tester", u, "box", &agent, || async { Ok(()) }).await.unwrap();
    assert_eq!(sb.writes.lock().unwrap().len(), writes);
    // A takeover while Codex still runs: its command deleted the key file at its start, and the key
    // is not written again for the process the takeover attaches to.
    let jt = Journal::new(c.db.clone(), 11);
    let _ = with_agent(&c, &jt, "a1.tester", u, "box", &agent, || async { anyhow::bail!("orchestrator stopped") as anyhow::Result<()> }).await;
    let writes = sb.writes.lock().unwrap().len();
    with_agent(&c, &jt, "a1.tester", u, "box", &agent, || async {
        assert_eq!(sb.file(file), None, "no key file while the attached Codex runs");
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(sb.writes.lock().unwrap().len(), writes, "not written again on a takeover");
    // A failed step removes the key too.
    let err = with_agent(&c, &Journal::new(c.db.clone(), 10), "x", u, "box", &agent, || async { anyhow::bail!("codex failed") as anyhow::Result<()> }).await.unwrap_err();
    assert_eq!(err.to_string(), "codex failed");
    assert_eq!(sb.file(file), None);
}
