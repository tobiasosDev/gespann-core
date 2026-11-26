//! `from_config` picks the provider and writes the SSH key and known_hosts.

use std::os::unix::fs::PermissionsExt;

use gespann_orchestrator::config::{Config, SshConfig};
use gespann_orchestrator::sandbox::from_config;

#[test]
fn providers_from_config() {
    assert!(from_config(&Config::default()).unwrap().is_none());
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        sandbox_provider: "ssh".into(),
        data_dir: dir.path().to_string_lossy().into_owned(),
        ssh: SshConfig { host: "ci@h".into(), key: "KEY".into(), known_hosts: "h ssh-ed25519 AAAA".into(), root: "~/r".into(), ..Default::default() },
        ..Default::default()
    };
    let sb = from_config(&cfg).unwrap().expect("ssh provider");
    assert_eq!(sb.kind(), "ssh");
    let ssh = dir.path().join("ssh");
    assert_eq!(std::fs::metadata(&ssh).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::read_to_string(ssh.join("id")).unwrap(), "KEY\n");
    assert_eq!(std::fs::metadata(ssh.join("id")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_to_string(ssh.join("known_hosts.pinned")).unwrap(), "h ssh-ed25519 AAAA\n");
    let docker = Config { sandbox_provider: "docker".into(), ..Default::default() };
    assert_eq!(from_config(&docker).unwrap().unwrap().kind(), "docker");
}
