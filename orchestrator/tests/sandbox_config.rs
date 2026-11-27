//! `from_spec` picks the provider and writes the SSH key and known_hosts.

use std::os::unix::fs::PermissionsExt;

use gespann_orchestrator::config::{Config, MacosConfig, SshConfig};
use gespann_orchestrator::sandbox::{from_spec, Platform};

#[tokio::test]
async fn providers_from_config() {
    assert!(from_spec(&Config::default(), Platform::Linux, "").await.unwrap().is_none());
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        sandbox_provider: "ssh".into(),
        data_dir: dir.path().to_string_lossy().into_owned(),
        ssh: SshConfig { host: "ci@h".into(), key: "KEY".into(), known_hosts: "h ssh-ed25519 AAAA".into(), root: "~/r".into(), ..Default::default() },
        ..Default::default()
    };
    let sb = from_spec(&cfg, Platform::Linux, "ssh").await.unwrap().expect("ssh provider");
    assert_eq!(sb.kind(), "ssh");
    let ssh = dir.path().join("ssh");
    assert_eq!(std::fs::metadata(&ssh).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::read_to_string(ssh.join("id")).unwrap(), "KEY\n");
    assert_eq!(std::fs::metadata(ssh.join("id")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_to_string(ssh.join("known_hosts.pinned")).unwrap(), "h ssh-ed25519 AAAA\n");
    let docker = Config { sandbox_provider: "docker".into(), ..Default::default() };
    assert_eq!(from_spec(&docker, Platform::Linux, "docker").await.unwrap().unwrap().kind(), "docker");
    assert!(from_spec(&docker, Platform::Macos, "docker").await.unwrap().is_none(), "no Docker for macOS");
}

#[tokio::test]
async fn a_mac_over_ssh_gets_its_own_key() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_dir: dir.path().to_string_lossy().into_owned(),
        ssh: SshConfig { host: "ci@linux".into(), key: "LINUX".into(), ..Default::default() },
        macos: MacosConfig { provider: "ssh".into(), ssh: SshConfig { host: "me@mac".into(), key: "MAC".into(), root: "~/r".into(), ..Default::default() }, ..Default::default() },
        ..Default::default()
    };
    let sb = from_spec(&cfg, Platform::Macos, "ssh").await.unwrap().expect("macOS ssh provider");
    assert_eq!(sb.kind(), "ssh");
    assert_eq!(std::fs::read_to_string(dir.path().join("ssh-macos/id")).unwrap(), "MAC\n");
    assert!(!dir.path().join("ssh/id").exists(), "the Linux key is written only for a Linux provider");
}
