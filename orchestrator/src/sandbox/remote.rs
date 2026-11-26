//! A sandbox service over HTTP (`SANDBOX_PROVIDER=remote`): every `Sandboxes` call is one request to
//! `SANDBOX_REMOTE_URL`, so a hosted service can bring sandboxes of any vendor through an adapter of its
//! own. The protocol: docs/remote-sandboxes.md.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{CommandResult, CreateOpts, ProcState, ProcessStatus, Purpose, Sandboxes};

/// What `GET /info` answers once at startup.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// For logs and the job log users read (e.g. "cloud").
    pub kind: String,
    /// The sandboxes' home directory; the same for every sandbox.
    pub home: String,
    /// How many jobs the service allows at once.
    #[serde(default)]
    pub max_jobs: Option<u32>,
    /// Poll background processes no more often than this.
    #[serde(default)]
    pub poll_seconds: Option<u64>,
    /// Runs before every job, after gespann is installed (`Sandboxes::job_script`).
    #[serde(default)]
    pub job_script: Option<String>,
    /// How to drive the sandbox's browser, for the prompts.
    #[serde(default)]
    pub tester_note: Option<String>,
}

pub struct Remote {
    base: String,
    token: String,
    http: reqwest::Client,
    info: Info,
    /// How long a call keeps trying while the service does not answer (a deploy).
    patience: Duration,
}

/// The service's error answer: `{ "error": "…" }`.
#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

impl Remote {
    /// Reads `/info`, waiting up to 10 minutes for the service to answer (it may deploy right now).
    pub async fn connect(url: &str, token: &str) -> Result<Remote> {
        let mut r = Remote { base: url.trim_end_matches('/').to_string(), token: token.to_string(), http: client()?, info: Info::default(), patience: Duration::from_secs(10 * 60) };
        let info: Info = serde_json::from_value(r.call(Method::GET, "/info", None).await.context("sandbox service")?).context("sandbox service: /info")?;
        if info.home.is_empty() || !info.home.starts_with('/') {
            bail!("sandbox service: /info has no absolute home");
        }
        r.info = info;
        Ok(r)
    }

    /// For tests: a service that answers at once, or not at all.
    pub fn with_patience(mut self, patience: Duration) -> Remote {
        self.patience = patience;
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// One call. Retries while the service is unreachable (connection refused) or says nothing ran
    /// (503), which no request can have started. 429, 502 and 504 may come after a POST already created
    /// a sandbox or started a command, so only reads and deletes, which are safe to repeat, retry on them.
    async fn send(&self, method: Method, path: &str, body: Option<&Value>) -> Result<reqwest::Response> {
        let started = Instant::now();
        let mut wait = Duration::from_millis(500);
        let repeatable = method == Method::GET || method == Method::DELETE;
        loop {
            let mut req = self.http.request(method.clone(), self.url(path)).bearer_auth(&self.token);
            if let Some(b) = body {
                req = req.json(b);
            }
            let retry_why = match req.send().await {
                Ok(res)
                    if res.status() == StatusCode::SERVICE_UNAVAILABLE
                        || (repeatable && matches!(res.status(), StatusCode::TOO_MANY_REQUESTS | StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT)) =>
                {
                    format!("{}", res.status())
                }
                Ok(res) => return Ok(res),
                Err(e) if e.is_connect() => format!("{e}"),
                Err(e) => return Err(anyhow!("sandbox service {method} {path}: {e}")),
            };
            if started.elapsed() + wait > self.patience {
                bail!("sandbox service {method} {path}: no answer for {} s ({retry_why})", started.elapsed().as_secs());
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(15));
        }
    }

    /// A JSON call; a non-2xx answer is an error with the service's message.
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let res = self.send(method.clone(), path, body.as_ref()).await?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("sandbox service {method} {path}: {status} {}", error_text(&text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("sandbox service {method} {path}: not JSON"))
    }

    /// `call`, but a 404 is None.
    async fn call_opt(&self, method: Method, path: &str, body: Option<Value>) -> Result<Option<Value>> {
        let res = self.send(method.clone(), path, body.as_ref()).await?;
        let status = res.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("sandbox service {method} {path}: {status} {}", error_text(&text));
        }
        Ok(Some(serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    fn sandbox(id: &str) -> String {
        format!("/sandboxes/{}", enc(id))
    }
}

fn client() -> Result<reqwest::Client> {
    // Generous: `running` may wait for a stopped sandbox to resume, `exec` for a command's timeout.
    Ok(reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30 * 60)).build()?)
}

fn error_text(text: &str) -> String {
    let msg = serde_json::from_str::<ErrorBody>(text).ok().and_then(|b| b.error).unwrap_or_else(|| text.to_string());
    msg.chars().take(500).collect()
}

/// Percent-encodes everything but unreserved characters, for a path segment or a query value.
fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

#[async_trait]
impl Sandboxes for Remote {
    fn kind(&self) -> &str {
        if self.info.kind.is_empty() {
            "remote"
        } else {
            &self.info.kind
        }
    }

    async fn create(&self, opts: CreateOpts) -> Result<String> {
        let labels: serde_json::Map<String, Value> = opts.labels.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
        let purpose = match opts.purpose {
            Purpose::Project => "project",
            Purpose::Login => "login",
        };
        let r = self.call(Method::POST, "/sandboxes", Some(json!({ "name": opts.name, "purpose": purpose, "labels": labels, "ttlSeconds": opts.ttl_seconds }))).await?;
        let id = str_of(&r, "id");
        if id.is_empty() {
            bail!("sandbox service: POST /sandboxes answered no id");
        }
        Ok(id)
    }

    async fn exists(&self, id: &str) -> Result<bool> {
        Ok(self.call_opt(Method::GET, &Self::sandbox(id), None).await?.is_some())
    }

    fn home(&self, _id: &str) -> String {
        self.info.home.clone()
    }

    async fn ensure_running(&self, id: &str) -> Result<()> {
        self.call(Method::POST, &format!("{}/running", Self::sandbox(id)), Some(json!({}))).await.map(|_| ())
    }

    async fn keep_alive(&self, id: &str) -> Result<()> {
        self.call(Method::POST, &format!("{}/keep-alive", Self::sandbox(id)), Some(json!({}))).await.map(|_| ())
    }

    async fn stop(&self, id: &str) -> Result<()> {
        self.call(Method::POST, &format!("{}/stop", Self::sandbox(id)), Some(json!({}))).await.map(|_| ())
    }

    async fn remove(&self, id: &str) -> Result<()> {
        self.call_opt(Method::DELETE, &Self::sandbox(id), None).await.map(|_| ())
    }

    async fn exec(&self, id: &str, command: &str, timeout_secs: u64) -> Result<CommandResult> {
        let r = self.call(Method::POST, &format!("{}/exec", Self::sandbox(id)), Some(json!({ "command": command, "timeoutSeconds": timeout_secs }))).await?;
        let timed_out = r.get("timedOut").and_then(Value::as_bool).unwrap_or(false);
        Ok(CommandResult {
            exit_code: if timed_out { None } else { r.get("exitCode").and_then(Value::as_i64).map(|c| c as i32) },
            stdout: str_of(&r, "stdout"),
            stderr: str_of(&r, "stderr"),
            timed_out,
        })
    }

    async fn start(&self, id: &str, command: &str) -> Result<u64> {
        let r = self.call(Method::POST, &format!("{}/processes", Self::sandbox(id)), Some(json!({ "command": command }))).await?;
        r.get("pid").and_then(Value::as_u64).ok_or_else(|| anyhow!("sandbox service: POST processes answered no pid"))
    }

    async fn status(&self, id: &str, pid: u64, tail_bytes: usize) -> Result<ProcessStatus> {
        let r = self.call(Method::GET, &format!("{}/processes/{pid}?tailBytes={tail_bytes}", Self::sandbox(id)), None).await?;
        let state = match r.get("state").and_then(Value::as_str) {
            Some("running") => ProcState::Running,
            Some("exited") => ProcState::Exited,
            Some("lost") => ProcState::Lost,
            other => bail!("sandbox service: process state {other:?}"),
        };
        Ok(ProcessStatus { state, exit_code: r.get("exitCode").and_then(Value::as_i64).map(|c| c as i32), stdout: str_of(&r, "stdout"), stderr: str_of(&r, "stderr") })
    }

    async fn kill(&self, id: &str, pid: u64) -> Result<()> {
        self.call_opt(Method::DELETE, &format!("{}/processes/{pid}", Self::sandbox(id)), None).await.map(|_| ())
    }

    async fn read_file(&self, id: &str, path: &str) -> Result<Option<String>> {
        let r = self.call_opt(Method::GET, &format!("{}/file?path={}", Self::sandbox(id), enc(path)), None).await?;
        Ok(r.map(|v| str_of(&v, "content")))
    }

    async fn write_file(&self, id: &str, path: &str, content: &[u8]) -> Result<()> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(content);
        self.call(Method::PUT, &format!("{}/file", Self::sandbox(id)), Some(json!({ "path": path, "base64": b64 }))).await.map(|_| ())
    }

    async fn download(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let p = format!("{}/download?path={}", Self::sandbox(id), enc(path));
        let res = self.send(Method::GET, &p, None).await?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            bail!("sandbox service GET {p}: {status} {}", error_text(&text));
        }
        Ok(res.bytes().await?.to_vec())
    }

    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        Ok(None)
    }

    async fn start_recording(&self, id: &str, file: &str) -> Result<()> {
        self.call(Method::POST, &format!("{}/recording", Self::sandbox(id)), Some(json!({ "file": file }))).await.map(|_| ())
    }

    async fn stop_recording(&self, id: &str) -> Result<()> {
        self.call_opt(Method::DELETE, &format!("{}/recording", Self::sandbox(id)), None).await.map(|_| ())
    }

    fn job_script(&self, _home: &str) -> Option<String> {
        self.info.job_script.clone().filter(|s| !s.trim().is_empty())
    }

    fn tester_note(&self) -> Option<String> {
        self.info.tester_note.clone().filter(|s| !s.trim().is_empty())
    }

    fn max_jobs(&self) -> Option<u32> {
        self.info.max_jobs
    }

    fn min_poll(&self) -> Duration {
        Duration::from_secs(self.info.poll_seconds.unwrap_or(0).min(60))
    }
}
