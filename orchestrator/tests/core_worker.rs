//! The queue loop's parts that need no job steps: host size, takeover of a stale job, Codex sign-in,
//! outbox, `settings.orchestrator`, and the drain on shutdown. Also `with_codex` and `with_agent` around a Codex step.

mod core_fake;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_fake::Fake;
use gespann_orchestrator::agent_auth::keep_grok;
use gespann_orchestrator::codex::{give_back, open, seal, with_agent, with_codex, Agent, Provider};
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
    let agent = Agent { provider: Provider::Openrouter, model: Some("anthropic/claude-x".into()), context: None, auth: false };
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

#[tokio::test]
async fn with_agent_on_claude_copilot_or_grok_puts_that_key_in_the_sandbox_only_while_the_step_runs() {
    for (provider, agent, col, key, missing) in [
        (Provider::Claude, "claude", "claude_key", "sk-ant-oat01-secret", "Add your Anthropic API key or Claude token in Settings first"),
        (Provider::Copilot, "copilot", "copilot_key", "github_pat_secret", "Add your GitHub token for Copilot in Settings first"),
        (Provider::Grok, "grok", "grok_key", "xai-secret", "Add your xAI API key in Settings first"),
    ] {
        let sb = Arc::new(Fake::default());
        let c = ctx(sb.clone(), "http://127.0.0.1:1", None);
        let (u, _) = user(&c.db);
        // No model: the CLI's default model, which needs no choice in Settings.
        let a = Agent { provider, model: None, context: None, auth: false };
        let j = Journal::new(c.db.clone(), 9);
        // An OpenRouter key is not this agent's key.
        c.db.set_codex(u, &[("agent", text(agent)), ("openrouter_key", text(seal(SECRET, "sk-or-v1-other")))]).unwrap();
        let err = with_agent(&c, &j, "a1.tester", u, "box", &a, || async { Ok(()) }).await.unwrap_err();
        assert!(err.to_string().starts_with(missing), "{agent}: {err}");
        c.db.set_codex(u, &[(col, text(seal(SECRET, key)))]).unwrap();
        let file = "/home/user/.gespann-agent-key";
        with_agent(&c, &j, "a1.tester", u, "box", &a, || async {
            assert_eq!(sb.file(file).as_deref(), Some(key), "{agent}: the key is in the sandbox while the step starts");
            assert_eq!(sb.file("/home/user/.gespann-openrouter-key"), None);
            assert_eq!(sb.file("/home/user/.codex/auth.json"), None, "no Codex sign-in");
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(sb.file(file), None, "{agent}: removed after the step");
        assert!(sb.execs.lock().unwrap().iter().all(|e| !e.contains(key)), "{agent}: the key never appears in a command");
        // give_back (a cancelled run taken over mid-test) removes it too.
        sb.files.lock().unwrap().insert(file.to_string(), key.to_string());
        give_back(&c, &Journal::new(c.db.clone(), 12), u, "box").await.unwrap();
        assert_eq!(sb.file(file), None, "{agent}: give_back removes the key");
    }
}

#[tokio::test]
async fn grok_signed_in_with_xai_gets_its_auth_json_only_while_the_step_runs_and_keeps_a_refresh() {
    let sb = Arc::new(Fake::default());
    let c = ctx(sb.clone(), "http://127.0.0.1:1", None);
    let (u, _) = user(&c.db);
    // Valid for 5 more hours: longer than any step, so no refresh at xAI.
    let at = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339();
    let now = chrono::Utc::now().timestamp_millis();
    let auth = |created: i64, key: &str| serde_json::json!({ "https://auth.x.ai::c": { "key": key, "create_time": at(created), "expires_at": at(created + 5 * 3_600_000 + 60_000), "refresh_token": "r1", "email": "t@example.com", "user_id": "u-1", "oidc_client_id": "c" } }).to_string();
    let stored = auth(now, "a1");
    c.db.set_codex(u, &[("agent", text("grok")), ("grok_auth", text(seal(SECRET, &stored)))]).unwrap();
    let row = c.db.agent(u).unwrap().unwrap();
    assert!(row.auth, "signed in, no key: the sign-in runs Grok");
    let a = Agent { provider: Provider::Grok, model: None, context: None, auth: true };
    let file = "/home/user/.grok/auth.json";
    let refreshed = auth(now + 1000, "a2");
    with_agent(&c, &Journal::new(c.db.clone(), 9), "a1.tester", u, "box", &a, || async {
        assert_eq!(sb.file(file).as_deref(), Some(stored.as_str()), "the sign-in is in the sandbox while the step runs");
        assert_eq!(sb.file("/home/user/.gespann-agent-key"), None, "no key file");
        // Grok refreshed its sign-in during the step.
        sb.files.lock().unwrap().insert(file.to_string(), refreshed.clone());
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(sb.file(file), None, "removed after the step");
    assert_eq!(open(SECRET, &c.db.grok_auth(u).unwrap().unwrap()).unwrap(), refreshed, "the refreshed copy is kept");
    assert!(sb.execs.lock().unwrap().iter().all(|e| !e.contains("a1") && !e.contains("r1")), "the sign-in never appears in a command");
    // An older copy never replaces a newer one.
    with_agent(&c, &Journal::new(c.db.clone(), 10), "a1.tester", u, "box", &a, || async {
        sb.files.lock().unwrap().insert(file.to_string(), stored.clone());
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(open(SECRET, &c.db.grok_auth(u).unwrap().unwrap()).unwrap(), refreshed);
    // A newer copy of another xAI account (an old job after the owner switched accounts) is not kept either.
    let other = serde_json::json!({ "https://auth.x.ai::c": { "key": "b1", "user_id": "someone-else", "create_time": at(now + 9000), "expires_at": at(now + 9_000_000), "refresh_token": "r9", "oidc_client_id": "c" } }).to_string();
    let mine = |created: i64| serde_json::json!({ "https://auth.x.ai::c": { "key": "a3", "user_id": "u-1", "create_time": at(created), "expires_at": at(created + 5 * 3_600_000 + 60_000), "refresh_token": "r3", "oidc_client_id": "c" } }).to_string();
    c.db.set_codex(u, &[("grok_auth", text(seal(SECRET, &mine(now))))]).unwrap();
    assert!(!keep_grok(&c, u, &other).unwrap());
    let no_id = serde_json::json!({ "https://auth.x.ai::c": { "key": "b2", "email": "x@example.com", "create_time": at(now + 9000), "expires_at": at(now + 9_000_000), "refresh_token": "r8", "oidc_client_id": "c" } }).to_string();
    assert!(!keep_grok(&c, u, &no_id).unwrap(), "a copy without a user id is not kept");
    // A refresh the CLI made during a run that was cancelled and taken over is kept by give_back.
    sb.files.lock().unwrap().insert(file.to_string(), mine(now + 5000));
    give_back(&c, &Journal::new(c.db.clone(), 12), u, "box").await.unwrap();
    assert_eq!(open(SECRET, &c.db.grok_auth(u).unwrap().unwrap()).unwrap(), mine(now + 5000));
    assert_eq!(sb.file(file), None, "and removed");
    // Signed out meanwhile: nothing comes back.
    c.db.set_codex(u, &[("grok_auth", rusqlite::types::Value::Null)]).unwrap();
    assert!(!keep_grok(&c, u, &mine(now + 6000)).unwrap());
    assert_eq!(c.db.grok_auth(u).unwrap(), None);
    // An API key wins over the sign-in.
    c.db.set_codex(u, &[("grok_key", text(seal(SECRET, "xai-k")))]).unwrap();
    assert!(!c.db.agent(u).unwrap().unwrap().auth);
}

#[test]
fn copilot_and_grok_sign_ins_wait_for_the_orchestrator() {
    let db = Db::memory().unwrap();
    let (u, _) = user(&db);
    assert!(db.pending_agent_logins().unwrap().is_empty());
    // Only one of them started: the other's state is still null.
    db.set_codex(u, &[("grok_login_state", text("pending"))]).unwrap();
    assert_eq!(db.pending_agent_logins().unwrap(), vec![(u, Provider::Grok)]);
    db.set_codex(u, &[("copilot_login_state", text("pending")), ("grok_login_state", text("pending"))]).unwrap();
    assert_eq!(db.pending_agent_logins().unwrap(), vec![(u, Provider::Copilot), (u, Provider::Grok)]);
    db.set_codex(u, &[("copilot_login_state", text("connected"))]).unwrap();
    assert_eq!(db.pending_agent_logins().unwrap(), vec![(u, Provider::Grok)]);
}

