//! Repair: Codex adds what the copy lacked to the recipe and scripts.

use std::time::Duration;

use anyhow::{bail, Result};
use serde_json::{json, Value};

use super::boxes::{codex_exec, js_code, long, recipe_check, save_bundle, write_prompt, Sbx};
use super::setup::{check_copy, tear_down};
use super::{cut, tail, Cx};
use crate::codex::with_codex;
use crate::db::{opt_text, text, Project, Run};
use crate::sandbox::CommandResult;

async fn checkout(cx: &Cx<'_>, b: &Sbx, sha: &str) -> Result<CommandResult> {
    cx.sb().exec(&b.id, &format!("cd {} && git checkout --quiet --force --detach {sha} && git clean -fdq 2>&1", b.repo), 120).await
}

/// The recipe serves every later PR, so it is checked without Codex on the base branch before it is
/// kept. When anything fails, the previous recipe comes back, so a bad fix never breaks later runs.
/// Leaves the checkout at the PR merge. Every step that changes the sandbox runs once: after a
/// takeover in the second attempt, none of them may touch its copy or checkout again.
pub(crate) async fn repair(cx: &Cx<'_>, p: &Project, run: &Run, b: &Sbx, gaps: &[Value]) -> Result<bool> {
    let sb = cx.sb();
    let backup = format!("{}/project.before-repair", b.gespann);
    let backup = &backup;
    // Kept: after a takeover HEAD may be the base branch the fixed recipe was checked on.
    let merged: String = cx.jr.step("repair.merged", || async move { Ok(sb.exec(&b.id, &format!("cd {} && git rev-parse HEAD", b.repo), 30).await?.stdout.trim().to_string()) }).await?;
    if merged.len() != 40 || !merged.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        cx.log("✗ could not read the merged checkout; the result of the first test stands");
        return Ok(false);
    }
    let mut saved = false;
    let fixed = fix(cx, p, run, b, gaps, backup, &mut saved).await;
    let ok = match fixed {
        Ok(()) => true,
        Err(e) => {
            cx.log(&format!("✗ could not fix the copy: {e:#}. The result of the first test stands."));
            let _ = tear_down(cx, b, "repair.undo.teardown", None).await;
            if saved {
                let _ = cx
                    .jr
                    .step("repair.restore", || async move {
                        let _ = sb.exec(&b.id, &format!("rm -rf {} && cp -a {backup} {}", b.project, b.project), 120).await;
                        Ok(())
                    })
                    .await;
            }
            false
        }
    };
    // The tester runs on the PR exactly as merged.
    let merged = &merged;
    let _ = cx
        .jr
        .step("repair.checkout", || async move {
            let _ = checkout(cx, b, merged).await;
            Ok(())
        })
        .await;
    Ok(ok)
}

async fn fix(cx: &Cx<'_>, p: &Project, run: &Run, b: &Sbx, gaps: &[Value], backup: &str, saved: &mut bool) -> Result<()> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    cx.jr
        .step("repair.backup", || async move {
            let save = sb.exec(&b.id, &format!("rm -rf {backup}.tmp && cp -a {} {backup}.tmp && rm -rf {backup} && mv {backup}.tmp {backup} 2>&1", b.project), 120).await?;
            if save.exit_code != Some(0) {
                bail!("could not back up the recipe: {}", tail(&save.stdout, 300));
            }
            Ok(())
        })
        .await?;
    *saved = true;
    let prompt_file = format!("{}/repair-prompt.txt", b.gespann);
    let last_file = format!("{}/repair-last.txt", b.gespann);
    let (prompt_file, last_file) = (&prompt_file, &last_file);
    cx.jr
        .step("repair.prompt", || async move {
            sb.exec(&b.id, &format!("rm -f {last_file}"), 30).await?;
            let gaps: Vec<Value> = gaps.iter().map(|g| json!({ "expect": g["expect"].as_str().unwrap_or(""), "observed": g["observed"].as_str().unwrap_or(""), "fix": g["fix"].as_str().unwrap_or("") })).collect();
            let mut input = json!({ "repo": p.repo, "repoDir": b.repo, "projectDir": b.project, "gaps": gaps });
            if let Some(note) = sb.tester_note() {
                input["testerNote"] = json!(note);
            }
            write_prompt(cx, b, "repair", &input, prompt_file).await
        })
        .await?;
    cx.note("repair.log.codex", "Codex fixes the copy").await;
    let cancelled = || cx.stopped();
    let command = codex_exec(b, prompt_file, last_file, &format!("{}/repair.jsonl", b.gespann), p.model.as_deref());
    let r = with_codex(cx.ctx, &cx.jr, "repair.signin", p.owner_id, &b.id, || long(cx, b, "repair.codex", &command, Duration::from_secs(60 * 60), &cancelled)).await?;
    // Codex may have left its own copy up; it may also have touched the checkout.
    tear_down(cx, b, "repair.teardown", None).await?;
    let last = sb.read_file(&b.id, last_file).await?.unwrap_or_default().trim().to_string();
    if !last.is_empty() {
        cx.log(&format!("Codex: {}", cut(&last, 2000)));
    }
    if cx.stopped() {
        bail!("cancelled");
    }
    if last.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("cannot:")) {
        bail!("the copy cannot provide it");
    }
    if r.exit_code != Some(0) {
        bail!("{}", if r.timed_out { "the fix took longer than an hour".to_string() } else { format!("codex exited {}: {}", js_code(r.exit_code), tail(&r.tail, 500)) });
    }
    let recipe = sb.read_file(&b.id, &b.recipe).await?.unwrap_or_default();
    recipe_check(cx, b, &b.recipe).await?;
    cx.jr
        .step("repair.base", || async move {
            let co = checkout(cx, b, &run.base).await?;
            if co.exit_code != Some(0) {
                bail!("checkout of {} failed: {}", run.base_ref, tail(&co.stdout, 300));
            }
            Ok(())
        })
        .await?;
    cx.log(&format!("the fixed recipe has to work for every PR: checking it on {}", run.base_ref));
    check_copy(cx, b, "repair.check", true).await?;
    // The project's other sandboxes take the fixed recipe over before their next job.
    let recipe = &recipe;
    cx.jr
        .step("repair.save", || async move {
            save_bundle(cx, p, b).await?;
            let notes = sb.read_file(&b.id, &format!("{}/NOTES.md", b.project)).await?;
            db.update_project(p.id, &[("recipe", text(recipe.clone())), ("notes", opt_text(notes))])?;
            Ok(())
        })
        .await?;
    cx.log("the copy is fixed; the test runs again");
    Ok(())
}
