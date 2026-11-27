//! Several sandbox providers: each user's jobs go to their provider, each provider runs its own number
//! of jobs at once, and a full one holds up nobody on another.

mod core_fake;

use std::sync::Arc;
use std::time::{Duration, Instant};

use core_fake::Fake;
use gespann_orchestrator::config::Config;
use gespann_orchestrator::db::{now, Db};
use gespann_orchestrator::sandbox::pool::{Pool, Provider};
use gespann_orchestrator::sandbox::Platform;
use gespann_orchestrator::ui::Ui;
use gespann_orchestrator::{worker, Ctx, Locks};

const SECRET: &str = "a-session-secret-of-at-least-32-characters";

/// A UI that takes every request and never answers: each job stays at its first UI call, so it keeps
/// its place on its provider for as long as the test looks.
async fn silent_ui() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = l.accept().await {
            held.push(s);
        }
    });
    base
}

fn provider(sb: Arc<Fake>, jobs: u32, logins: &[&str], default: bool) -> Provider {
    Provider { spec: "fake".into(), platform: Platform::Linux, sb, parallel: worker::Parallel { jobs, why: "test".into() }, logins: logins.iter().map(|s| s.to_string()).collect(), default }
}

/// A user with `projects` projects, each with a queued setup (one setup per project runs at a time).
fn user_with_setups(db: &Db, id: i64, login: &str, projects: i64) {
    db.with(|c| {
        c.execute("insert into users (id, github_id, login, created) values (?, ?, ?, ?)", rusqlite::params![id, id, login, now()])?;
        for n in 0..projects {
            c.execute(
                "insert into projects (owner_id, installation_id, repo, repo_id, default_branch, created) values (?, 9, ?, ?, 'main', ?)",
                rusqlite::params![id, format!("{login}/r{n}"), id * 100 + n, now()],
            )?;
            let p = c.last_insert_rowid();
            c.execute("insert into jobs (project_id, kind, status, created) values (?, 'setup', 'queued', ?)", rusqlite::params![p, now()])?;
        }
        Ok(())
    })
    .unwrap();
}

fn running_of(db: &Db, owner: i64) -> i64 {
    db.with(|c| c.query_row("select count(*) from jobs j join projects p on p.id = j.project_id where j.status = 'running' and p.owner_id = ?", [owner], |r| r.get(0))).unwrap()
}

async fn settle(db: &Db, want: &[(i64, i64)]) {
    let start = Instant::now();
    loop {
        let got: Vec<(i64, i64)> = want.iter().map(|(o, _)| (*o, running_of(db, *o))).collect();
        if got == want || start.elapsed() > Duration::from_secs(8) {
            assert_eq!(got, want, "running jobs per owner");
            // And it stays there: nothing more starts.
            tokio::time::sleep(Duration::from_secs(3)).await;
            let after: Vec<(i64, i64)> = want.iter().map(|(o, _)| (*o, running_of(db, *o))).collect();
            assert_eq!(after, want, "running jobs per owner, a few passes later");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn each_provider_runs_its_own_number_and_a_full_one_holds_up_no_one_else() {
    let ui = silent_ui().await;
    let db = Db::memory().unwrap();
    // tobi is on the CI server (room for 1), everyone else on the sandbox service (room for 3).
    user_with_setups(&db, 1, "Tobi", 3);
    user_with_setups(&db, 2, "acme", 2);
    user_with_setups(&db, 3, "globex", 2);
    let (ci, service) = (Arc::new(Fake::default()), Arc::new(Fake::default()));
    let pool = Pool::new(vec![provider(ci, 1, &["tobi"], false), provider(service, 3, &[], true)]);
    let cfg = Config { session_secret: SECRET.into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db: db.clone(), pool, ui: Ui::new(&ui, SECRET), cfg, locks: Locks::default() });
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(ctx.clone(), "me".into(), stop.clone()));

    // tobi's provider is full after one; acme and globex share the service's 3, oldest jobs first.
    settle(&db, &[(1, 1), (2, 2), (3, 1)]).await;

    let state: serde_json::Value = serde_json::from_str(&db.setting("orchestrator").unwrap().unwrap()).unwrap();
    assert_eq!(state["parallel"].as_u64(), Some(3), "the default provider's number at the top, as Settings read it before");
    let providers = state["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 2);
    assert_eq!((providers[0]["parallel"].as_u64(), providers[0]["logins"][0].as_str(), providers[0]["default"].as_bool()), (Some(1), Some("tobi"), Some(false)));
    assert_eq!((providers[1]["parallel"].as_u64(), providers[1]["default"].as_bool()), (Some(3), Some(true)));

    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();
}

#[tokio::test]
async fn without_a_default_provider_only_named_users_get_sandboxes() {
    let ui = silent_ui().await;
    let db = Db::memory().unwrap();
    user_with_setups(&db, 1, "tobi", 2);
    user_with_setups(&db, 2, "acme", 2);
    let pool = Pool::new(vec![provider(Arc::new(Fake::default()), 5, &["tobi"], false)]);
    let cfg = Config { session_secret: SECRET.into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db: db.clone(), pool, ui: Ui::new(&ui, SECRET), cfg, locks: Locks::default() });
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(ctx.clone(), "me".into(), stop.clone()));

    settle(&db, &[(1, 2), (2, 0)]).await;

    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();
}

#[tokio::test]
async fn a_long_queue_for_a_full_provider_hides_no_job_of_another() {
    let ui = silent_ui().await;
    let db = Db::memory().unwrap();
    // More waiting jobs for the full CI server than the worker reads in one page, then one customer job.
    user_with_setups(&db, 1, "tobi", 600);
    user_with_setups(&db, 2, "acme", 1);
    let pool = Pool::new(vec![provider(Arc::new(Fake::default()), 1, &["tobi"], false), provider(Arc::new(Fake::default()), 3, &[], true)]);
    let cfg = Config { session_secret: SECRET.into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db: db.clone(), pool, ui: Ui::new(&ui, SECRET), cfg, locks: Locks::default() });
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(ctx.clone(), "me".into(), stop.clone()));

    settle(&db, &[(1, 1), (2, 1)]).await;

    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();
}

fn running_on(db: &Db, platform: &str) -> i64 {
    db.with(|c| c.query_row("select count(*) from jobs j join projects p on p.id = j.project_id where j.status = 'running' and p.platform = ?", [platform], |r| r.get(0))).unwrap()
}

#[tokio::test]
async fn macos_projects_go_to_the_macos_provider_and_wait_without_one() {
    let ui = silent_ui().await;
    let db = Db::memory().unwrap();
    // acme has two web projects and three iOS apps; the Mac pool has room for one.
    user_with_setups(&db, 1, "acme", 5);
    db.with(|c| c.execute("update projects set platform = 'macos' where id > 2", [])).unwrap();
    let mac = Provider { platform: Platform::Macos, ..provider(Arc::new(Fake::default()), 1, &[], true) };
    let pool = Pool::new(vec![provider(Arc::new(Fake::default()), 5, &[], true), mac]);
    let cfg = Config { session_secret: SECRET.into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db: db.clone(), pool, ui: Ui::new(&ui, SECRET), cfg, locks: Locks::default() });
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(ctx.clone(), "me".into(), stop.clone()));

    // Both web projects on Linux, one iOS app on the Mac; the other two wait for it, not for Linux's room.
    settle(&db, &[(1, 3)]).await;
    assert_eq!((running_on(&db, "linux"), running_on(&db, "macos")), (2, 1));
    let state: serde_json::Value = serde_json::from_str(&db.setting("orchestrator").unwrap().unwrap()).unwrap();
    assert_eq!(state["parallel"].as_u64(), Some(5), "the top number stays Linux's");
    assert_eq!(state["providers"][1]["platform"].as_str(), Some("macos"));
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();

    // An instance without Mac sandboxes runs the web projects and leaves the iOS apps queued.
    let db = Db::memory().unwrap();
    user_with_setups(&db, 1, "acme", 5);
    db.with(|c| c.execute("update projects set platform = 'macos' where id > 2", [])).unwrap();
    let pool = Pool::new(vec![provider(Arc::new(Fake::default()), 5, &[], true)]);
    let cfg = Config { session_secret: SECRET.into(), ..Default::default() };
    let ctx = Arc::new(Ctx { db: db.clone(), pool, ui: Ui::new(&ui, SECRET), cfg, locks: Locks::default() });
    let stop = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(worker::run(ctx.clone(), "me".into(), stop.clone()));
    settle(&db, &[(1, 2)]).await;
    assert_eq!(running_on(&db, "macos"), 0);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("drains").unwrap();
}
