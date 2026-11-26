//! Client of the UI's internal API (docs/orchestrator.md). Everything that needs GitHub or the server
//! module goes through here. Calls retry with backoff while the UI is down (a deploy), up to 20 minutes,
//! except `check`, which is best effort.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pull {
    /// "open" or "closed".
    pub state: String,
    pub merged: bool,
    pub head: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub url: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub pr_text: String,
    pub issues: Vec<Issue>,
    pub issues_md: String,
    pub unread: Option<String>,
}

#[derive(Clone)]
pub struct Ui {
    base: String,
    token: String,
    http: reqwest::Client,
    /// How long a call keeps retrying while the UI does not answer.
    patience: std::time::Duration,
}

/// `hex(sha256("gespann-internal:" + secret))`, the same on both sides.
pub fn internal_token(session_secret: &str) -> String {
    hex::encode(Sha256::digest(format!("gespann-internal:{session_secret}").as_bytes()))
}

/// Why one attempt failed, and whether trying again can help.
enum Failure {
    Retry(anyhow::Error),
    Fatal(anyhow::Error),
}

const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// One request; the UI answers within this or the attempt counts as a connection error.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

impl Ui {
    pub fn new(base: &str, session_secret: &str) -> Ui {
        let http = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().unwrap_or_default();
        Ui { base: base.trim_end_matches('/').to_string(), token: internal_token(session_secret), http, patience: std::time::Duration::from_secs(20 * 60) }
    }

    /// For tests: give up sooner.
    pub fn with_patience(mut self, patience: std::time::Duration) -> Ui {
        self.patience = patience;
        self
    }

    async fn attempt(&self, post: bool, path: &str, body: &Value) -> std::result::Result<Value, Failure> {
        let url = format!("{}{path}", self.base);
        let req = if post { self.http.post(&url).json(body) } else { self.http.get(&url) };
        let res = req.bearer_auth(&self.token).send().await.map_err(|e| Failure::Retry(anyhow!("{} {path}: {e}", if post { "POST" } else { "GET" })))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| Failure::Retry(anyhow!("{path}: reading the answer: {e}")))?;
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(json!({}));
            }
            return serde_json::from_str(&text).map_err(|e| Failure::Fatal(anyhow!("{path}: the UI answered no JSON ({e}): {}", clip(&text))));
        }
        let err = anyhow!("{path}: the UI answered {}: {}", status.as_u16(), clip(&text));
        if status.is_server_error() || status.as_u16() == 429 {
            Err(Failure::Retry(err))
        } else {
            Err(Failure::Fatal(err))
        }
    }

    /// Calls the UI, retrying connection errors, 5xx and 429 with backoff (1 s doubling to 30 s) while
    /// `patience` lasts, or at most `tries` times when given.
    async fn call(&self, post: bool, path: &str, body: Value, tries: Option<u32>) -> Result<Value> {
        let start = Instant::now();
        let mut wait = FIRST_BACKOFF;
        let mut n = 0u32;
        loop {
            n += 1;
            match self.attempt(post, path, &body).await {
                Ok(v) => return Ok(v),
                Err(Failure::Fatal(e)) => return Err(e),
                Err(Failure::Retry(e)) => {
                    let out_of_tries = tries.is_some_and(|t| n >= t);
                    if out_of_tries || start.elapsed() + wait > self.patience {
                        return Err(e.context(format!("gave up after {n} tries in {} s", start.elapsed().as_secs())));
                    }
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(MAX_BACKOFF);
                }
            }
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.call(true, path, body, None).await
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.call(false, path, Value::Null, None).await
    }

    /// The server module's answer: None lets the job start, Some(reason) refuses it.
    pub async fn admit(&self, job_id: i64) -> Result<Option<String>> {
        let v = self.post(&format!("/internal/jobs/{job_id}/admit"), json!({})).await?;
        Ok(v.get("refused").and_then(Value::as_str).map(str::to_string))
    }
    pub async fn ended(&self, job_id: i64) -> Result<()> {
        self.post(&format!("/internal/jobs/{job_id}/ended"), json!({})).await.map(|_| ())
    }
    /// The run's PR; None when GitHub did not answer.
    pub async fn pull(&self, run_id: i64) -> Result<Option<Pull>> {
        let v = self.get(&format!("/internal/runs/{run_id}/pull")).await?;
        match v.get("pull") {
            None | Some(Value::Null) => Ok(None),
            Some(p) => Ok(Some(serde_json::from_value(p.clone())?)),
        }
    }
    /// True when the UI skipped the run: the PR is still merged or closed when it asked GitHub again.
    pub async fn skip_closed(&self, run_id: i64) -> Result<bool> {
        let v = self.post(&format!("/internal/runs/{run_id}/skip-closed"), json!({})).await?;
        Ok(v.get("skipped").and_then(Value::as_bool).unwrap_or(false))
    }
    /// Best effort: errors are swallowed after a few tries.
    pub async fn check(&self, run_id: i64, title: &str, summary: &str) {
        let body = json!({ "title": title, "summary": summary });
        let _ = self.call(true, &format!("/internal/runs/{run_id}/check"), body, Some(3)).await;
    }
    /// The PR's other checks first: "go", "later" (the UI put the job back into the queue until they may
    /// have finished) or "skipped" (they failed; the UI ended the run as SKIP).
    pub async fn await_checks(&self, run_id: i64, job_id: i64) -> Result<String> {
        let v = self.post(&format!("/internal/runs/{run_id}/await-checks"), json!({ "jobId": job_id })).await?;
        match v.get("step").and_then(Value::as_str) {
            Some(s @ ("go" | "later" | "skipped")) => Ok(s.to_string()),
            _ => bail!("/internal/runs/{run_id}/await-checks answered {v}"),
        }
    }
    pub async fn git_token(&self, project_id: i64) -> Result<String> {
        let v = self.post(&format!("/internal/projects/{project_id}/git-token"), json!({})).await?;
        match v.get("token").and_then(Value::as_str) {
            Some(t) if !t.is_empty() => Ok(t.to_string()),
            _ => bail!("/internal/projects/{project_id}/git-token answered no token"),
        }
    }
    pub async fn context(&self, run_id: i64) -> Result<Context> {
        let v = self.get(&format!("/internal/runs/{run_id}/context")).await?;
        Ok(serde_json::from_value(v)?)
    }
    pub async fn report(&self, run_id: i64, job_id: i64, judged: Option<&Value>, files: &[String]) -> Result<()> {
        let body = json!({ "jobId": job_id, "judged": judged, "files": files });
        self.post(&format!("/internal/runs/{run_id}/report"), body).await.map(|_| ())
    }
}

fn clip(s: &str) -> String {
    let s = s.trim();
    match s.char_indices().nth(500) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}
