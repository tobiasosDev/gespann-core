//! One container per sandbox, from one image. The engine can be
//! local or a CI server (`DOCKER_HOST=ssh://ci@ci.example.com`). Stopping keeps the container's disk.

use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use async_trait::async_trait;

use super::scripts::{prelude, q};
use super::shell::{head, sandbox_name, spawn_collect, Ran, ShellSandboxes};
use super::{CommandResult, CreateOpts, ProcessStatus, Sandboxes};
use crate::config::DockerConfig;

pub struct Docker {
    o: DockerConfig,
    /// The docker binary; `DOCKER_HOST` and `DOCKER_CONTEXT` in the environment pick the engine.
    bin: String,
    seq: AtomicU64,
}

impl Docker {
    pub fn new(o: DockerConfig) -> Docker {
        Docker::with_bin(o, "docker")
    }

    pub fn with_bin(o: DockerConfig, bin: &str) -> Docker {
        Docker { o, bin: bin.to_string(), seq: AtomicU64::new(0) }
    }

    async fn docker(&self, args: &[String], input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
        spawn_collect(&self.bin, args, input, timeout).await
    }

    async fn must(&self, args: &[String], what: &str, timeout: Duration) -> Result<String> {
        let r = self.docker(args, None, timeout).await?;
        if r.code != Some(0) {
            let err = head(r.err().trim(), 500);
            bail!("docker {what} failed: {}", if err.is_empty() { head(&r.out(), 500) } else { err });
        }
        Ok(r.out().trim().to_string())
    }

    fn user(&self) -> Vec<String> {
        if self.o.user.is_empty() {
            vec![]
        } else {
            vec!["-u".into(), self.o.user.clone()]
        }
    }

    async fn state(&self, id: &str) -> Result<Option<String>> {
        let r = self.docker(&args(&["inspect", "--type", "container", "-f", "{{.State.Status}}", id]), None, Duration::from_secs(120)).await?;
        if r.code == Some(0) {
            return Ok(Some(r.out().trim().to_string()));
        }
        let err = r.err().to_lowercase();
        if err.contains("no such container") || err.contains("no such object") {
            return Ok(None);
        }
        bail!("docker inspect failed: {}", head(r.err().trim(), 300))
    }

    /// Gives the container's user the home directory.
    async fn setup(&self, name: &str) -> Result<()> {
        self.ensure_running(name).await?;
        let mut a = vec!["exec".to_string()];
        a.extend(self.user());
        a.extend(args(&[name, "sh", "-c", "id -u; id -g"]));
        let ids = self.must(&a, "exec", Duration::from_secs(120)).await?;
        let mut it = ids.split('\n');
        let (uid, gid) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        let h = q(&self.o.home);
        let script = format!("mkdir -p {h} && chown {uid}:{gid} {h}");
        self.must(&args(&["exec", "-u", "0", name, "sh", "-c", &script]), "exec", Duration::from_secs(120)).await?;
        Ok(())
    }
}

fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[async_trait]
impl ShellSandboxes for Docker {
    async fn shell(&self, id: &str, script: &str, input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
        let mut a = vec!["exec".to_string(), "-i".into()];
        a.extend(self.user());
        a.extend(args(&["-w", &self.o.home, id, "bash", "-c", &format!("{}\n{script}", prelude(&self.o.home))]));
        let r = self.docker(&a, input, timeout).await?;
        // The engine's own failures (container gone or stopped, daemon unreachable) are errors, not exit codes.
        let err = r.err();
        let engine = err.lines().any(|l| ["Error response from daemon", "Cannot connect to the Docker daemon", "error during connect"].iter().any(|p| l.starts_with(p)));
        if r.code != Some(0) && engine {
            bail!("docker exec: {}", head(err.trim(), 300));
        }
        Ok(r)
    }

    fn seq(&self) -> &AtomicU64 {
        &self.seq
    }
}

#[async_trait]
impl Sandboxes for Docker {
    fn kind(&self) -> &str {
        "docker"
    }

    async fn create(&self, opts: CreateOpts) -> Result<String> {
        let name = sandbox_name(&opts.name);
        let mut labels: Vec<(String, String)> = vec![("gespann".into(), "1".into())];
        for (k, v) in opts.labels {
            match labels.iter_mut().find(|(lk, _)| *lk == k) {
                Some(l) => l.1 = v,
                None => labels.push((k, v)),
            }
        }
        let mut a = args(&["run", "-d", "--init", "--name", &name]);
        for (k, v) in labels {
            a.push("--label".into());
            a.push(format!("{k}={v}"));
        }
        a.extend(self.o.args.iter().cloned());
        a.push(self.o.image.clone());
        a.extend(self.o.command.iter().cloned());
        // Images pull on first use, which can take minutes.
        self.must(&a, "run", Duration::from_secs(30 * 60)).await?;
        if let Err(e) = self.setup(&name).await {
            let _ = self.remove(&name).await;
            return Err(e);
        }
        Ok(name)
    }

    async fn exists(&self, id: &str) -> Result<bool> {
        Ok(self.state(id).await?.is_some())
    }

    fn home(&self, _id: &str) -> String {
        self.o.home.clone()
    }

    async fn ensure_running(&self, id: &str) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(120);
        let mut started = false;
        loop {
            let Some(s) = self.state(id).await? else { bail!("container {id} does not exist") };
            if s == "running" {
                return Ok(());
            }
            if started && s == "exited" {
                let logs = self.docker(&args(&["logs", "--tail", "20", id]), None, Duration::from_secs(120)).await?;
                let text: Vec<char> = (logs.out() + &logs.err()).chars().collect();
                let tail: String = text[text.len().saturating_sub(500)..].iter().collect();
                bail!("container {id} stops right after it starts; its command has to keep running (for a plain image set SANDBOX_COMMAND=\"sleep infinity\"): {tail}");
            }
            if s == "exited" || s == "created" {
                self.must(&args(&["start", id]), "start", Duration::from_secs(120)).await?;
                started = true;
            } else if s == "paused" {
                self.must(&args(&["unpause", id]), "unpause", Duration::from_secs(120)).await?;
            }
            if Instant::now() > until {
                bail!("container {id} did not start (state {s})");
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    async fn keep_alive(&self, _id: &str) -> Result<()> {
        Ok(())
    }

    async fn stop(&self, id: &str) -> Result<()> {
        self.must(&args(&["stop", "-t", "10", id]), "stop", Duration::from_secs(120)).await?;
        Ok(())
    }

    async fn remove(&self, id: &str) -> Result<()> {
        let r = self.docker(&args(&["rm", "-f", "-v", id]), None, Duration::from_secs(120)).await?;
        if r.code != Some(0) && !r.err().to_lowercase().contains("no such container") {
            bail!("docker rm failed: {}", head(&r.err(), 300));
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

    /// The engine's machine, which a remote `DOCKER_HOST` makes the CI server.
    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        let info = self.must(&args(&["info", "--format", "{{.NCPU}} {{.MemTotal}}"]), "info", Duration::from_secs(60)).await?;
        let mut it = info.split_whitespace();
        let cpus = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let bytes = it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        Ok(Some((cpus, bytes / 1024f64.powi(3))))
    }

    async fn start_recording(&self, id: &str, file: &str) -> Result<()> {
        ShellSandboxes::start_recording(self, id, file).await
    }

    async fn stop_recording(&self, id: &str) -> Result<()> {
        ShellSandboxes::stop_recording(self, id).await
    }
}
