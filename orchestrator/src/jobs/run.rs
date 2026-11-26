//! One PR run: copy up, tester, verdict, copy down; then the check and the PR comment. When the tester
//! was blocked only by gaps in the copy (a site not built, a provider not faked), Codex fixes the copy
//! once and the tester starts again; the PR gets the result of the second attempt.

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use anyhow::{bail, Result};
use futures::{stream, FutureExt, StreamExt};
use rusqlite::types::Value as Sql;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::boxes::{codex_exec, ensure_repo, ensure_sandbox, git, js_code, js_num, last_json, long, recipe_check, stop_sandbox, sync_recipe, with_env, write_prompt, Sbx};
use super::repair::repair;
use super::setup::{setup, Finished};
use super::{cut, never, tail, Cx};
use crate::codex::with_codex;
use crate::db::{now, opt_text, text, Db, Project, Run};
use crate::journal::Long;
use crate::sandbox::scripts::{finish_recording_script, q};
use crate::sandbox::LongResult;
use crate::ui::Context;
use crate::verify::{copy_gaps, empty_progress, merge_tester, parse_progress, same_screens, parse_thumbs, screen_for, start_stage, thumb_command, viewports_of, with_aliases, Progress, Stage, Viewport};

/// Marks the files in conflict in the output of a failed merge.
const UNMERGED: &str = "gespann-unmerged: ";

#[derive(Debug)]
struct MergeConflict(Vec<String>);

impl fmt::Display for MergeConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PR head has merge conflicts in {}", self.0.join(", "))
    }
}

impl std::error::Error for MergeConflict {}

/// `conflictNote(baseRef, files).title` from `src/server/comment.ts`.
fn conflict_title(base_ref: &str, files: &[String]) -> String {
    let named = files.iter().take(5).map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", ");
    let list = if files.len() > 5 { format!("{named} and {} more", files.len() - 5) } else { named };
    format!("Not tested: the PR has merge conflicts with {base_ref} in {list}")
}

/// gespann run ids are 12 hex characters of the run's token: the first attempt takes the first 12,
/// a second attempt the next 12.
fn gespann_ids(run: &Run) -> (String, String) {
    let part = |from: usize| run.token.chars().skip(from).take(12).collect::<String>();
    (part(0), part(12))
}

pub(crate) struct Attempt {
    judged: Option<Value>,
    outcome: String,
    /// The copy went down without teardown errors.
    clean: bool,
}

impl Attempt {
    fn failed(clean: bool) -> Attempt {
        Attempt { judged: None, outcome: "FAIL".into(), clean }
    }
}

fn has_verdict(judged: Option<&Value>) -> bool {
    judged.is_some_and(|j| j.get("verdict").is_some_and(Value::is_object))
}

/// Changes the run's live progress. Never fails: progress is for the page, the run goes on without it.
pub(crate) fn set_progress(db: &Db, run_id: i64, change: impl FnOnce(Progress) -> Progress) {
    let Ok(Some(run)) = db.run(run_id) else { return };
    let Ok(after) = serde_json::to_string(&change(parse_progress(run.progress.as_deref()).unwrap_or_else(empty_progress))) else { return };
    if Some(&after) != run.progress.as_ref() {
        let _ = db.update_run(run_id, &[("progress", text(after))]);
    }
}

/// Starts a stage of attempt `n`, once: after a takeover a stage that started must not start again,
/// that would drop the stages after it.
async fn stage(cx: &Cx<'_>, run_id: i64, n: u32, s: Stage) {
    let db = &cx.ctx.db;
    let _ = cx
        .jr
        .step(&format!("a{n}.stage.{}", s.name()), || async move {
            set_progress(db, run_id, |x| start_stage(&x, s, &now(), Some(n)));
            Ok(())
        })
        .await;
}

/// Moves the run's GitHub check to in progress with this text, once per `key`.
async fn check(cx: &Cx<'_>, run: &Run, key: &str, title: &str, summary: &str) {
    let summary = format!("{summary} Follow it at {}/runs/{}.", cx.ctx.cfg.base_url, run.id);
    let summary = &summary;
    let _ = cx
        .jr
        .step(key, || async move {
            if run.check_run_id.is_some() && !cx.stopped() {
                cx.ctx.ui.check(run.id, title, summary).await;
            }
            Ok(())
        })
        .await;
}

pub(crate) async fn verify_run(cx: &Cx<'_>, p: &Project, run: &Run) -> Result<()> {
    let (ctx, db) = (cx.ctx, &cx.ctx.db);
    cx.jr
        .step("started", || async move {
            let started = now();
            let progress = serde_json::to_string(&start_stage(&empty_progress(), Stage::Sandbox, &started, None))?;
            db.update_run(run.id, &[("status", text("running")), ("started", text(started)), ("progress", text(progress))])?;
            Ok(())
        })
        .await?;
    check(cx, run, "check.testing", "Testing the change", "An agent is testing this PR on a production-near copy.").await;
    let mut b = ensure_sandbox(cx, p, "install").await?;
    // A new sandbox, or one with an older recipe, takes over the project's current one; a replaced
    // sandbox of a project without a saved recipe needs the setup again.
    let has = match cx.jr.step("recipe.sync", || sync_recipe(cx, p, &b)).await {
        Ok(has) => has,
        Err(e) => {
            stop_sandbox(cx, &b).await;
            return Err(e);
        }
    };
    if !has {
        // One run at a time prepares it; runs waiting meanwhile take over the recipe it saved.
        let _held = ctx.locks.lock("recovering", p.id).await;
        if !cx.jr.step("recover.sync", || sync_recipe(cx, p, &b)).await? {
            cx.note("recover.log", "the sandbox has no recipe yet: preparing the environment again before the test").await;
            let current = db.project(p.id)?.unwrap_or_else(|| p.clone());
            setup(cx, &current, "setup.", true).await?;
            let latest = db.project(p.id)?.unwrap_or(current);
            b = ensure_sandbox(cx, &latest, "recover.install").await?;
        }
    }
    let b = &b;
    let cancelled = || cx.stopped();
    let mut pr: Option<Context> = None;
    let mut base = run.base.clone();
    match merge_and_read(cx, p, run, b).await {
        Ok((c, tip)) => {
            pr = Some(c);
            base = tip;
        }
        Err(e) => match e.downcast_ref::<MergeConflict>() {
            Some(MergeConflict(files)) => {
                cx.log(&format!("✗ {}. Nothing was tested: the PR's agent brings the branch up to date, then gespann tests the new head.", conflict_title(&run.base_ref, files)));
                db.update_run(run.id, &[("conflict", text(serde_json::to_string(files)?))])?;
            }
            None => {
                cx.log(&format!("✗ {e:#}"));
                if !cx.stopped() {
                    db.update_run(run.id, &[("error", text(cut(&format!("{e:#}"), 4000)))])?;
                }
            }
        },
    }

    // The base the PR was merged onto: its branch as it is now, maybe newer than GitHub's.
    let current = Run { base, ..run.clone() };
    let run = &current;
    let (first, again) = gespann_ids(run);
    let mut dir = format!("{}/runs/{first}", b.gespann);
    let mut a = Attempt::failed(true);
    if let Some(pr) = pr.as_ref().filter(|_| !cancelled()) {
        a = attempt(cx, p, run, b, &first, &dir, pr, 1).await?;
        let gaps = copy_gaps(a.judged.as_ref());
        if !gaps.is_empty() && a.clean && !cancelled() {
            for g in &gaps {
                cx.log(&format!("blocked by the copy, not the change: {} → {}", g["expect"].as_str().unwrap_or(""), g["fix"].as_str().unwrap_or("")));
            }
            check(cx, run, "check.fixing", "Fixing the test environment", "The copy lacked something the test needs. Codex adds it, then the test runs again.").await;
            // One fix at a time per project, each on the recipe the fix before it saved, so none is lost.
            let fixed = {
                let _held = ctx.locks.lock("repairing", p.id).await;
                match cx.jr.step("repair.sync", || sync_recipe(cx, p, b)).await {
                    Err(e) => {
                        cx.log(&format!("✗ could not take over the project's current recipe before the fix: {e:#}. The result of the first test stands."));
                        false
                    }
                    Ok(_) => {
                        let _ = cx
                            .jr
                            .step("repair.stage", || async move {
                                set_progress(db, run.id, |x| start_stage(&x, Stage::Copy, &now(), Some(2)));
                                Ok(())
                            })
                            .await;
                        repair(cx, p, run, b, &gaps).await?
                    }
                }
            };
            if fixed {
                check(cx, run, "check.again", "Testing the change again", "The copy was fixed; the agent tests this PR again.").await;
            }
            if fixed && !cancelled() {
                let again_dir = format!("{}/runs/{again}", b.gespann);
                // Once: after a takeover in the second attempt, the error from before it is the first test's.
                let before: Option<String> = cx
                    .jr
                    .step("a2.reset", || async move {
                        let before = db.run(run.id)?.and_then(|r| r.error);
                        db.update_run(run.id, &[("error", Sql::Null)])?;
                        Ok(before)
                    })
                    .await?;
                let second = attempt(cx, p, run, b, &again, &again_dir, pr, 2).await?;
                if has_verdict(second.judged.as_ref()) {
                    a = second;
                    dir = again_dir;
                } else {
                    cx.log("the second test produced no verdict; the result of the first test stands");
                    if !cancelled() {
                        db.update_run(run.id, &[("error", opt_text(before))])?;
                    }
                }
            }
        }
    }
    if cancelled() {
        return stop(cx, b, run).await;
    }
    // A run with merge conflicts tested nothing, so it has no outcome rather than a FAIL.
    let conflict = db.run(run.id)?.and_then(|r| r.conflict);
    let outcome = if conflict.is_some() { None } else { Some(a.outcome.clone()) };
    // Several screen sizes: the same page at two sizes can look alike on a small thumbnail, and each size needs its own proof.
    let sizes = viewports_of(&db.project(p.id)?.map_or_else(|| p.viewports.clone(), |p| p.viewports)).len();
    let out = format!("{dir}/out");
    let col: Collected = cx.jr.step("collect", || collect(cx, b, run, &out, sizes < 2)).await?;
    if cancelled() {
        return stop(cx, b, run).await;
    }
    if col.complete {
        drop_proof(cx, b, run).await?;
    }
    let judged = a.judged.map(|j| with_aliases(&j, &col.alias));
    let (judged, files, unread) = (&judged, &col.files, pr.as_ref().and_then(|c| c.unread.as_ref()));
    cx.jr
        .step("finished", || async move {
            // A verdict without the issue goals says why, on the run page and over MCP.
            if let (Some(unread), true) = (unread, has_verdict(judged.as_ref())) {
                let before = db.run(run.id)?.and_then(|r| r.error).filter(|e| !e.is_empty());
                db.update_run(run.id, &[("error", text(before.map_or_else(|| unread.clone(), |b| format!("{b}\n{unread}"))))])?;
            }
            let error = db.run(run.id)?.and_then(|r| r.error).filter(|e| !e.is_empty());
            let status = if error.is_some() && !has_verdict(judged.as_ref()) { "failed" } else { "done" };
            db.update_run(
                run.id,
                &[
                    ("status", text(status)),
                    ("outcome", opt_text(outcome)),
                    ("verdict", opt_text(judged.as_ref().map(Value::to_string))),
                    ("files", text(serde_json::to_string(files)?)),
                    ("finished", text(now())),
                ],
            )?;
            Ok(())
        })
        .await?;
    stop_sandbox(cx, b).await;
    cx.jr
        .step("report", || async move {
            if let Err(e) = ctx.ui.report(run.id, cx.job.id, judged.as_ref(), files).await {
                cx.log(&format!("could not report the result: {e:#}"));
            }
            Ok(())
        })
        .await
}

/// The newer push's run reports; this one only frees its sandbox. A run superseded while no
/// orchestrator watched it (it was taken over cancelled) may still have its tester running and its copy
/// up: they stop here, as the cancelled steps would have stopped them.
async fn stop(cx: &Cx<'_>, b: &Sbx, run: &Run) -> Result<()> {
    cx.log("stopped: a newer push supersedes this run");
    let sb = cx.sb();
    // Not the teardowns below: a second takeover during this stop attaches to them.
    for (key, p) in cx.ctx.db.open_procs(cx.job.id)? {
        if key.starts_with("stop.") {
            continue;
        }
        if sb.status(&p.sandbox_id, p.pid, 0).await.is_ok_and(|s| s.state == crate::sandbox::ProcState::Running) {
            let _ = sb.kill(&p.sandbox_id, p.pid).await;
        }
    }
    if let Some(owner) = cx.ctx.db.project(cx.job.project_id)?.map(|p| p.owner_id) {
        if let Err(e) = crate::codex::give_back(cx.ctx, &cx.jr, owner, &b.id).await {
            cx.log(&format!("✗ {e:#}"));
        }
    }
    let (first, again) = gespann_ids(run);
    for (n, id) in [(1, first), (2, again)] {
        let up = cx.ctx.db.step_get(cx.job.id, &format!("a{n}.prepare"))?.is_some() || cx.ctx.db.proc_get(cx.job.id, &format!("a{n}.prepare"))?.is_some();
        if !up || cx.ctx.db.step_get(cx.job.id, &format!("a{n}.finish"))?.is_some() {
            continue;
        }
        let dir = format!("{}/runs/{id}", b.gespann);
        let command = with_env(b, &format!("cd {} && gespann verify finish --recipe {} --pr {} --head {} --base {} --run {id} --dir {dir} --wait 0", b.repo, b.recipe, run.pr, run.head, run.base));
        match long(cx, b, &format!("stop.{id}"), &command, Duration::from_secs(20 * 60), &never).await {
            Ok(r) if r.exit_code == Some(0) => {}
            Ok(r) => cx.log(&format!("✗ the copy did not go down cleanly: {}", tail(&r.tail, 800))),
            Err(e) => cx.log(&format!("could not take the copy down: {e:#}")),
        }
    }
    stop_sandbox(cx, b).await;
    Ok(())
}

/// The PR merged onto its base in the checkout, and its text and issues in parallel. Both once:
/// after a takeover the checkout holds the running copy's build, and the tester was given this text.
async fn merge_and_read(cx: &Cx<'_>, p: &Project, run: &Run, b: &Sbx) -> Result<(Context, String)> {
    let sb = cx.sb();
    let merge_fut = cx.jr.step("merge", || async move {
        ensure_repo(cx, b, p).await?;
        // The PR is tested on its base branch as it is now. GitHub's base commit of a PR stays where it was
        // at the last push, so a rerun after newer merges would otherwise test the PR without them.
        let tracking = format!("refs/remotes/origin/{}", run.base_ref);
        git(cx, b, p, &format!("-C {} fetch --quiet origin {} {}", b.repo, q(&run.head), q(&format!("+refs/heads/{}:{tracking}", run.base_ref))), 600).await?;
        let read = sb.exec(&b.id, &format!("cd {} && git rev-parse --verify --quiet {}", b.repo, q(&format!("{tracking}^{{commit}}"))), 30).await?;
        let tip = read.stdout.trim().to_string();
        if read.exit_code != Some(0) || tip.len() != 40 || !tip.chars().all(|c| c.is_ascii_hexdigit()) {
            bail!("could not read {} after fetching it: {}", run.base_ref, tail(&read.stdout, 300));
        }
        if tip != run.base {
            cx.log(&format!("testing on {} at {}, newer than {} from GitHub", run.base_ref, &tip[..12], cut(&run.base, 12)));
            cx.ctx.db.update_run(run.id, &[("base", text(tip.clone()))])?;
        }
        let merge = sb
            .exec(
                &b.id,
                // On a failed merge the files in conflict follow, one per line, and the merge is undone.
                &format!(
                    "cd {} && git checkout --quiet --force --detach {} && git clean -fdq && {{ git -c user.name=gespann -c user.email=verify@gespann.app merge --quiet --no-edit {} 2>&1 || {{ s=$?; git -c core.quotePath=false diff --name-only --diff-filter=U | sed 's/^/{UNMERGED}/'; git merge --abort >/dev/null 2>&1; exit $s; }}; }}",
                    b.repo, tip, run.head
                ),
                120,
            )
            .await?;
        if merge.exit_code != Some(0) {
            let files: Vec<String> = merge.stdout.split('\n').filter_map(|l| l.strip_prefix(UNMERGED)).map(String::from).collect();
            if !files.is_empty() {
                return Err(MergeConflict(files).into());
            }
            bail!("PR head does not merge onto {}: {}", run.base_ref, tail(&merge.stdout, 500));
        }
        Ok(tip)
    });
    let context_fut = cx.jr.step("context", || async move {
        let c = cx.ctx.ui.context(run.id).await?;
        // The issues the PR resolves set its goal. When GitHub does not list them, the tester judges from
        // diff and PR text alone, as for a PR without issues, and the run says so.
        if let Some(unread) = &c.unread {
            cx.log(&format!("✗ {unread}"));
        }
        if !c.issues.is_empty() {
            let refs = c.issues.iter().map(|i| i.reference.as_str()).collect::<Vec<_>>().join(", ");
            cx.log(&format!("linked {}: {refs}", if c.issues.len() == 1 { "issue" } else { "issues" }));
        }
        Ok(c)
    });
    let (base, c): (Result<String>, Result<Context>) = tokio::join!(merge_fut, context_fut);
    let base = base?;
    Ok((c?, base))
}

#[derive(Debug, Deserialize)]
struct Prepared {
    ok: bool,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// What the tester wrote to progress.json, read while it works and once more when it is done.
async fn read_tester(cx: &Cx<'_>, b: &Sbx, run_id: i64, file: &str) {
    let raw = cx.sb().read_file(&b.id, file).await.ok().flatten();
    set_progress(&cx.ctx.db, run_id, |x| merge_tester(&x, raw.as_deref(), &now()));
}

/// Copy up, tester, then always finish: verdict and teardown, even when the copy or the tester failed.
#[allow(clippy::too_many_arguments)]
async fn attempt(cx: &Cx<'_>, p: &Project, run: &Run, b: &Sbx, gid: &str, dir: &str, pr: &Context, n: u32) -> Result<Attempt> {
    let sb = cx.sb();
    let k = |s: &str| format!("a{n}.{s}");
    let mut recording = false;
    if let Err(e) = attempt_tester(cx, p, run, b, gid, dir, pr, n, &mut recording).await {
        cx.log(&format!("✗ {e:#}"));
        if !cx.stopped() {
            cx.ctx.db.update_run(run.id, &[("error", text(cut(&format!("{e:#}"), 4000)))])?;
        }
    }

    stage(cx, run.id, n, Stage::Verdict).await;
    let wait = if cx.stopped() { 0 } else { 600 };
    let command = with_env(b, &format!("cd {} && gespann verify finish --recipe {} --pr {} --head {} --base {} --run {gid} --dir {dir} --wait {wait}", b.repo, b.recipe, run.pr, run.head, run.base));
    let rec = format!("{dir}/out/recording.mp4");
    let rec = &rec;
    // The recording is already closed; trimming leading black frames runs alongside copy teardown.
    let (fin, _) = tokio::join!(
        async { long(cx, b, &k("finish"), &command, Duration::from_secs(30 * 60), &never).await.unwrap_or_else(|e| LongResult { exit_code: None, tail: format!("{e:#}"), timed_out: false }) },
        async {
            if recording {
                let _ = cx
                    .jr
                    .step(&k("record.finish"), || async move {
                        let _ = sb.exec(&b.id, &finish_recording_script(rec), 300).await;
                        Ok(())
                    })
                    .await;
            }
        }
    );
    let result = sb.read_file(&b.id, &format!("{dir}/work/result.json")).await.ok().flatten();
    let teardown = last_json::<Finished>(&fin.tail).unwrap_or_default().teardown_errors;
    if !teardown.is_empty() {
        cx.log(&format!("✗ the copy did not go down cleanly: {}", cut(&teardown.join("; "), 800)));
    }
    let clean = teardown.is_empty();
    // A stopped attempt has no verdict: what finish judged is only the cut-off tester.
    if cx.stopped() {
        return Ok(Attempt::failed(clean));
    }
    let Some(result) = result else {
        cx.log(&format!("finish did not report: {}", tail(&fin.tail, 400)));
        return Ok(Attempt::failed(clean));
    };
    let r: Value = serde_json::from_str(&result)?;
    let outcome = r["outcome"].as_str().unwrap_or("FAIL").to_string();
    cx.note(&k("log.verdict"), &format!("verdict: {outcome}")).await;
    Ok(Attempt { judged: Some(r["judged"].clone()).filter(|j| !j.is_null()), outcome, clean })
}

/// The part of an attempt that may fail: the copy up, the prompt, the tester and its recording.
#[allow(clippy::too_many_arguments)]
async fn attempt_tester(cx: &Cx<'_>, p: &Project, run: &Run, b: &Sbx, gid: &str, dir: &str, pr: &Context, n: u32, recording_out: &mut bool) -> Result<()> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    let k = |s: &str| format!("a{n}.{s}");
    // Fresh each time: a run that starts again must not show a lost attempt's proof. Once per attempt:
    // after a takeover the dir holds the running copy and tester.
    cx.jr
        .step(&k("dir"), || async move {
            sb.exec(&b.id, &format!("rm -rf {dir} && mkdir -p {dir}/work {dir}/out"), 30).await?;
            sb.write_file(&b.id, &format!("{dir}/work/pr.md"), pr.pr_text.as_bytes()).await?;
            if !pr.issues.is_empty() {
                sb.write_file(&b.id, &format!("{dir}/work/issues.md"), pr.issues_md.as_bytes()).await?;
                // finish reads the refs to require one goal per issue.
                let refs: Vec<Value> = pr.issues.iter().map(|i| json!({ "ref": i.reference, "url": i.url })).collect();
                sb.write_file(&b.id, &format!("{dir}/work/issues.json"), format!("{}\n", Value::Array(refs)).as_bytes()).await?;
            }
            Ok(())
        })
        .await?;
    // The sizes are kept with the step: a change on the Setup page mid-run must not resize the running screen.
    let viewports: Vec<Viewport> = cx
        .jr
        .step(&k("screen"), || async move {
            let viewports = viewports_of(&db.project(p.id)?.map_or_else(|| p.viewports.clone(), |p| p.viewports));
            if let Some(screen) = screen_for(&viewports) {
                // The browser window has to fit the largest size on the sandbox's screen, or screenshots cut it off.
                // Before the copy comes up: a new screen ends whatever ran on the old one.
                sb.write_file(&b.id, &format!("{}/.gespann-screen", sb.home(&b.id)), format!("{screen}\n").as_bytes()).await?;
                sb.ensure_running(&b.id).await?;
            }
            Ok(viewports)
        })
        .await?;
    cx.note(&k("log.copy"), "bringing the copy up").await;
    stage(cx, run.id, n, Stage::Copy).await;
    let cancelled = || cx.stopped();
    let prepare = with_env(b, &format!("cd {} && gespann verify prepare --recipe {} --pr {} --head {} --base {} --run {gid} --dir {dir}", b.repo, b.recipe, run.pr, run.head, run.base));
    let prep = long(cx, b, &k("prepare"), &prepare, Duration::from_secs(60 * 60), &cancelled).await?;
    let prepared = last_json::<Prepared>(&prep.tail);
    let url = match &prepared {
        Some(Prepared { ok: true, url: Some(url), .. }) => url.clone(),
        _ => bail!("the copy did not come up: {}", prepared.and_then(|l| l.error).unwrap_or_else(|| tail(&prep.tail, 800))),
    };
    cx.note(&k("log.up"), &format!("copy is up at {url}")).await;
    // The copy is up from here on, whatever happens before the tester starts.
    stage(cx, run.id, n, Stage::Read).await;

    let (url, viewports) = (&url, &viewports);
    let minutes: f64 = cx
        .jr
        .step(&k("prompt"), || async move {
            let current = db.project(p.id)?.unwrap_or_else(|| p.clone());
            let recipe = recipe_check(cx, b, &b.recipe).await?;
            let addendum = match &recipe.prompt {
                Some(file) => match sb.read_file(&b.id, &format!("{}/{file}", b.project)).await? {
                    Some(t) => t,
                    None => sb.read_file(&b.id, &format!("{}/{file}", b.repo)).await?.unwrap_or_default(),
                },
                None => String::new(),
            };
            let notes = sb.read_file(&b.id, &format!("{}/NOTES.md", b.project)).await?.unwrap_or_default();
            // Every further screen size repeats the checks: half the recipe's time more for each.
            let minutes = recipe.timeout * (1.0 + viewports.len().saturating_sub(1) as f64 / 2.0);
            if !viewports.is_empty() {
                let sizes = viewports.iter().map(|v| format!("{} {}x{}", v.name, v.width, v.height)).collect::<Vec<_>>().join(", ");
                cx.log(&format!("screen sizes to test: {sizes}"));
            }
            let addendum = [notes, addendum].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
            let issues: Vec<String> = pr.issues.iter().map(|i| i.reference.clone()).collect();
            let mut input = json!({
                "repo": p.repo,
                "pr": run.pr,
                "head": run.head,
                "base": run.base,
                "url": url,
                "out": format!("{dir}/out"),
                "work": format!("{dir}/work"),
                "criteria": current.criteria,
                "recipeFile": b.recipe,
                "addendum": addendum,
                "issues": issues,
                "viewports": viewports,
            });
            if let Some(note) = sb.tester_note() {
                input["testerNote"] = json!(note);
            }
            write_prompt(cx, b, "tester", &input, &format!("{dir}/work/prompt.txt")).await?;
            Ok(minutes)
        })
        .await?;
    let rec = format!("{dir}/out/recording.mp4");
    let rec = &rec;
    // Every run should come with a video of the tester's screen; when there is none, the log says why.
    // Started once: a second recording would end the first.
    let recording: bool = cx
        .jr
        .step(&k("record"), || async move {
            match sb.start_recording(&b.id, rec).await {
                Ok(()) => Ok(true),
                Err(e) => {
                    cx.log(&format!("✗ no recording of this run: {e:#}"));
                    Ok(false)
                }
            }
        })
        .await?;
    *recording_out = recording;
    cx.note(&k("log.tester"), "the tester is working").await;
    let progress_file = format!("{dir}/work/progress.json");
    let progress_file = &progress_file;
    let tick = |_tail: String| read_tester(cx, b, run.id, progress_file).boxed();
    let command = codex_exec(b, &format!("{dir}/work/prompt.txt"), &format!("{dir}/work/last.txt"), &format!("{dir}/work/codex.jsonl"), p.model.as_deref(), "medium");
    let tester_key = k("tester");
    let tester = with_codex(cx.ctx, &cx.jr, &k("signin"), p.owner_id, &b.id, || {
        cx.jr.long(sb, &b.id, &tester_key, &command, Long { timeout: Duration::from_secs_f64(minutes * 60.0), cancelled: &cancelled, on_tick: Some(&tick) })
    })
    .await;
    if tester.is_ok() {
        read_tester(cx, b, run.id, progress_file).await;
    }
    if recording {
        cx.jr
            .step(&k("record.stop"), || async move {
                if let Err(e) = sb.stop_recording(&b.id).await {
                    cx.log(&format!("could not stop the recording: {e:#}"));
                }
                Ok(())
            })
            .await?;
    }
    let tester = tester?;
    cx.note(&k("log.done"), &if cx.stopped() {
        "the tester was stopped".to_string()
    } else if tester.timed_out {
        format!("the tester ran out of time ({} min)", js_num(minutes))
    } else {
        format!("the tester finished (exit {})", js_code(tester.exit_code))
    })
    .await;
    Ok(())
}

const MAX_FILE: u64 = 100 * 1024 * 1024;

fn is_image(f: &str) -> bool {
    let f = f.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|e| f.ends_with(e))
}

fn is_video(f: &str) -> bool {
    let f = f.to_ascii_lowercase();
    f.ends_with(".mp4") || f.ends_with(".webm")
}

/// The proof copied to the server, kept in the journal so a takeover after the sandbox's copy is
/// gone does not copy again.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Collected {
    files: Vec<String>,
    alias: BTreeMap<String, String>,
    complete: bool,
}

/// Copies the run's proof to the server. Screenshots of the same screen are copied once; `alias`
/// maps each skipped one to the screenshot that was kept.
async fn collect(cx: &Cx<'_>, b: &Sbx, run: &Run, out: &str, dedupe: bool) -> Result<Collected> {
    let sb = cx.sb();
    let ls = sb.exec(&b.id, &format!("cd {} 2>/dev/null && find . -maxdepth 1 -type f -size -{}c -printf '%f\\n'", q(out), MAX_FILE + 1), 30).await?;
    let big = sb.exec(&b.id, &format!("cd {} 2>/dev/null && find . -maxdepth 1 -type f -size +{MAX_FILE}c -printf '%f %s\\n'", q(out)), 30).await.ok();
    for line in big.iter().flat_map(|r| r.stdout.split('\n')).filter(|l| !l.is_empty()) {
        let mut parts = line.split(' ');
        let name = parts.next().unwrap_or("");
        let mb = parts.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(f64::NAN) / 1024f64.powi(2);
        cx.log(&format!("✗ {name} is too large to keep ({} MB, limit 100 MB)", if mb.is_nan() { "NaN".into() } else { js_num(mb.round()) }));
    }
    let valid = |f: &str| !f.is_empty() && f.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let all: Vec<String> = ls.stdout.split('\n').filter(|f| valid(f) && (is_image(f) || is_video(f) || *f == "verdict.json")).map(String::from).collect();
    let images: Vec<String> = all.iter().filter(|f| is_image(f)).cloned().collect();
    let thumbs = if dedupe && !images.is_empty() { sb.exec(&b.id, &format!("cd {} && {{ {}; }}", q(out), thumb_command(&images)), 120).await.ok() } else { None };
    let alias = same_screens(&parse_thumbs(thumbs.as_ref().map_or("", |t| t.stdout.as_str())));
    if !alias.is_empty() {
        cx.log(&format!("{} of {} screenshots show the same screen as another one; kept one of each", alias.len(), images.len()));
    }
    // The recording first: it is the run's main proof and must not fall behind a long list of screenshots.
    let mut names: Vec<String> = all.into_iter().filter(|f| !alias.contains_key(f)).collect();
    names.sort_by_key(|f| !is_video(f));
    let dir = format!("{}/runs/{}", cx.ctx.cfg.data_dir, run.id);
    std::fs::create_dir_all(&dir)?;
    let downloads: Vec<(String, Result<Vec<u8>>)> = stream::iter(names.iter().take(60).cloned())
        .map(|f| async move {
            let data = sb.download(&b.id, &format!("{out}/{f}")).await;
            (f, data)
        })
        .buffered(4)
        .collect()
        .await;
    let mut saved = vec![];
    for (f, res) in downloads {
        match res.and_then(|bytes| Ok(std::fs::write(format!("{dir}/{f}"), bytes)?)) {
            Ok(()) => saved.push(f),
            Err(e) => cx.log(&format!("could not copy {f}: {e:#}")),
        }
    }
    Ok(Collected { complete: ls.exit_code == Some(0) && saved.len() == names.len(), files: saved, alias })
}

/// The server now has the proof: the sandbox's copy of it goes, of both attempts. The work folders
/// stay; their state.json says what may still be up.
async fn drop_proof(cx: &Cx<'_>, b: &Sbx, run: &Run) -> Result<()> {
    cx.jr
        .step("drop", || async move {
            let (first, again) = gespann_ids(run);
            let outs = [first, again].map(|id| format!("{}/runs/{id}/out", b.gespann)).join(" ");
            let _ = cx.sb().exec(&b.id, &format!("rm -rf {outs}"), 120).await;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_conflict_title_names_five_files_and_counts_the_rest() {
        let files: Vec<String> = (1..=7).map(|i| format!("f{i}")).collect();
        assert_eq!(conflict_title("main", &files[..2]), "Not tested: the PR has merge conflicts with main in `f1`, `f2`");
        assert_eq!(conflict_title("main", &files), "Not tested: the PR has merge conflicts with main in `f1`, `f2`, `f3`, `f4`, `f5` and 2 more");
    }

    #[test]
    fn each_attempt_takes_its_own_twelve_characters_of_the_token() {
        let run = Run { token: "0123456789abcdefghijklmnopqrstuv".into(), ..Default::default() };
        assert_eq!(gespann_ids(&run), ("0123456789ab".into(), "cdefghijklmn".into()));
    }
}
