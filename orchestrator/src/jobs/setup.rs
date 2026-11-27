//! Setup: Codex explores the repo once and writes the recipe and scripts for a fast production-near
//! copy; and the check, without Codex, that a recipe brings the copy up and down.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::json;

use super::boxes::{agent_for, agent_exec, ensure_repo, ensure_sandbox, git, last_json, long, recipe_check, save_bundle, stop_sandbox, with_env, write_prompt, Sbx};
use super::{cut, tail, Cx};
use crate::codex::with_agent;
use crate::db::{opt_text, text, Project};
use rusqlite::types::Value;
use crate::sandbox::scripts::q;

/// Codex explores the repo and writes the recipe. `pre` keeps the journal keys apart when a PR run
/// prepares the environment again (`again`): the project then stays ready, so PRs keep queueing.
pub(crate) async fn setup(cx: &Cx<'_>, p: &Project, pre: &str, again: bool) -> Result<()> {
    let db = &cx.ctx.db;
    if !again {
        db.update_project(p.id, &[("setup", text("running")), ("setup_error", Value::Null)])?;
    }
    let mut b: Option<Sbx> = None;
    let res = run_setup(cx, p, pre, &mut b).await;
    if let Err(e) = &res {
        if !again {
            let _ = db.update_project(p.id, &[("setup", text("failed")), ("setup_error", text(cut(&cx.public(&format!("{e:#}")), 4000)))]);
        } else if let Some(b) = &b {
            // A recipe that failed its check must not count as set up: the next PR tries again.
            let _ = cx.sb().exec(&b.id, &format!("rm -f {}", b.recipe), 30).await;
        }
    }
    if let Some(b) = &b {
        // Once: after a takeover in the PR run that follows, the sandbox runs that run's copy.
        let _ = cx
            .jr
            .step(&format!("{pre}stop"), || async move {
                stop_sandbox(cx, b).await;
                Ok(())
            })
            .await;
    }
    res
}

async fn run_setup(cx: &Cx<'_>, p: &Project, pre: &str, slot: &mut Option<Sbx>) -> Result<()> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    let k = |s: &str| format!("{pre}{s}");
    let b = &*slot.insert(ensure_sandbox(cx, p, &k("install")).await?);
    cx.jr
        .step(&k("checkout"), || async move {
            ensure_repo(cx, b, p).await?;
            git(cx, b, p, &format!("-C {} fetch --quiet origin {}", b.repo, q(&p.default_branch)), 600).await?;
            let co = sb.exec(&b.id, &format!("cd {} && git checkout --quiet --force --detach FETCH_HEAD && git clean -fdq && mkdir -p {} 2>&1", b.repo, b.project), 120).await?;
            if co.exit_code != Some(0) {
                bail!("checkout of {} failed: {}", p.default_branch, tail(&co.stdout, 800));
            }
            Ok(())
        })
        .await?;
    let prompt_file = format!("{}/setup-prompt.txt", b.gespann);
    cx.jr
        .step(&k("prompt"), || async {
            let mut input = json!({ "repo": p.repo, "repoDir": b.repo, "projectDir": b.project, "criteria": p.criteria });
            if crate::sandbox::Platform::parse(&p.platform) == crate::sandbox::Platform::Macos {
                input["platform"] = json!("macos");
            }
            if let Some(note) = sb.tester_note() {
                input["testerNote"] = json!(note);
            }
            write_prompt(cx, b, "setup", &input, &prompt_file).await
        })
        .await?;
    let agent = agent_for(cx, p).await?;
    let name = agent.provider.agent_name();
    cx.note(&k("log.codex"), &format!("{name} prepares the environment (this can take a while on the first build)")).await;
    let cancelled = || cx.stopped();
    let command = agent_exec(b, &prompt_file, &format!("{}/setup-last.txt", b.gespann), &format!("{}/setup.jsonl", b.gespann), &agent, "high");
    let codex_key = k("codex");
    let r = with_agent(cx.ctx, &cx.jr, &k("signin"), p.owner_id, cx.sb(), &b.id, &agent, || long(cx, b, &codex_key, &command, Duration::from_secs(120 * 60), &cancelled)).await?;
    let last = sb.read_file(&b.id, &format!("{}/setup-last.txt", b.gespann)).await?.unwrap_or_default();
    if !last.is_empty() {
        cx.log(&format!("{name}: {}", cut(&last, 4000)));
    }
    if r.exit_code != Some(0) {
        bail!("{}", if r.timed_out { "setup took longer than 2 hours".to_string() } else { format!("{name} exited {}: {}", super::boxes::js_code(r.exit_code), tail(&r.tail, 800)) });
    }
    let recipe = sb.read_file(&b.id, &b.recipe).await?.filter(|r| !r.is_empty()).ok_or_else(|| anyhow!("{name} wrote no {}", b.recipe))?;
    recipe_check(cx, b, &b.recipe).await?;
    let notes = sb.read_file(&b.id, &format!("{}/NOTES.md", b.project)).await?;
    let checks = sb.read_file(&b.id, &format!("{}/CHECKS.md", b.project)).await?.unwrap_or_default().trim().to_string();
    let proof_dir = format!("{}/projects/{}", cx.ctx.cfg.data_dir, p.id);
    std::fs::create_dir_all(&proof_dir)?;
    let proof = async { anyhow::Ok(std::fs::write(format!("{proof_dir}/setup-proof.png"), sb.download(&b.id, &format!("{}/setup-proof.png", b.project)).await?)?) };
    if proof.await.is_err() {
        cx.log("no setup-proof.png");
    }
    check_copy(cx, b, &k("check"), true).await?;
    cx.jr.step(&k("bundle"), || save_bundle(cx, p, b)).await?;
    // Codex's concrete checks become the project's checks unless the team wrote their own.
    let own = db.project(p.id)?.map(|p| p.criteria.trim().to_string()).unwrap_or_default();
    let mut fields = vec![("setup", text("ready")), ("recipe", text(recipe)), ("notes", opt_text(notes)), ("setup_error", Value::Null)];
    if own.is_empty() && !checks.is_empty() {
        fields.push(("criteria", text(cut(&checks, 8000))));
    }
    db.update_project(p.id, &fields)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct Prepared {
    ok: bool,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    run: Option<String>,
}

/// Independent check that the copy comes up from the recipe without Codex, answers, and goes down
/// without teardown errors. Runs on whatever the checkout has at HEAD. `pre` keys its steps.
pub(crate) async fn check_copy(cx: &Cx<'_>, b: &Sbx, pre: &str, cancellable: bool) -> Result<()> {
    let k = |s: &str| format!("{pre}.{s}");
    cx.note(&k("log"), "checking the recipe without Codex: prepare, check that the copy answers, tear down").await;
    let cancelled = || cancellable && cx.stopped();
    let prep = long(cx, b, &k("prepare"), &with_env(b, &format!("cd {} && gespann verify prepare --recipe {} --pr 0 --head HEAD --base HEAD", b.repo, b.recipe)), Duration::from_secs(60 * 60), &cancelled).await?;
    let line = last_json::<Prepared>(&prep.tail);
    let up = async {
        if prep.timed_out {
            bail!("{}", if cancelled() { "cancelled" } else { "the copy took longer than an hour to come up" });
        }
        let url = match &line {
            Some(Prepared { ok: true, url: Some(url), .. }) => url,
            _ => bail!("the recipe did not bring the copy up: {}", line.as_ref().and_then(|l| l.error.clone()).unwrap_or_else(|| tail(&prep.tail, 800))),
        };
        // Once: after a takeover past the teardown, the copy is down and would answer nothing.
        let http: String = cx
            .jr
            .step(&k("http"), || async move { Ok(cx.sb().exec(&b.id, &probe_command(url), 60).await?.stdout.trim().to_string()) })
            .await?;
        Ok((url.clone(), http))
    }
    .await;
    // As `finally` in TypeScript: a failed teardown is the error, else the error from before it.
    tear_down(cx, b, &k("finish"), line.as_ref().and_then(|l| l.run.as_deref())).await?;
    let (url, http) = up?;
    if let Some(bundle) = url.strip_prefix(SIMULATOR) {
        if http != "running" {
            bail!("the app {bundle} was not running in the booted iOS Simulator after prepare");
        }
        cx.log(&format!("the app {bundle} came up in the iOS Simulator and went down cleanly"));
        return Ok(());
    }
    let answered = http.len() == 3 && matches!(http.as_bytes()[0], b'2' | b'3') && http.bytes().all(|c| c.is_ascii_digit());
    if !answered {
        bail!("the copy answered HTTP {} at {url}", if http.is_empty() { "nothing" } else { &http });
    }
    cx.log(&format!("the copy came up at {url} (HTTP {http}) and went down cleanly"));
    Ok(())
}

/// An iOS app's copy: `env.url` names its bundle id on the booted simulator.
const SIMULATOR: &str = "ios-simulator://";

/// How the check sees that the copy answers: the URL's HTTP status, or for an iOS app "running" when
/// the booted simulator runs it.
fn probe_command(url: &str) -> String {
    match url.strip_prefix(SIMULATOR) {
        Some(bundle) => format!("xcrun simctl spawn booted launchctl list 2>/dev/null | grep -qF {} && echo running || echo stopped", q(&format!("UIKitApplication:{bundle}["))),
        None => format!("curl -s -o /dev/null -w '%{{http_code}}' --max-time 30 {}", q(url)),
    }
}

#[cfg(test)]
mod probe_tests {
    use super::probe_command;

    #[test]
    fn an_ios_app_is_checked_in_the_simulator_a_web_copy_over_http() {
        assert_eq!(probe_command("ios-simulator://com.acme.shop"), "xcrun simctl spawn booted launchctl list 2>/dev/null | grep -qF 'UIKitApplication:com.acme.shop[' && echo running || echo stopped");
        assert_eq!(probe_command("http://127.0.0.1:3000"), "curl -s -o /dev/null -w '%{http_code}' --max-time 30 'http://127.0.0.1:3000'");
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Finished {
    #[serde(default)]
    pub teardown_errors: Vec<String>,
}

/// Tears a copy down (the newest one without `run`) and errors when its teardown reported errors.
pub(crate) async fn tear_down(cx: &Cx<'_>, b: &Sbx, key: &str, run: Option<&str>) -> Result<()> {
    let run = run.map(|r| format!(" --run {}", q(r))).unwrap_or_default();
    let fin = long(cx, b, key, &with_env(b, &format!("cd {} && gespann verify finish --recipe {}{run} --wait 5", b.repo, b.recipe)), Duration::from_secs(20 * 60), &super::never).await?;
    let out = last_json::<Finished>(&fin.tail).unwrap_or_default();
    if !out.teardown_errors.is_empty() {
        bail!("the copy did not go down cleanly: {}", cut(&out.teardown_errors.join("; "), 800));
    }
    Ok(())
}
