//! Where PR code runs: one directory (SSH) or container (Docker) per project sandbox, kept between jobs.
//! The shell scripts stay byte-compatible with the former TypeScript worker's, so sandboxes it made keep working.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::config::Config;

pub mod docker;
pub mod scripts;
pub mod shell;
pub mod ssh;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandResult {
    /// None when the command timed out.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcState {
    Running,
    Exited,
    /// No exit file and no live pid: the process died without finishing (a reboot).
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessStatus {
    pub state: ProcState,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Builds and runs the app.
    Project,
    /// Only runs `codex login`.
    Login,
}

#[derive(Debug, Clone)]
pub struct CreateOpts {
    pub name: String,
    pub purpose: Purpose,
    pub labels: Vec<(String, String)>,
    pub ttl_seconds: Option<u64>,
}

/// A sandbox provider: Docker or SSH.
#[async_trait]
pub trait Sandboxes: Send + Sync {
    /// "ssh" or "docker", for logs.
    fn kind(&self) -> &str;
    /// The new sandbox's id (SSH: its absolute directory; Docker: the container name).
    async fn create(&self, opts: CreateOpts) -> Result<String>;
    /// False only when the sandbox is gone for good. Other failures are errors.
    async fn exists(&self, id: &str) -> Result<bool>;
    fn home(&self, id: &str) -> String;
    /// Starts or resumes the sandbox (SSH: its own Xvfb screen) and waits until it runs commands.
    async fn ensure_running(&self, id: &str) -> Result<()>;
    async fn keep_alive(&self, id: &str) -> Result<()>;
    async fn stop(&self, id: &str) -> Result<()>;
    async fn remove(&self, id: &str) -> Result<()>;
    async fn exec(&self, id: &str, command: &str, timeout_secs: u64) -> Result<CommandResult>;
    /// Starts a command in the background (nohup + setsid, survives the orchestrator) and returns its handle.
    async fn start(&self, id: &str, command: &str) -> Result<u64>;
    /// Starts `command` under a handle the caller chose and stored first, and does nothing when that
    /// handle already started: a takeover after the orchestrator stopped while the provider answered
    /// must not start a second tester. Returns the handle. Providers that pick their own handles start
    /// a new process.
    async fn start_as(&self, id: &str, handle: u64, command: &str) -> Result<u64> {
        let _ = handle;
        self.start(id, command).await
    }
    async fn status(&self, id: &str, pid: u64, tail_bytes: usize) -> Result<ProcessStatus>;
    async fn kill(&self, id: &str, pid: u64) -> Result<()>;
    /// The file's text, or None when it does not exist.
    async fn read_file(&self, id: &str, path: &str) -> Result<Option<String>>;
    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()>;
    async fn download(&self, id: &str, path: &str) -> Result<Vec<u8>>;
    /// CPUs and memory in GB of the machine sandboxes run on, when the provider can tell.
    async fn capacity(&self) -> Result<Option<(u32, f64)>>;
    /// Records the sandbox's screen to an mp4 at `file`; an error says why there is no recording.
    async fn start_recording(&self, id: &str, file: &str) -> Result<()>;
    async fn stop_recording(&self, id: &str) -> Result<()>;
    /// A provider's script that runs before every job, after gespann is installed.
    fn job_script(&self, _home: &str) -> Option<String> {
        None
    }
    /// How to drive this sandbox's browser, for the prompts.
    fn tester_note(&self) -> Option<String> {
        None
    }
}

/// A fresh handle for a background command, as the TypeScript `start` makes them (`Date.now() * 100 + n`).
pub fn new_handle() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = chrono::Utc::now().timestamp_millis() as u64;
    now * 100 + SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 100
}

/// The provider `SANDBOX_PROVIDER` names; None when the instance has none.
pub fn from_config(cfg: &Config) -> Result<Option<Arc<dyn Sandboxes>>> {
    match cfg.sandbox_provider.as_str() {
        "docker" => Ok(Some(Arc::new(docker::Docker::new(cfg.docker.clone())))),
        "ssh" => Ok(Some(Arc::new(ssh::Ssh::new(ssh_options(cfg)?)))),
        _ => Ok(None),
    }
}

/// Writes the key and known_hosts under DATA_DIR/ssh.
fn ssh_options(cfg: &Config) -> Result<ssh::SshOptions> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let s = &cfg.ssh;
    let dir = std::path::Path::new(&cfg.data_dir).join("ssh");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    let with_newline = |t: &str| if t.ends_with('\n') { t.to_string() } else { format!("{t}\n") };
    let write = |path: &std::path::Path, text: &str| -> Result<()> {
        std::fs::write(path, with_newline(text)).with_context(|| format!("could not write {}", path.display()))?;
        // ssh refuses a key others can read, also when the file was there before with looser rights.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(())
    };
    let mut key_file = s.key_file.clone();
    if !s.key.is_empty() {
        let path = dir.join("id");
        write(&path, &s.key)?;
        key_file = path.to_string_lossy().into_owned();
    }
    // With SSH_KNOWN_HOSTS the host key is checked strictly; otherwise the first key seen is pinned here.
    let known_hosts = dir.join(if s.known_hosts.is_empty() { "known_hosts" } else { "known_hosts.pinned" });
    if !s.known_hosts.is_empty() {
        write(&known_hosts, &s.known_hosts)?;
    }
    Ok(ssh::SshOptions {
        host: s.host.clone(),
        port: s.port.clone(),
        key_file,
        known_hosts_file: known_hosts.to_string_lossy().into_owned(),
        strict_host_keys: !s.known_hosts.is_empty(),
        root: s.root.clone(),
        control_dir: control_dir()?,
    })
}

/// A fresh directory for ssh's connection sockets, as `mkdtemp("/tmp/gsp-")`. Unix socket paths are
/// limited to about 104 bytes (macOS's temp dir alone takes half), so /tmp.
fn control_dir() -> Result<String> {
    use rand::Rng;
    use std::os::unix::fs::DirBuilderExt;
    for _ in 0..100 {
        let tag: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(6).map(char::from).collect();
        let path = format!("/tmp/gsp-{tag}");
        match std::fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("could not create {path}")),
        }
    }
    anyhow::bail!("could not create a directory for ssh's connection sockets under /tmp")
}

/// What a long background command ended with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LongResult {
    pub exit_code: Option<i32>,
    /// stdout, then stderr after a newline when there is any (as `runLong` in TypeScript).
    pub tail: String,
    pub timed_out: bool,
}

pub type Tick<'a> = &'a (dyn Fn(String) -> BoxFuture<'a, ()> + Send + Sync);

pub struct WaitOpts<'a> {
    /// Kill the process and answer timed_out once this passes.
    pub deadline: chrono::DateTime<chrono::Utc>,
    /// Checked every poll; true kills the process and answers timed_out.
    pub cancelled: &'a (dyn Fn() -> bool + Send + Sync),
    /// Called with the output tail after every poll.
    pub on_tick: Option<Tick<'a>>,
    /// Default 2 s.
    pub poll: Duration,
}

/// Waits for a background command started earlier (possibly by an orchestrator before a restart), as
/// the loop of `runLong` does: poll, tick, keep the sandbox alive every 10 minutes, kill on deadline
/// or cancel. A `Lost` process ends like an exited one with no exit code.
pub async fn wait_long(sb: &dyn Sandboxes, id: &str, pid: u64, opts: WaitOpts<'_>) -> Result<LongResult> {
    let mut last_alive = Instant::now();
    let mut failing_since: Option<Instant> = None;
    let mut tail = String::new();
    // A zero poll means the default.
    let poll = if opts.poll.is_zero() { Duration::from_secs(2) } else { opts.poll };
    loop {
        // Short polls: every run waits on several of these, and each wait loses half an interval on average.
        tokio::time::sleep(poll).await;
        match sb.status(id, pid, 16_000).await {
            Ok(s) => {
                failing_since = None;
                tail = if s.stderr.is_empty() { s.stdout } else { format!("{}\n{}", s.stdout, s.stderr) };
                if let Some(tick) = opts.on_tick {
                    tick(tail.clone()).await;
                }
                if s.state != ProcState::Running {
                    return Ok(LongResult { exit_code: s.exit_code, tail, timed_out: false });
                }
            }
            // An ssh hiccup must not end a test that runs on: the process keeps going on the machine.
            Err(e) => {
                let since = *failing_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= STATUS_GRACE {
                    return Err(e);
                }
            }
        }
        if chrono::Utc::now() > opts.deadline || (opts.cancelled)() {
            let _ = sb.kill(id, pid).await;
            return Ok(LongResult { exit_code: None, tail, timed_out: true });
        }
        if last_alive.elapsed() > KEEP_ALIVE {
            sb.keep_alive(id).await?;
            last_alive = Instant::now();
        }
    }
}

/// How long `status` may keep failing before `wait_long` gives up.
const STATUS_GRACE: Duration = Duration::from_secs(5 * 60);
const KEEP_ALIVE: Duration = Duration::from_secs(10 * 60);

/// Starts `command` and waits for it (`runLong`), for steps that need no journal.
pub async fn run_long(sb: &dyn Sandboxes, id: &str, command: &str, opts: WaitOpts<'_>) -> Result<LongResult> {
    if (opts.cancelled)() {
        return Ok(LongResult { exit_code: None, tail: String::new(), timed_out: true });
    }
    let pid = sb.start(id, command).await?;
    wait_long(sb, id, pid, opts).await
}
