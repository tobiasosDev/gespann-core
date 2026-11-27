//! The shell scripts of the SSH provider on the machine the tests run on: Linux in CI, macOS on a Mac.
//! A Mac reached over SSH (`SANDBOX_PROVIDER_MACOS=ssh`) runs the same scripts with BSD tools and no setsid.

use std::sync::atomic::AtomicU64;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use gespann_orchestrator::sandbox::scripts::prelude;
use gespann_orchestrator::sandbox::shell::{spawn_collect, Ran, ShellSandboxes};
use gespann_orchestrator::sandbox::ProcState;

struct Local {
    seq: AtomicU64,
}

#[async_trait]
impl ShellSandboxes for Local {
    async fn shell(&self, id: &str, script: &str, input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
        spawn_collect("bash", &["-c".to_string(), format!("{}\n{script}", prelude(id))], input, timeout).await
    }
    fn seq(&self) -> &AtomicU64 {
        &self.seq
    }
}

fn alive(marker: &str) -> bool {
    std::process::Command::new("pgrep").args(["-f", marker]).output().is_ok_and(|o| o.status.success())
}

#[tokio::test]
async fn a_background_command_runs_reports_and_is_killed_with_everything_it_started() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_string_lossy().into_owned();
    let sb = Local { seq: AtomicU64::new(0) };

    let pid = ShellSandboxes::start(&sb, &home, "echo hello; echo oops >&2; exit 3").await.unwrap();
    let mut s = ShellSandboxes::status(&sb, &home, pid, 1000).await.unwrap();
    for _ in 0..50 {
        if s.state != ProcState::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        s = ShellSandboxes::status(&sb, &home, pid, 1000).await.unwrap();
    }
    assert_eq!((s.state, s.exit_code, s.stdout.as_str(), s.stderr.as_str()), (ProcState::Exited, Some(3), "hello\n", "oops\n"));

    // A build that starts helpers of its own (xcodebuild, a simulator) leaves none behind when killed.
    let marker = format!("{}", 3000 + std::process::id() % 900);
    let pid = ShellSandboxes::start(&sb, &home, &format!("bash -c 'sleep {marker}.1' & sleep {marker}.2")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(alive(&format!("sleep {marker}.1")) && alive(&format!("sleep {marker}.2")), "both helpers run");
    ShellSandboxes::kill(&sb, &home, pid).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!alive(&format!("sleep {marker}.1")), "the grandchild is gone too");
    assert!(!alive(&format!("sleep {marker}.2")), "the child is gone");
    let s = ShellSandboxes::status(&sb, &home, pid, 1000).await.unwrap();
    assert_ne!(s.state, ProcState::Running);
}
