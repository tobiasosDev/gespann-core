//! A Linux machine you already run, e.g. a CI server, reached over SSH (class Ssh in
//! src/server/sandbox.ts). Each sandbox is a directory under `root` that serves as `HOME` for everything
//! gespann runs there, so projects keep their checkout, recipe and Codex sign-in apart. They share the
//! machine's user, tools and Docker engine.

use std::sync::atomic::AtomicU64;
use std::time::Duration;

use anyhow::{bail, Result};
use async_trait::async_trait;

use super::scripts::{prelude, q, safe_path, screen_script, stop_screen_script};
use super::shell::{head, sandbox_name, spawn_collect, Ran, ShellSandboxes};
use super::{CommandResult, CreateOpts, ProcessStatus, Sandboxes};

#[derive(Debug, Clone, Default)]
pub struct SshOptions {
    /// `user@host` or a host alias.
    pub host: String,
    pub port: String,
    /// Private key file; empty uses ssh's defaults.
    pub key_file: String,
    pub known_hosts_file: String,
    /// With a known_hosts file from the operator; otherwise a new host key is accepted once and pinned.
    pub strict_host_keys: bool,
    /// Directory on the host that holds one directory per sandbox; may start with `~/`.
    pub root: String,
    /// Local directory for the shared connection socket.
    pub control_dir: String,
}

pub struct Ssh {
    o: SshOptions,
    seq: AtomicU64,
}

impl Ssh {
    pub fn new(o: SshOptions) -> Ssh {
        Ssh { o, seq: AtomicU64::new(0) }
    }

    fn args(&self) -> Vec<String> {
        let o = &self.o;
        let mut a: Vec<String> = [
            "-o", "BatchMode=yes",
            "-o", "LogLevel=ERROR",
            "-o", "ControlMaster=auto",
            "-o", &format!("ControlPath={}/%C", o.control_dir),
            "-o", "ControlPersist=600",
            "-o", "ServerAliveInterval=30",
            "-o", if o.strict_host_keys { "StrictHostKeyChecking=yes" } else { "StrictHostKeyChecking=accept-new" },
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if !o.known_hosts_file.is_empty() {
            a.extend(["-o".into(), format!("UserKnownHostsFile={}", o.known_hosts_file)]);
        }
        if !o.key_file.is_empty() {
            a.extend(["-i".into(), o.key_file.clone(), "-o".into(), "IdentitiesOnly=yes".into()]);
        }
        if !o.port.is_empty() {
            a.extend(["-p".into(), o.port.clone()]);
        }
        a.push(o.host.clone());
        a
    }

    async fn raw(&self, script: &str, input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
        let mut a = self.args();
        a.push(format!("bash -c {}", q(script)));
        let r = spawn_collect("ssh", &a, input, timeout).await?;
        // 255 is ssh's own failure (connection, key, host key); the command never ran.
        if r.code == Some(255) {
            bail!("ssh {}: {}", self.o.host, head(r.err().trim(), 300));
        }
        Ok(r)
    }

    fn root_expr(&self) -> String {
        let r = &self.o.root;
        if r == "~" {
            r#""$HOME""#.into()
        } else if let Some(rest) = r.strip_prefix("~/") {
            format!(r#""$HOME"/{}"#, q(rest))
        } else {
            q(r)
        }
    }

    /// Sandboxes share the machine, and jobs run side by side: each sandbox gets its own virtual screen,
    /// so a tester's browser and screenshots never show another job's window. Only on a machine set up
    /// with a screen (`DISPLAY` set and Xvfb installed); Xvfb picks a free display number itself.
    async fn screen(&self, id: &str) -> Result<()> {
        let r = self.raw(&screen_script(id), None, Duration::from_secs(60)).await?;
        if r.code != Some(0) {
            bail!("could not start the sandbox's screen on {}: {}", self.o.host, head(r.err().trim(), 300));
        }
        Ok(())
    }
}

/// Only directories this provider made: absolute, named gespann-… (`/^\/.+\/gespann-[A-Za-z0-9_.-]+$/`).
fn removable(id: &str) -> bool {
    let Some(i) = id.rfind('/') else { return false };
    let (parent, last) = (&id[..i], &id[i + 1..]);
    let Some(name) = last.strip_prefix("gespann-") else { return false };
    parent.len() >= 2
        && parent.starts_with('/')
        && !parent[1..].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        && !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

#[async_trait]
impl ShellSandboxes for Ssh {
    async fn shell(&self, id: &str, script: &str, input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
        self.raw(&format!("{}\n{script}", prelude(id)), input, timeout).await
    }

    fn seq(&self) -> &AtomicU64 {
        &self.seq
    }

    fn shared_screen(&self) -> bool {
        true
    }
}

#[async_trait]
impl Sandboxes for Ssh {
    fn kind(&self) -> &str {
        "ssh"
    }

    async fn create(&self, opts: CreateOpts) -> Result<String> {
        let name = sandbox_name(&opts.name);
        let r = self.raw(&format!(r#"set -e; d={}/{}; mkdir -p "$d"; cd "$d"; pwd -P"#, self.root_expr(), q(&name)), None, Duration::from_secs(60)).await?;
        let dir = r.out().trim().to_string();
        if r.code != Some(0) || !dir.starts_with('/') {
            bail!("could not create the sandbox directory on {}: {}", self.o.host, head(&r.err(), 300));
        }
        if !safe_path(&dir) {
            bail!("sandbox directory {dir} has characters gespann does not quote; use a SANDBOX_ROOT of letters, digits, . _ - and /");
        }
        Ok(dir)
    }

    async fn exists(&self, id: &str) -> Result<bool> {
        if !id.starts_with('/') {
            return Ok(false);
        }
        let r = self.raw(&format!("test -d {}", q(id)), None, Duration::from_secs(60)).await?;
        match r.code {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => bail!("ssh {}: could not check {id}{}", self.o.host, if r.timed_out { " (timed out)" } else { "" }),
        }
    }

    fn home(&self, id: &str) -> String {
        id.to_string()
    }

    async fn ensure_running(&self, id: &str) -> Result<()> {
        if !self.exists(id).await? {
            bail!("sandbox directory {id} is gone on {}", self.o.host);
        }
        self.screen(id).await
    }

    async fn keep_alive(&self, _id: &str) -> Result<()> {
        Ok(())
    }

    /// The machine keeps running; the copy is already down when a job ends. The sandbox's screen goes.
    async fn stop(&self, id: &str) -> Result<()> {
        self.raw(&stop_screen_script(id), None, Duration::from_secs(60)).await?;
        Ok(())
    }

    async fn remove(&self, id: &str) -> Result<()> {
        if !removable(id) {
            bail!("refusing to delete {id}: not a gespann sandbox directory");
        }
        let _ = self.stop(id).await;
        let r = self.raw(&format!("chmod -R u+w {p} 2>/dev/null; rm -rf -- {p}", p = q(id)), None, Duration::from_secs(10 * 60)).await?;
        if r.code != Some(0) {
            bail!("could not delete {id}: {}", head(&r.err(), 300));
        }
        Ok(())
    }

    async fn exec(&self, id: &str, command: &str, timeout_secs: u64) -> Result<CommandResult> {
        ShellSandboxes::exec(self, id, command, timeout_secs).await
    }

    async fn start(&self, id: &str, command: &str) -> Result<u64> {
        ShellSandboxes::start(self, id, command).await
    }

    async fn start_as(&self, id: &str, handle: u64, command: &str) -> Result<u64> {
        ShellSandboxes::start_as(self, id, handle, command).await
    }

    async fn status(&self, id: &str, pid: u64, tail_bytes: usize) -> Result<ProcessStatus> {
        ShellSandboxes::status(self, id, pid, tail_bytes).await
    }

    async fn kill(&self, id: &str, pid: u64) -> Result<()> {
        ShellSandboxes::kill(self, id, pid).await
    }

    async fn read_file(&self, id: &str, path: &str) -> Result<Option<String>> {
        ShellSandboxes::read_file(self, id, path).await
    }

    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()> {
        ShellSandboxes::write_file(self, id, path, content).await
    }

    async fn download(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        ShellSandboxes::download(self, id, path).await
    }

    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        let r = self.raw("nproc; awk '/^MemTotal:/ { print $2 }' /proc/meminfo", None, Duration::from_secs(60)).await?;
        if r.code != Some(0) {
            bail!("ssh {}: {}", self.o.host, head(r.err().trim(), 200));
        }
        let out = r.out();
        let mut it = out.split_whitespace();
        let cpus = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let kb = it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        Ok(Some((cpus, kb / 1024f64.powi(2))))
    }

    async fn start_recording(&self, id: &str, file: &str) -> Result<()> {
        ShellSandboxes::start_recording(self, id, file).await
    }

    async fn stop_recording(&self, id: &str) -> Result<()> {
        ShellSandboxes::stop_recording(self, id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_gespann_dirs_are_removable() {
        assert!(removable("/home/ci/gespann-sandboxes/gespann-acme-1a2b3c"));
        assert!(removable("/x/gespann-a"));
        for id in ["/gespann-a", "gespann-a", "/x/gespann-", "/x/gespann-a/b", "/x/other", "/x/gespann-a b", "//gespann-a"] {
            assert!(!removable(id), "{id}");
        }
    }

    #[test]
    fn args_follow_options() {
        let s = Ssh::new(SshOptions { host: "ci@h".into(), port: "2222".into(), key_file: "/k".into(), known_hosts_file: "/kh".into(), strict_host_keys: true, root: "~/r".into(), control_dir: "/tmp/gsp-x".into() });
        let a = s.args().join(" ");
        assert!(a.contains("ControlPath=/tmp/gsp-x/%C") && a.contains("StrictHostKeyChecking=yes") && a.contains("UserKnownHostsFile=/kh"), "{a}");
        assert!(a.ends_with("-i /k -o IdentitiesOnly=yes -p 2222 ci@h"), "{a}");
        assert_eq!(s.root_expr(), r#""$HOME"/'r'"#);
    }
}
