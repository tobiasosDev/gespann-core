//! A sandbox reached through a shell:
//! Docker and SSH only differ in how a script gets to the machine. Background commands keep their
//! output, pid and exit code in `$HOME/.gespann-proc`.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::scripts::{q, record_script, stop_record_script};
use super::{CommandResult, ProcState, ProcessStatus};

/// What a local program ended with.
#[derive(Debug, Clone, Default)]
pub struct Ran {
    /// None when it was killed (a timeout) or ended by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

impl Ran {
    pub fn out(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// The first `n` characters, as `slice(0, n)` in the TypeScript messages.
pub fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Runs a local program, feeds it `input` and collects its output. On timeout the program is killed.
pub async fn spawn_collect(cmd: &str, args: &[String], input: Option<&[u8]>, timeout: Duration) -> Result<Ran> {
    let mut child = tokio::process::Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("could not run {cmd}: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let data = input.map(<[u8]>::to_vec).unwrap_or_default();
    // A program that exits without reading its input closes the pipe; that is not an error.
    tokio::spawn(async move {
        let _ = stdin.write_all(&data).await;
        let _ = stdin.shutdown().await;
    });
    let out = Arc::new(Mutex::new(Vec::new()));
    let err = Arc::new(Mutex::new(Vec::new()));
    let out_task = tokio::spawn(collect(child.stdout.take().expect("piped stdout"), out.clone()));
    let err_task = tokio::spawn(collect(child.stderr.take().expect("piped stderr"), err.clone()));
    let take = |b: &Arc<Mutex<Vec<u8>>>| std::mem::take(&mut *b.lock().expect("output buffer"));
    let deadline = tokio::time::Instant::now() + timeout;
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(status) => {
            let status = status?;
            // As Node's "close": the output is complete once both pipes are closed. A background
            // process that keeps them open gets until the deadline, then its output is left behind.
            let (out_abort, err_abort) = (out_task.abort_handle(), err_task.abort_handle());
            let _ = tokio::time::timeout_at(deadline, async {
                let _ = out_task.await;
                let _ = err_task.await;
            })
            .await;
            out_abort.abort();
            err_abort.abort();
            Ok(Ran { code: status.code(), stdout: take(&out), stderr: take(&err), timed_out: false })
        }
        Err(_) => {
            let _ = child.start_kill();
            let status = child.wait().await.ok();
            // Leftover grandchildren may hold the pipes open; do not wait for them.
            tokio::time::sleep(Duration::from_millis(20)).await;
            out_task.abort();
            err_task.abort();
            Ok(Ran { code: status.and_then(|s| s.code()), stdout: take(&out), stderr: take(&err), timed_out: true })
        }
    }
}

async fn collect(mut r: impl AsyncRead + Unpin, buf: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.lock().expect("output buffer").extend_from_slice(&chunk[..n]),
        }
    }
}

/// The exit code a script uses for a file that does not exist.
const MISSING: i32 = 44;

/// Node's base64 decoding is lenient about padding; so is this.
const B64: GeneralPurpose = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// The shared part of the Docker and SSH providers. A provider supplies `shell`; the rest is the same.
#[async_trait]
pub trait ShellSandboxes: Send + Sync {
    /// Runs `script` with bash in the sandbox, after `prelude` for its home.
    async fn shell(&self, id: &str, script: &str, input: Option<&[u8]>, timeout: Duration) -> Result<Ran>;

    /// Counter for background command handles, one per provider.
    fn seq(&self) -> &AtomicU64;

    /// True where sandboxes share a machine, so only a sandbox's own screen may be recorded.
    fn shared_screen(&self) -> bool {
        false
    }

    async fn exec(&self, id: &str, command: &str, timeout_secs: u64) -> Result<CommandResult> {
        // The local timeout ends the docker or ssh client; `timeout` on the machine also ends the command there.
        let limit = format!(r#"$(command -v timeout >/dev/null 2>&1 && echo "timeout -k 5 {}")"#, timeout_secs + 5);
        let r = self.shell(id, &format!("{limit} bash -c {}", q(command)), None, Duration::from_secs(timeout_secs)).await?;
        Ok(CommandResult { exit_code: if r.timed_out { None } else { r.code }, stdout: r.out(), stderr: r.err(), timed_out: r.timed_out })
    }

    async fn start(&self, id: &str, command: &str) -> Result<u64> {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let n = now * 100 + self.seq().fetch_add(1, Ordering::Relaxed) % 100;
        self.start_as(id, n, command).await
    }

    async fn start_as(&self, id: &str, n: u64, command: &str) -> Result<u64> {
        let script = [
            format!(r#"set -e; d="$HOME/.gespann-proc"; mkdir -p "$d"; f="$d/{n}""#),
            // One launch per handle (mkdir is atomic): a takeover after a lost answer finds it started, also
            // while the first launch is still under way, and must not start the command twice. It waits for
            // that launch, and takes the handle over when that launch gave it up (its command arrived cut off);
            // one that never got going shows as lost.
            r#"i=0; while ! mkdir "$f.lock" 2>/dev/null; do if [ -s "$f.pid" ] || [ -f "$f.exit" ] || [ $i -ge 100 ]; then exit 0; fi; sleep 0.1; i=$((i+1)); done"#.to_string(),
            r#"find "$d" -mindepth 1 -mtime +2 -delete 2>/dev/null || true"#.to_string(),
            // A command cut off on its way (the orchestrator stopped mid-send) never runs; the handle stays free.
            r#"cat > "$f.cmd.tmp""#.to_string(),
            format!(r#"if [ "$(wc -c < "$f.cmd.tmp" | tr -d ' ')" != {} ]; then rm -rf "$f.cmd.tmp" "$f.lock"; echo "the command arrived incomplete" >&2; exit 1; fi"#, command.len()),
            r#"mv "$f.cmd.tmp" "$f.cmd""#.to_string(),
            // setsid gives the command its own process group, so kill reaches everything it started.
            r#"s="$(command -v setsid || true)""#.to_string(),
            r#"nohup $s bash -c 'echo $$ > "$1.pid"; bash "$1.cmd" > "$1.out" 2> "$1.err" < /dev/null; echo $? > "$1.exit.tmp"; mv "$1.exit.tmp" "$1.exit"' _ "$f" > /dev/null 2>&1 < /dev/null &"#.to_string(),
            r#"i=0; while [ ! -s "$f.pid" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done"#.to_string(),
            r#"test -s "$f.pid""#.to_string(),
        ]
        .join("\n");
        let r = self.shell(id, &script, Some(command.as_bytes()), Duration::from_secs(60)).await?;
        if r.code != Some(0) {
            bail!("could not start a background command: {}", head(&r.err(), 300));
        }
        Ok(n)
    }

    async fn status(&self, id: &str, pid: u64, tail_bytes: usize) -> Result<ProcessStatus> {
        let t = tail_bytes;
        let script = [
            format!(r#"f="$HOME/.gespann-proc/{pid}""#),
            r#"if [ -f "$f.exit" ]; then echo exited; cat "$f.exit""#.to_string(),
            r#"elif [ -s "$f.pid" ] && kill -0 "$(cat "$f.pid")" 2>/dev/null; then echo running; echo"#.to_string(),
            "else echo lost; echo; fi".to_string(),
            format!(r#"tail -c {t} "$f.out" 2>/dev/null | base64 | tr -d '\n'; echo"#),
            format!(r#"tail -c {t} "$f.err" 2>/dev/null | base64 | tr -d '\n'; echo"#),
        ]
        .join("\n");
        let r = self.shell(id, &script, None, Duration::from_secs(60)).await?;
        if r.code != Some(0) {
            bail!("could not read background command {pid}: {}", head(&r.err(), 300));
        }
        Ok(parse_status(&r.out()))
    }

    async fn kill(&self, id: &str, pid: u64) -> Result<()> {
        let script = format!(
            r#"p="$(cat "$HOME/.gespann-proc/{pid}.pid" 2>/dev/null)" || exit 0; kill -TERM -- "-$p" 2>/dev/null || pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; exit 0"#
        );
        self.shell(id, &script, None, Duration::from_secs(60)).await?;
        Ok(())
    }

    async fn read_file(&self, id: &str, path: &str) -> Result<Option<String>> {
        let r = self.shell(id, &format!("[ -f {p} ] || exit {MISSING}; cat {p}", p = q(path)), None, Duration::from_secs(120)).await?;
        match r.code {
            Some(MISSING) => Ok(None),
            Some(0) => Ok(Some(r.out())),
            _ => bail!("could not read {path}: {}", head(&r.err(), 300)),
        }
    }

    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()> {
        let r = self.shell(id, &format!(r#"mkdir -p "$(dirname {p})" && cat > {p}"#, p = q(path)), Some(content), Duration::from_secs(120)).await?;
        if r.code != Some(0) {
            bail!("could not write {path}: {}", head(&r.err(), 300));
        }
        Ok(())
    }

    async fn download(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let r = self.shell(id, &format!("cat {}", q(path)), None, Duration::from_secs(600)).await?;
        if r.code != Some(0) {
            bail!("could not download {path}: {}", head(&r.err(), 300));
        }
        Ok(r.stdout)
    }

    /// Records the sandbox's screen (`DISPLAY`) with ffmpeg; the machine needs both.
    async fn start_recording(&self, id: &str, file: &str) -> Result<()> {
        let r = self.shell(id, &record_script(file, self.shared_screen()), None, Duration::from_secs(60)).await?;
        if r.code != Some(0) {
            let msg = head(r.err().trim(), 300);
            if msg.is_empty() {
                bail!("exit {}", r.code.map_or("null".to_string(), |c| c.to_string()));
            }
            bail!("{msg}");
        }
        Ok(())
    }

    async fn stop_recording(&self, id: &str) -> Result<()> {
        self.shell(id, &stop_record_script(), None, Duration::from_secs(60)).await?;
        Ok(())
    }
}

/// Reads the four lines the status script prints: state, exit code, base64 stdout tail, base64 stderr tail.
pub fn parse_status(stdout: &str) -> ProcessStatus {
    let mut lines = stdout.split('\n');
    let mut next = || lines.next().unwrap_or("");
    let (state, code, out, err) = (next(), next(), next(), next());
    let state = match state {
        "running" => ProcState::Running,
        "exited" => ProcState::Exited,
        _ => ProcState::Lost,
    };
    let code = code.trim();
    let exit_code = if state == ProcState::Exited && !code.is_empty() && code.bytes().all(|b| b.is_ascii_digit()) { code.parse().ok() } else { None };
    let text = |b64: &str| String::from_utf8_lossy(&B64.decode(b64.trim()).unwrap_or_default()).into_owned();
    ProcessStatus { state, exit_code, stdout: text(out), stderr: text(err) }
}

/// A sandbox name for the machine: the caller's name made safe and short, plus a random suffix.
pub fn sandbox_name(name: &str) -> String {
    let mut safe = String::new();
    let mut in_bad = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || "_.-".contains(c) {
            safe.push(c);
            in_bad = false;
        } else if !in_bad {
            safe.push('-');
            in_bad = true;
        }
    }
    safe.truncate(50);
    format!("{safe}-{}", hex::encode(rand::random::<[u8; 3]>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        let s = parse_status("exited\n3\naGVsbG8=\nb29wcw==\n");
        assert_eq!((s.state, s.exit_code, s.stdout.as_str(), s.stderr.as_str()), (ProcState::Exited, Some(3), "hello", "oops"));
        let s = parse_status("running\n\naGk\n\n");
        assert_eq!((s.state, s.exit_code, s.stdout.as_str(), s.stderr.as_str()), (ProcState::Running, None, "hi", ""));
        assert_eq!(parse_status("").state, ProcState::Lost);
        assert_eq!(parse_status("exited\nx\n\n\n").exit_code, None);
    }

    #[test]
    fn names() {
        let n = sandbox_name("gespann-a b//c?");
        assert!(n.starts_with("gespann-a-b-c--"), "{n}");
        assert_eq!(n.len(), "gespann-a-b-c-".len() + 7);
        assert_eq!(sandbox_name(&"x".repeat(80)).len(), 57);
    }

    #[tokio::test]
    async fn collects_and_times_out() {
        let r = spawn_collect("sh", &["-c".into(), "cat; echo err >&2; exit 3".into()], Some(b"in"), Duration::from_secs(10)).await.unwrap();
        assert_eq!((r.code, r.out().as_str(), r.err().as_str(), r.timed_out), (Some(3), "in", "err\n", false));
        // The grandchild keeps the pipes open after the timeout; the call still returns at once.
        let t = std::time::Instant::now();
        let r = spawn_collect("sh", &["-c".into(), "echo early; sleep 30 & sleep 30".into()], None, Duration::from_millis(300)).await.unwrap();
        assert!(r.timed_out && r.code.is_none() && t.elapsed() < Duration::from_secs(5), "{r:?}");
        assert_eq!(r.out(), "early\n");
    }
}
