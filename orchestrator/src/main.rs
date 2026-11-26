//! `gespann-orchestrator`: reads the config, opens the database, starts the health endpoint and the
//! queue loop, and drains on SIGTERM or Ctrl-C.

use std::sync::Arc;
use std::time::Duration;

use gespann_orchestrator::config::Config;
use gespann_orchestrator::db::Db;
use gespann_orchestrator::ui::Ui;
use gespann_orchestrator::{log, sandbox, worker, Ctx, Locks};
use rand::RngCore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

fn main() {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            log("error", &format!("could not start the runtime: {e}"));
            std::process::exit(1);
        }
    };
    let code = rt.block_on(run());
    // Job tasks are gone and leases released; nothing left worth waiting for.
    rt.shutdown_timeout(Duration::from_secs(1));
    std::process::exit(code);
}

async fn run() -> i32 {
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(e) => {
            log("error", &format!("{e:#}"));
            return 1;
        }
    };
    let mut id = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut id);
    let instance = hex::encode(id);
    let shutdown = CancellationToken::new();
    tokio::spawn(signals(shutdown.clone()));

    let health = match TcpListener::bind(("0.0.0.0", cfg.health_port)).await {
        Ok(l) => l,
        Err(e) => {
            log("error", &format!("health endpoint on port {}: {e}", cfg.health_port));
            return 1;
        }
    };
    tokio::spawn(serve_health(health));

    // The UI creates the database; on a fresh instance the orchestrator may come up first.
    let db = loop {
        match Db::open(&cfg.db_path) {
            Ok(db) => break db,
            Err(e) => {
                log("warn", &format!("database {}: {e:#}; trying again in 5 s", cfg.db_path));
                tokio::select! {
                    _ = shutdown.cancelled() => return 0,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
            }
        }
    };
    let pool = match sandbox::pool::Pool::from_config(&cfg).await {
        Ok(p) if p.is_empty() => {
            log("warn", "no sandbox provider (SANDBOX_PROVIDER and SANDBOX_PROVIDER_BY_USER are empty): jobs stay queued; only the health endpoint runs");
            shutdown.cancelled().await;
            return 0;
        }
        Ok(p) => p,
        Err(e) => {
            log("error", &format!("sandboxes: {e:#}"));
            return 1;
        }
    };
    let named = pool.named();
    for p in pool.providers() {
        log("info", &format!("sandboxes: {} ({}), parallel jobs: {} ({})", p.sb.kind(), p.serves(named), p.parallel.jobs, p.parallel.why));
    }
    if !pool.providers().iter().any(|p| p.default) {
        log("warn", "no SANDBOX_PROVIDER: only the users in SANDBOX_PROVIDER_BY_USER get sandboxes; the jobs of everyone else stay queued");
    }
    let ui = Ui::new(&cfg.ui_url, &cfg.session_secret);
    let ctx = Arc::new(Ctx { db, pool, ui, cfg, locks: Locks::default() });
    log("info", &format!("orchestrator {instance} started"));
    worker::run(ctx, instance, shutdown).await;
    0
}

/// SIGTERM (a deploy) or Ctrl-C: stop.
async fn signals(shutdown: CancellationToken) {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                log("error", &format!("cannot listen for SIGTERM: {e}"));
                let _ = tokio::signal::ctrl_c().await;
                shutdown.cancel();
                return;
            }
        };
        tokio::select! {
            _ = term.recv() => log("info", "SIGTERM: stopping"),
            _ = tokio::signal::ctrl_c() => log("info", "Ctrl-C: stopping"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        log("info", "Ctrl-C: stopping");
    }
    shutdown.cancel();
}

/// `GET /healthz` answers 200 "ok"; everything else 404.
async fn serve_health(l: TcpListener) {
    loop {
        match l.accept().await {
            Ok((s, _)) => {
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(5), answer_health(s)).await;
                });
            }
            Err(e) => {
                log("warn", &format!("health endpoint: {e}"));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn answer_health(mut s: TcpStream) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 8192 {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&buf);
    let ok = line.starts_with("GET /healthz ") || line.starts_with("HEAD /healthz ");
    let (status, body) = if ok { ("200 OK", "ok") } else { ("404 Not Found", "not found") };
    let reply = format!("HTTP/1.1 {status}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
    s.write_all(reply.as_bytes()).await?;
    s.shutdown().await
}
