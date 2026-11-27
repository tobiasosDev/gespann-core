//! Sign-ins of the agents that are not Codex: GitHub Copilot and Grok sign in with a device code, like
//! `codex login --device-auth`, in a short-lived login sandbox.
//!
//! Copilot: `copilot login --device-code` stores a GitHub OAuth token (plaintext, as asked in its
//! settings.json); gespann keeps that token as the user's Copilot key, so a job uses it like a pasted one.
//!
//! Grok: `grok login --device-auth` writes `~/.grok/auth.json`, an OIDC access token that lasts 6 hours
//! and a refresh token. gespann keeps the file sealed, refreshes it itself (one refresh per owner at a
//! time) when it would run out within a step, and writes it into the sandbox only while a step runs.

use std::future::Future;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures::future::BoxFuture;
use serde_json::{json, Value as Json};

use crate::codex::{login_progress, open, seal, Provider};
use crate::db::{opt_text, text};
use crate::journal::Journal;
use crate::sandbox::scripts::q;
use crate::sandbox::{run_long, CreateOpts, Purpose, Sandboxes, WaitOpts};
use crate::Ctx;

/// Grok's sign-in in the sandbox's home while a step runs.
pub const GROK_AUTH_FILE: &str = ".grok/auth.json";
/// A Grok sign-in that runs out within this is refreshed before a step: longer than the longest step.
pub const GROK_REFRESH_WITHIN_MS: i64 = 3 * 3_600_000;
const XAI_TOKEN_ENDPOINT: &str = "https://auth.x.ai/oauth2/token";

/// The users columns of a provider's sign-in: its state and the progress the UI shows.
fn columns(provider: Provider) -> Result<(&'static str, &'static str)> {
    match provider {
        Provider::Copilot => Ok(("copilot_login_state", "copilot_login")),
        Provider::Grok => Ok(("grok_login_state", "grok_login")),
        _ => bail!("{} has no sign-in here", provider.agent_name()),
    }
}

/// The shell command of the sign-in: installs the CLI in the login sandbox if needed, then waits for the code.
fn login_command(provider: Provider) -> &'static str {
    match provider {
        // Without a keychain Copilot stores the token only when its settings allow plaintext.
        Provider::Copilot => {
            r#"mkdir -p ~/.copilot && printf '{"storeTokenPlaintext": true}\n' > ~/.copilot/settings.json && { command -v copilot >/dev/null 2>&1 || npm install -g --no-audit --no-fund @github/copilot >/dev/null 2>&1; } && copilot login --device-code 2>&1"#
        }
        _ => r#"export PATH="$HOME/.grok/bin:$PATH"; { command -v grok >/dev/null 2>&1 || curl -fsSL https://x.ai/cli/install.sh | bash >/dev/null 2>&1; } && grok login --device-auth 2>&1"#,
    }
}

/// The GitHub token and login in Copilot's `~/.copilot/config.json` (JSON with `//` comment lines).
pub fn copilot_token(config: &str) -> Option<(String, String)> {
    let body: String = config.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let v: Json = serde_json::from_str(&body).ok()?;
    let token = v.get("authTokens")?.as_object()?.values().find_map(|t| t.get("token")?.as_str().filter(|s| !s.is_empty()))?.to_string();
    let login = v.pointer("/lastLoggedInUser/login").and_then(|l| l.as_str()).unwrap_or("").to_string();
    Some((token, login))
}

/// The one account entry of Grok's auth.json (`{"<issuer>::<client>": {key, refresh_token, …}}`).
fn grok_entry(auth: &str) -> Option<(String, serde_json::Map<String, Json>)> {
    let v: Json = serde_json::from_str(auth).ok()?;
    let (k, e) = v.as_object()?.iter().find(|(_, e)| e.get("refresh_token").and_then(|r| r.as_str()).is_some_and(|r| !r.is_empty()))?;
    Some((k.clone(), e.as_object()?.clone()))
}

fn rfc3339_ms(e: &serde_json::Map<String, Json>, field: &str) -> i64 {
    e.get(field).and_then(|s| s.as_str()).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map_or(0, |t| t.timestamp_millis())
}

/// When the Grok sign-in's access token runs out, in ms since the epoch; 0 when unknown.
pub fn grok_expires_at(auth: &str) -> i64 {
    grok_entry(auth).map_or(0, |(_, e)| rfc3339_ms(&e, "expires_at"))
}

/// When the Grok sign-in was made or last refreshed; a copy refreshed later is newer.
pub fn grok_created_at(auth: &str) -> i64 {
    grok_entry(auth).map_or(0, |(_, e)| rfc3339_ms(&e, "create_time"))
}

/// The account of a Grok sign-in, for Settings: its email, or its user id.
pub fn grok_account(auth: &str) -> Option<String> {
    let (_, e) = grok_entry(auth)?;
    ["email", "user_id"].iter().find_map(|f| e.get(*f).and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(str::to_string))
}

/// The auth.json after a refresh: the new access token, its expiry and the refresh token xAI returned.
pub fn grok_refreshed(auth: &str, answer: &Json, now_ms: i64) -> Result<String> {
    let mut v: Json = serde_json::from_str(auth)?;
    let (k, _) = grok_entry(auth).ok_or_else(|| anyhow!("not a Grok sign-in"))?;
    let access = answer.get("access_token").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).ok_or_else(|| anyhow!("xAI returned no access token"))?;
    let expires_in = answer.get("expires_in").and_then(|n| n.as_i64()).unwrap_or(6 * 3600);
    let at = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    let e = v.get_mut(&k).and_then(|e| e.as_object_mut()).ok_or_else(|| anyhow!("not a Grok sign-in"))?;
    e.insert("key".into(), json!(access));
    e.insert("create_time".into(), json!(at(now_ms)));
    e.insert("expires_at".into(), json!(at(now_ms + expires_in * 1000)));
    if let Some(r) = answer.get("refresh_token").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
        e.insert("refresh_token".into(), json!(r));
    }
    Ok(serde_json::to_string(&v)?)
}

/// Exchanges the sign-in's refresh token at xAI's token endpoint (a public OIDC client, as Grok's CLI does).
pub async fn refresh_grok(endpoint: &str, auth: &str, now_ms: i64) -> Result<String> {
    let (_, e) = grok_entry(auth).ok_or_else(|| anyhow!("not a Grok sign-in"))?;
    let refresh = e.get("refresh_token").and_then(|t| t.as_str()).unwrap_or("");
    let client = e.get("oidc_client_id").and_then(|t| t.as_str()).unwrap_or("");
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?
        .post(endpoint)
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", client)])
        .send()
        .await
        .map_err(|e| anyhow!("xAI did not answer: {e}"))?;
    let status = res.status();
    let answer: Json = res.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        let why = answer.get("error_description").or_else(|| answer.get("error")).and_then(|s| s.as_str()).unwrap_or("");
        bail!("xAI refused to refresh the Grok sign-in ({status}{}); sign in with xAI again in Settings", if why.is_empty() { String::new() } else { format!(": {why}") });
    }
    grok_refreshed(auth, &answer, now_ms)
}

/// The owner's Grok sign-in, refreshed first when it would run out within a step. One refresh per
/// owner at a time: xAI may hand out each refresh token once.
pub async fn fresh_grok_auth(ctx: &Ctx, owner_id: i64) -> Result<String> {
    let current = || -> Result<(String, String)> {
        let sealed = ctx.db.grok_auth(owner_id)?.ok_or_else(|| anyhow!("Sign in with xAI or add an xAI API key in Settings first: the tester runs in the Grok CLI on it."))?;
        let auth = open(&ctx.cfg.session_secret, &sealed)?;
        Ok((sealed, auth))
    };
    let now = chrono::Utc::now().timestamp_millis();
    let (_, auth) = current()?;
    if grok_expires_at(&auth) - now > GROK_REFRESH_WITHIN_MS {
        return Ok(auth);
    }
    let _guard = ctx.locks.lock("grok-refresh", owner_id).await;
    // Another job of the owner may have refreshed it meanwhile.
    let (sealed, auth) = current()?;
    let now = chrono::Utc::now().timestamp_millis();
    if grok_expires_at(&auth) - now > GROK_REFRESH_WITHIN_MS {
        return Ok(auth);
    }
    let fresh = refresh_grok(XAI_TOKEN_ENDPOINT, &auth, now).await?;
    // Stored only over the sign-in it came from: a sign-out or a new sign-in meanwhile wins.
    if ctx.db.update_user_if(owner_id, &[("grok_auth", text(seal(&ctx.cfg.session_secret, &fresh)))], "grok_auth", Some(&sealed))? {
        return Ok(fresh);
    }
    Ok(current()?.1)
}

/// Keeps a Grok sign-in that the CLI refreshed during a step, unless the stored one is newer.
pub fn keep_grok(ctx: &Ctx, owner_id: i64, auth: &str) -> Result<bool> {
    let Some(sealed) = ctx.db.grok_auth(owner_id)? else { return Ok(false) };
    let stored = open(&ctx.cfg.session_secret, &sealed)?;
    if auth == stored || grok_entry(auth).is_none() || grok_created_at(auth) <= grok_created_at(&stored) {
        return Ok(false);
    }
    // A copy of another xAI account (the owner signed in again with another one) never replaces the current one.
    // Only a copy that names the same account: without a user id it is not kept.
    let user = |a: &str| grok_entry(a).and_then(|(_, e)| e.get("user_id").and_then(|u| u.as_str()).filter(|u| !u.is_empty()).map(str::to_string));
    if user(auth).is_none() || user(auth) != user(&stored) {
        return Ok(false);
    }
    ctx.db.update_user_if(owner_id, &[("grok_auth", text(seal(&ctx.cfg.session_secret, auth)))], "grok_auth", Some(&sealed))
}

fn auth_file(sb: &dyn Sandboxes, id: &str) -> String {
    format!("{}/{GROK_AUTH_FILE}", sb.home(id))
}

/// Runs `f` (a Grok step) with the owner's Grok sign-in in the sandbox. Under the journal key `key`:
/// written once per step, so a takeover attaches to the running step without writing it again.
pub async fn with_grok_auth<T, F, Fut>(ctx: &Ctx, j: &Journal, key: &str, owner_id: i64, sandbox_id: &str, f: F) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let done = format!("{key}.done");
    if j.step_done(&done)? {
        return f().await;
    }
    let sandboxes = ctx.sandboxes_for(owner_id)?;
    let sb = sandboxes.as_ref();
    let file = auth_file(sb, sandbox_id);
    let outcome = async {
        j.step(&format!("{key}.grok"), || async {
            let auth = fresh_grok_auth(ctx, owner_id).await?;
            sb.exec(sandbox_id, &format!("mkdir -p ~/.grok && umask 077 && : > {}", q(&file)), 30).await?;
            sb.write_file(sandbox_id, &file, auth.as_bytes()).await?;
            Ok(true)
        })
        .await?;
        f().await
    }
    .await;
    if let Ok(Some(after)) = sb.read_file(sandbox_id, &file).await {
        if let Err(e) = keep_grok(ctx, owner_id, &after) {
            crate::log("warn", &format!("could not keep the refreshed Grok sign-in of user {owner_id}: {e:#}"));
        }
    }
    let _ = sb.exec(sandbox_id, &format!("rm -f {}", q(&file)), 30).await;
    if outcome.is_ok() {
        j.step(&done, || async { Ok(true) }).await?;
    }
    outcome
}

/// The device-code sign-in of `provider` (Copilot or Grok) for a user whose sign-in is pending.
pub async fn run_agent_login(ctx: &Ctx, user_id: i64, provider: Provider) -> Result<()> {
    let (state, progress) = columns(provider)?;
    // Only while the sign-in is still wanted: after a sign-out the user sees no failure of the old attempt.
    let failed = |lines: String| -> Result<()> {
        ctx.db.update_user_if(user_id, &[(state, text("failed")), (progress, text(json!({ "url": null, "code": null, "lines": lines }).to_string()))], state, Some("pending")).map(|_| ())
    };
    let sandboxes = match ctx.sandboxes_for(user_id) {
        Ok(sb) => sb,
        Err(e) => {
            failed(format!("{e:#}"))?;
            return Err(e);
        }
    };
    let sb = sandboxes.as_ref();
    let mut id: Option<String> = None;
    let result = login(ctx, sb, user_id, provider, &mut id).await;
    if let Err(e) = &result {
        failed(sb.public(&format!("{e:#}")))?;
    }
    if let Some(id) = id {
        let _ = sb.remove(&id).await;
    }
    result
}

async fn login(ctx: &Ctx, sb: &dyn Sandboxes, user_id: i64, provider: Provider, id_out: &mut Option<String>) -> Result<()> {
    let (state, progress) = columns(provider)?;
    let cli = provider.cli().unwrap_or("agent");
    let id = sb
        .create(CreateOpts { name: format!("gespann-login-{cli}-{user_id}"), purpose: Purpose::Login, labels: vec![("gespann_login".into(), user_id.to_string())], ttl_seconds: Some(1800) })
        .await?;
    *id_out = Some(id.clone());
    sb.ensure_running(&id).await?;
    let db = ctx.db.clone();
    let tick = move |tail: String| -> BoxFuture<'_, ()> {
        let db = db.clone();
        Box::pin(async move {
            let _ = db.set_codex(user_id, &[(progress, text(login_progress(&tail).to_string()))]);
        })
    };
    let never = || false;
    let opts = WaitOpts { deadline: chrono::Utc::now() + chrono::Duration::minutes(15), cancelled: &never, on_tick: Some(&tick), poll: Duration::from_secs(2) };
    let result = run_long(sb, &id, login_command(provider), opts).await?;
    if result.exit_code != Some(0) {
        if result.timed_out {
            bail!("The code was not confirmed within 15 minutes.");
        }
        let tail = &result.tail;
        let start = tail.char_indices().rev().nth(599).map(|(i, _)| i).unwrap_or(0);
        bail!("{cli} login ended without a sign-in: {}", &tail[start..]);
    }
    let home = sb.home(&id);
    let secret = &ctx.cfg.session_secret;
    if provider == Provider::Copilot {
        let config = sb.read_file(&id, &format!("{home}/.copilot/config.json")).await?.unwrap_or_default();
        let (token, login) = copilot_token(&config).ok_or_else(|| anyhow!("copilot login stored no token"))?;
        let label = if login.is_empty() { "GitHub (signed in)".to_string() } else { format!("GitHub @{login} (signed in)") };
        // Only while this sign-in is still wanted: a key pasted or a sign-out meanwhile wins.
        ctx.db.update_user_if(user_id, &[("copilot_key", text(seal(secret, &token))), ("copilot_label", text(label)), (state, text("connected")), (progress, opt_text(None::<String>))], state, Some("pending"))?;
    } else {
        let auth = sb.read_file(&id, &format!("{home}/{GROK_AUTH_FILE}")).await?.unwrap_or_default();
        let account = grok_account(&auth).ok_or_else(|| anyhow!("grok login wrote no sign-in"))?;
        // A pasted key would win over the sign-in: signing in replaces it.
        ctx.db.update_user_if(
            user_id,
            &[
                ("grok_auth", text(seal(secret, &auth))),
                ("grok_key", opt_text(None::<String>)),
                ("grok_label", text(format!("xAI account {account}"))),
                (state, text("connected")),
                (progress, opt_text(None::<String>)),
            ],
            state,
            Some("pending"),
        )?;
    }
    ctx.db.auto_setup(user_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROK: &str = r#"{"https://auth.x.ai::client-1":{"key":"old-access","auth_mode":"oidc","create_time":"2026-11-27T07:21:22.239295Z","user_id":"u-1","email":"t@example.com","refresh_token":"refresh-1","expires_at":"2026-11-27T13:21:22.239295Z","oidc_issuer":"https://auth.x.ai","oidc_client_id":"client-1"}}"#;

    #[test]
    fn copilot_token_from_its_config() {
        // The file `copilot login` writes with storeTokenPlaintext (1.0.116), token shortened.
        let config = "// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  \"authTokens\": {\n    \"https://github.com:tobi:github\": { \"token\": \"gho_abc\" },\n    \"https://github.com:tobi\": { \"token\": \"gho_abc\" }\n  },\n  \"lastLoggedInUser\": { \"host\": \"https://github.com\", \"login\": \"tobi\" }\n}\n";
        assert_eq!(copilot_token(config), Some(("gho_abc".into(), "tobi".into())));
        assert_eq!(copilot_token("{}"), None);
        assert_eq!(copilot_token("not json"), None);
    }

    #[test]
    fn grok_sign_in_times_and_refresh() {
        assert_eq!(grok_expires_at(GROK), chrono::DateTime::parse_from_rfc3339("2026-11-27T13:21:22.239295Z").unwrap().timestamp_millis());
        assert_eq!(grok_account(GROK).as_deref(), Some("t@example.com"));
        assert_eq!(grok_expires_at("{}"), 0, "unknown: refreshed");
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T12:00:00Z").unwrap().timestamp_millis();
        let fresh = grok_refreshed(GROK, &json!({ "access_token": "new-access", "expires_in": 21600, "refresh_token": "refresh-2" }), now).unwrap();
        let (_, e) = grok_entry(&fresh).unwrap();
        assert_eq!((e["key"].as_str(), e["refresh_token"].as_str(), e["email"].as_str()), (Some("new-access"), Some("refresh-2"), Some("t@example.com")));
        assert_eq!(grok_expires_at(&fresh), now + 21_600_000);
        assert!(grok_created_at(&fresh) > grok_created_at(GROK), "the refreshed copy is newer");
        // xAI may keep the refresh token: the old one stays.
        let kept = grok_refreshed(GROK, &json!({ "access_token": "a2" }), now).unwrap();
        assert_eq!(grok_entry(&kept).unwrap().1["refresh_token"].as_str(), Some("refresh-1"));
        assert!(grok_refreshed(GROK, &json!({}), now).is_err());
    }

    #[test]
    fn login_progress_reads_github_and_xai_codes() {
        let gh = login_progress("To authenticate, visit https://github.com/login/device and enter code 3E79-76B6\nWaiting for authorization...\n");
        assert_eq!((gh["url"].as_str(), gh["code"].as_str()), (Some("https://github.com/login/device"), Some("3E79-76B6")));
        let x = login_progress("To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=MVHA-KJGG\n\nConfirm this code in your browser:\n\n  MVHA-KJGG\n");
        assert_eq!((x["url"].as_str(), x["code"].as_str()), (Some("https://accounts.x.ai/oauth2/device?user_code=MVHA-KJGG"), Some("MVHA-KJGG")));
    }

    /// Refreshes a real Grok sign-in: `GROK_AUTH_FILE=/path/to/auth.json cargo test -- --ignored`.
    /// Writes the refreshed sign-in back to that file, so a CLI using it keeps working.
    #[tokio::test]
    #[ignore]
    async fn refresh_a_real_grok_sign_in() {
        let path = std::env::var("GROK_AUTH_FILE").expect("GROK_AUTH_FILE");
        let auth = std::fs::read_to_string(&path).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let fresh = refresh_grok(XAI_TOKEN_ENDPOINT, &auth, now).await.unwrap();
        assert!(grok_expires_at(&fresh) > now + 3_600_000, "a new access token for hours");
        assert_ne!(grok_entry(&fresh).unwrap().1["key"], grok_entry(&auth).unwrap().1["key"]);
        std::fs::write(&path, &fresh).unwrap();
        println!("refreshed: expires {}", grok_entry(&fresh).unwrap().1["expires_at"]);
    }
}
