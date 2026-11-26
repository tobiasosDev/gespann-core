//! The Docker provider against a real engine. Needs `docker` (or `$GESPANN_TEST_DOCKER`, or OrbStack's
//! `~/.local/bin/docker`) and pulls debian:bookworm-slim, so it only runs on request:
//! `cargo test --manifest-path orchestrator/Cargo.toml --test sandbox_docker -- --ignored`.

use std::time::Duration;

use gespann_orchestrator::config::DockerConfig;
use gespann_orchestrator::sandbox::docker::Docker;
use gespann_orchestrator::sandbox::*;

fn docker_bin() -> String {
    if let Ok(b) = std::env::var("GESPANN_TEST_DOCKER") {
        return b;
    }
    let orb = format!("{}/.local/bin/docker", std::env::var("HOME").unwrap_or_default());
    if std::path::Path::new(&orb).exists() {
        orb
    } else {
        "docker".into()
    }
}

#[tokio::test]
#[ignore = "needs a Docker engine"]
async fn docker_sandbox_round_trip() {
    let sb = Docker::with_bin(
        DockerConfig { image: "debian:bookworm-slim".into(), args: vec![], command: vec!["sleep".into(), "infinity".into()], user: String::new(), home: "/home/user".into() },
        &docker_bin(),
    );
    let id = sb
        .create(CreateOpts { name: "gespann-orchestrator-test".into(), purpose: Purpose::Project, labels: vec![("gespann-test".into(), "1".into())], ttl_seconds: None })
        .await
        .expect("create");
    let guard = Cleanup(id.clone());
    round_trip(&sb, &id).await.unwrap();
    sb.remove(&id).await.expect("remove");
    assert!(!sb.exists(&id).await.unwrap(), "container is gone");
    drop(guard);
}

/// Removes the test's container also when an assertion fails half way.
struct Cleanup(String);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::process::Command::new(docker_bin()).args(["rm", "-f", "-v", &self.0]).output();
    }
}

async fn round_trip(sb: &Docker, id: &str) -> anyhow::Result<()> {
    assert!(sb.exists(id).await?);
    assert!(!sb.exists("gespann-no-such-container-xyz").await?);
    sb.ensure_running(id).await?;
    let home = sb.home(id);

    let r = sb.exec(id, "echo \"$HOME\" \"$PWD\"; echo 'it''s' >&2; exit 3", 30).await?;
    assert_eq!((r.exit_code, r.stdout.as_str(), r.stderr.as_str(), r.timed_out), (Some(3), "/home/user /home/user\n", "its\n", false));
    let r = sb.exec(id, "sleep 30", 2).await?;
    assert!(r.timed_out && r.exit_code.is_none(), "{r:?}");

    sb.write_file(id, &format!("{home}/a dir/it's.txt"), b"hello\nworld").await?;
    assert_eq!(sb.read_file(id, &format!("{home}/a dir/it's.txt")).await?.as_deref(), Some("hello\nworld"));
    assert_eq!(sb.read_file(id, &format!("{home}/missing.txt")).await?, None);
    let bytes: Vec<u8> = (0..=255u8).collect();
    sb.write_file(id, "/tmp/bin", &bytes).await?;
    assert_eq!(sb.download(id, "/tmp/bin").await?, bytes);
    assert!(sb.download(id, "/tmp/missing").await.is_err());

    // A background command that finishes.
    let pid = sb.start(id, "echo out; echo err >&2; exit 5").await?;
    let opts = |cancelled| WaitOpts { deadline: chrono::Utc::now() + chrono::Duration::seconds(30), cancelled, on_tick: None, poll: Duration::from_millis(200) };
    let never = || false;
    let r = wait_long(sb, id, pid, opts(&never)).await?;
    assert_eq!(r, LongResult { exit_code: Some(5), tail: "out\n\nerr\n".into(), timed_out: false });

    // Started twice under one handle (a takeover after a lost answer): it runs once.
    let h = gespann_orchestrator::sandbox::new_handle();
    assert_eq!(sb.start_as(id, h, "sleep 301").await?, h);
    assert_eq!(sb.start_as(id, h, "sleep 301").await?, h);
    let r = sb.exec(id, "for c in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$c\" 2>/dev/null; echo; done | grep -c '^sleep 301' || true", 30).await?;
    assert_eq!(r.stdout.trim(), "1", "one process for the handle");
    sb.kill(id, h).await?;
    // A background command that runs on until it is killed, with a child in its process group.
    let pid = sb.start(id, "sleep 300 & echo started; wait").await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let s = sb.status(id, pid, 16_000).await?;
    assert_eq!((s.state, s.stdout.as_str()), (ProcState::Running, "started\n"));
    sb.kill(id, pid).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let s = sb.status(id, pid, 16_000).await?;
    assert_ne!(s.state, ProcState::Running);
    // bookworm-slim has no ps; count sleep processes through /proc instead.
    let r = sb.exec(id, "for c in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$c\" 2>/dev/null; echo; done | grep -c '^sleep 300' || true", 30).await?;
    assert_eq!(r.stdout.trim(), "0", "the killed command's child is gone");

    // Recording fails with a reason: the image has no ffmpeg.
    let e = sb.start_recording(id, &format!("{home}/rec.mp4")).await.unwrap_err();
    assert!(e.to_string().contains("ffmpeg is not installed"), "{e}");
    sb.stop_recording(id).await?;

    let cap = sb.capacity().await?.expect("capacity");
    assert!(cap.0 > 0 && cap.1 > 0.0, "{cap:?}");

    sb.stop(id).await?;
    assert!(sb.exists(id).await?);
    sb.ensure_running(id).await?;
    assert_eq!(sb.read_file(id, &format!("{home}/a dir/it's.txt")).await?.as_deref(), Some("hello\nworld"), "a stopped container keeps its disk");
    Ok(())
}
