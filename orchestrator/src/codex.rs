//! One Codex sign-in per user: made in a short-lived login sandbox,
//! kept sealed in the database, written into a project sandbox only for the length of a Codex step and
//! read back afterwards, because Codex refreshes it in place.

use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use futures::future::BoxFuture;
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};

use rusqlite::types::Value;

use crate::db::{opt_text, text};
use crate::journal::Journal;
use crate::sandbox::{run_long, CreateOpts, Purpose, Sandboxes, WaitOpts};
use crate::Ctx;

/// Codex refreshes its sign-in once it is this old; each refresh token works once.
pub const REFRESH_AFTER_MS: i64 = 8 * 86_400_000;
/// A sign-in this close to its refresh is due.
pub const DUE_MARGIN_MS: i64 = 3 * 3_600_000;
/// How often a job's sandbox is checked for a sign-in Codex refreshed.
pub const WATCH_SECS: u64 = 15;

/// Node's `Buffer.from(s, "base64")` accepts missing padding; so does this.
const LENIENT: GeneralPurpose = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

fn cipher(secret: &str) -> Aes256Gcm {
    let key = Sha256::digest(format!("gespann-codex-auth:{secret}").as_bytes());
    Aes256Gcm::new_from_slice(&key).expect("32-byte key")
}

/// AES-256-GCM, key `sha256("gespann-codex-auth:" + secret)`, `base64(iv).base64(tag).base64(body)`:
/// readable by `open` in TypeScript and the other way round.
pub fn seal(secret: &str, plain: &str) -> String {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let mut out = cipher(secret).encrypt(Nonce::from_slice(&iv), plain.as_bytes()).expect("aes-gcm encrypt");
    // aes-gcm appends the 16-byte tag; TypeScript keeps it apart.
    let tag = out.split_off(out.len() - 16);
    [STANDARD.encode(iv), STANDARD.encode(tag), STANDARD.encode(out)].join(".")
}

pub fn open(secret: &str, sealed: &str) -> Result<String> {
    let parts: Vec<&str> = sealed.split('.').collect();
    let [iv, tag, body] = parts.as_slice() else { bail!("not a sealed Codex sign-in") };
    let iv = LENIENT.decode(iv)?;
    let mut data = LENIENT.decode(body)?;
    data.extend(LENIENT.decode(tag)?);
    if iv.len() != 12 {
        bail!("not a sealed Codex sign-in (iv of {} bytes)", iv.len());
    }
    let plain = cipher(secret).decrypt(Nonce::from_slice(&iv), data.as_slice()).map_err(|_| anyhow!("the Codex sign-in cannot be opened with this SESSION_SECRET"))?;
    Ok(String::from_utf8(plain)?)
}

/// `refreshedAt`: auth.json's `last_refresh` in ms since the epoch; 0 when unknown.
pub fn refreshed_at(auth: &str) -> i64 {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(auth) else { return 0 };
    let Some(s) = v.get("last_refresh").and_then(|s| s.as_str()) else { return 0 };
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return t.timestamp_millis();
    }
    // Without an offset, as Date.parse reads a bare date-time (here: UTC).
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").map(|t| t.and_utc().timestamp_millis()).unwrap_or(0)
}

pub fn refresh_due(auth: &str, now_ms: i64) -> bool {
    now_ms - refreshed_at(auth) > REFRESH_AFTER_MS - DUE_MARGIN_MS
}

fn account(auth: &str) -> String {
    serde_json::from_str::<serde_json::Value>(auth)
        .ok()
        .and_then(|v| v.pointer("/tokens/account_id").and_then(|a| a.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const AUTH_FILE: &str = ".codex/auth.json";

fn auth_file(sb: &dyn Sandboxes, id: &str) -> String {
    format!("{}/{AUTH_FILE}", sb.home(id))
}

/// `keep`: stores a sign-in a job's Codex refreshed, unless another job of the owner already stored a
/// newer one (or the owner disconnected or switched accounts). True when it was stored.
pub fn keep(ctx: &Ctx, owner_id: i64, auth: &str) -> Result<bool> {
    if !auth.trim().starts_with('{') {
        return Ok(false);
    }
    let Some(sealed) = ctx.db.codex_auth(owner_id)? else { return Ok(false) };
    let stored = open(&ctx.cfg.session_secret, &sealed)?;
    let (a, b) = (account(auth), account(&stored));
    if !a.is_empty() && !b.is_empty() && a != b {
        return Ok(false);
    }
    if auth == stored || refreshed_at(auth) < refreshed_at(&stored) {
        return Ok(false);
    }
    ctx.db.set_codex(owner_id, &[("codex_auth", text(seal(&ctx.cfg.session_secret, auth)))])?;
    Ok(true)
}

fn keep_logged(ctx: &Ctx, owner_id: i64, auth: &str) -> bool {
    keep(ctx, owner_id, auth).unwrap_or_else(|e| {
        crate::log("warn", &format!("could not keep the refreshed Codex sign-in of user {owner_id}: {e:#}"));
        false
    })
}

/// `withCodex`: the owner's sign-in in the sandbox while `f` runs, refreshed copies shared at once.
/// Under the journal key `key`: on a takeover the sign-in is not written again (Codex may have
/// refreshed the copy in the sandbox meanwhile), only watched and read back.
pub async fn with_codex<T, F, Fut>(ctx: &Ctx, j: &Journal, key: &str, owner_id: i64, sandbox_id: &str, f: F) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    // A Codex step that finished and gave its sign-in back (a takeover replays it): the sandbox's
    // auth.json may belong to the Codex step running now, so it is not touched.
    let done = format!("{key}.done");
    if j.step_done(&done)? {
        return f().await;
    }
    let current = || -> Result<String> {
        let sealed = ctx.db.codex_auth(owner_id)?.ok_or_else(|| anyhow!("Connect Codex in Settings first: the tester runs on your ChatGPT plan."))?;
        open(&ctx.cfg.session_secret, &sealed)
    };
    let mut before = current()?;
    // While a refresh is due, one job of the owner at a time starts Codex; the others wait until its
    // Codex refreshed (or it ended), then start with the new sign-in.
    let refreshing = Mutex::new(None);
    if refresh_due(&before, now_ms()) {
        let guard = ctx.locks.lock("codex-refresh", owner_id).await;
        before = current()?;
        if refresh_due(&before, now_ms()) {
            *refreshing.lock().expect("refresh guard") = Some(guard);
        }
    }
    let release = || drop(refreshing.lock().expect("refresh guard").take());
    let sb = ctx.sb.as_ref();
    let file = auth_file(sb, sandbox_id);
    let before = before;
    let outcome = async {
        j.step(&format!("{key}.auth"), || async {
            sb.exec(sandbox_id, "mkdir -p ~/.codex && umask 077 && : > ~/.codex/auth.json", 30).await?;
            sb.write_file(sandbox_id, &file, before.as_bytes()).await?;
            Ok(true)
        })
        .await?;
        // Shares a refresh while the job still runs, so jobs starting meanwhile get the new sign-in.
        let watcher = async {
            loop {
                tokio::time::sleep(Duration::from_secs(WATCH_SECS)).await;
                if let Ok(Some(now)) = sb.read_file(sandbox_id, &file).await {
                    if now != before && keep_logged(ctx, owner_id, &now) {
                        release();
                    }
                }
            }
        };
        tokio::select! {
            r = f() => r,
            _ = watcher => unreachable!("the watcher never ends"),
        }
    }
    .await;
    if let Ok(Some(after)) = sb.read_file(sandbox_id, &file).await {
        if after != before {
            keep_logged(ctx, owner_id, &after);
        }
    }
    release();
    let _ = sb.exec(sandbox_id, "rm -f ~/.codex/auth.json", 30).await;
    if outcome.is_ok() {
        j.step(&done, || async { Ok(true) }).await?;
    }
    outcome
}

/// Gives back the sign-in of Codex steps that never finished (a cancelled run taken over mid-test): a
/// copy Codex refreshed is kept, and auth.json leaves the sandbox, as `with_codex` would have done. No
/// Codex step of the job runs any more, so whatever auth.json the sandbox has is the job's, also one
/// written just before an orchestrator stopped. Scopes count as given back only once that worked.
pub async fn give_back(ctx: &Ctx, j: &Journal, owner_id: i64, sandbox_id: &str) -> Result<()> {
    let sb = ctx.sb.as_ref();
    if let Some(now) = sb.read_file(sandbox_id, &auth_file(sb, sandbox_id)).await? {
        keep_logged(ctx, owner_id, &now);
    }
    let rm = sb.exec(sandbox_id, "rm -f ~/.codex/auth.json", 30).await?;
    if rm.exit_code != Some(0) {
        anyhow::bail!("could not remove the Codex sign-in from the sandbox: {}", rm.stderr.trim());
    }
    for auth in ctx.db.step_keys(j.job_id, ".auth")? {
        let done = format!("{}.done", auth.trim_end_matches(".auth"));
        j.step(&done, || async { Ok(true) }).await?;
    }
    Ok(())
}

/// What `codex login --device-auth` printed so far: `{url, code, lines}` for the UI.
pub fn login_progress(tail: &str) -> serde_json::Value {
    static RE: OnceLock<(regex::Regex, regex::Regex, regex::Regex)> = OnceLock::new();
    let (ansi, url, code) = RE.get_or_init(|| {
        (
            regex::Regex::new(r"\x1b\[[0-9;]*m").expect("regex"),
            regex::Regex::new(r"https://\S*(?:auth\.openai\.com|chatgpt\.com)\S*").expect("regex"),
            regex::Regex::new(r"(?-u:\b)([A-Z0-9]{4,5}-[A-Z0-9]{4,6})(?-u:\b)").expect("regex"),
        )
    });
    let clean = ansi.replace_all(tail, "").to_string();
    let lines: Vec<&str> = clean.split('\n').collect();
    json!({
        "url": url.find(&clean).map(|m| m.as_str()),
        "code": code.captures(&clean).and_then(|c| c.get(1)).map(|m| m.as_str()),
        "lines": lines[lines.len().saturating_sub(12)..].join("\n"),
    })
}

/// `startLogin` without the UI: the device-code sign-in for a user whose `codex_state` is pending.
pub async fn run_login(ctx: &Ctx, user_id: i64) -> Result<()> {
    let sb = ctx.sb.as_ref();
    let mut id: Option<String> = None;
    let result = login(ctx, sb, user_id, &mut id).await;
    if let Err(e) = &result {
        let lines = format!("{e:#}");
        ctx.db.set_codex(user_id, &[("codex_state", text("failed")), ("codex_login", text(json!({ "url": null, "code": null, "lines": lines }).to_string()))])?;
    }
    // The sign-in sandbox never outlives the sign-in.
    if let Some(id) = id {
        let _ = sb.remove(&id).await;
    }
    result
}

async fn login(ctx: &Ctx, sb: &dyn Sandboxes, user_id: i64, id_out: &mut Option<String>) -> Result<()> {
    let id = sb
        .create(CreateOpts { name: format!("gespann-login-{user_id}"), purpose: Purpose::Login, labels: vec![("gespann_login".into(), user_id.to_string())], ttl_seconds: Some(1800) })
        .await?;
    *id_out = Some(id.clone());
    sb.ensure_running(&id).await?;
    let db = ctx.db.clone();
    let tick = move |tail: String| -> BoxFuture<'_, ()> {
        let db = db.clone();
        Box::pin(async move {
            let _ = db.set_codex(user_id, &[("codex_login", text(login_progress(&tail).to_string()))]);
        })
    };
    let never = || false;
    let opts = WaitOpts { deadline: chrono::Utc::now() + chrono::Duration::minutes(15), cancelled: &never, on_tick: Some(&tick), poll: Duration::from_secs(2) };
    let result = run_long(sb, &id, "codex login --device-auth 2>&1", opts).await?;
    let auth = if result.exit_code == Some(0) { sb.read_file(&id, &auth_file(sb, &id)).await? } else { None };
    let Some(auth) = auth.filter(|a| !a.is_empty()) else {
        if result.timed_out {
            bail!("The code was not confirmed within 15 minutes.");
        }
        let tail = &result.tail;
        let start = tail.char_indices().rev().nth(599).map(|(i, _)| i).unwrap_or(0);
        bail!("codex login ended without a sign-in: {}", &tail[start..]);
    };
    let status = sb.exec(&id, "codex login status 2>&1", 60).await?;
    let account: String = status.stdout.trim().chars().take(200).collect();
    let account = if account.is_empty() { "ChatGPT".to_string() } else { account };
    let fields: [(&str, Value); 4] = [
        ("codex_state", text("connected")),
        ("codex_login", opt_text(None::<String>)),
        ("codex_auth", text(seal(&ctx.cfg.session_secret, &auth))),
        ("codex_account", text(account)),
    ];
    ctx.db.set_codex(user_id, &fields)?;
    ctx.db.auto_setup(user_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_round_trip_and_wrong_secret() {
        let s = seal("k", "{\"a\":1}");
        assert_eq!(s.split('.').count(), 3);
        assert_eq!(open("k", &s).unwrap(), "{\"a\":1}");
        assert!(open("other", &s).is_err());
        assert!(open("k", "nope").is_err());
    }

    #[test]
    fn refresh_due_follows_last_refresh() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-26T12:00:00Z").unwrap().timestamp_millis();
        let at = |days: i64, hours: i64| {
            let t = chrono::DateTime::from_timestamp_millis(now - days * 86_400_000 - hours * 3_600_000).unwrap();
            json!({ "last_refresh": t.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string() }).to_string()
        };
        assert!(!refresh_due(&at(1, 0), now));
        assert!(!refresh_due(&at(7, 20), now), "8 days minus 4 hours: not yet");
        assert!(refresh_due(&at(7, 22), now), "within 3 hours of the refresh");
        assert!(refresh_due("{}", now), "unknown: due");
        assert!(refresh_due("not json", now));
        assert_eq!(refreshed_at(r#"{"last_refresh":"2026-11-26T12:00:00.123456789Z"}"#), now + 123);
    }

    #[test]
    fn login_progress_reads_url_and_code() {
        let tail = "Welcome\n\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\nEnter this code: \x1b[1mAB12-CD345\x1b[0m\n";
        let p = login_progress(tail);
        assert_eq!(p["url"], "https://auth.openai.com/codex/device");
        assert_eq!(p["code"], "AB12-CD345");
        assert!(p["lines"].as_str().unwrap().contains("Enter this code: AB12-CD345"));
        let p = login_progress("starting");
        assert!(p["url"].is_null() && p["code"].is_null());
    }
}
