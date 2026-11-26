//! Suggest: Codex reads the repo and proposes concrete checks; the user takes them over in the UI.

use std::time::Duration;

use anyhow::{bail, Result};
use serde_json::json;

use super::boxes::{codex_exec, ensure_repo, ensure_sandbox, git, js_code, long, model_for, stop_sandbox, write_prompt, Sbx};
use super::{cut, never, tail, Cx};
use crate::codex::with_codex;
use crate::db::{text, Project};
use crate::sandbox::scripts::q;

pub(crate) async fn suggest(cx: &Cx<'_>, p: &Project) -> Result<()> {
    let b = ensure_sandbox(cx, p, "install").await?;
    let res = run_suggest(cx, p, &b).await;
    stop_sandbox(cx, &b).await;
    res
}

async fn run_suggest(cx: &Cx<'_>, p: &Project, b: &Sbx) -> Result<()> {
    let sb = cx.sb();
    let out = format!("{}/suggested-checks.md", b.gespann);
    let prompt_file = format!("{}/suggest-prompt.txt", b.gespann);
    cx.jr
        .step("suggest.checkout", || async {
            ensure_repo(cx, b, p).await?;
            git(cx, b, p, &format!("-C {} fetch --quiet origin {}", b.repo, q(&p.default_branch)), 600).await?;
            let co = sb.exec(&b.id, &format!("cd {} && git checkout --quiet --force --detach FETCH_HEAD 2>&1 && rm -f {out}", b.repo), 120).await?;
            if co.exit_code != Some(0) {
                bail!("checkout of {} failed: {}", p.default_branch, tail(&co.stdout, 800));
            }
            Ok(())
        })
        .await?;
    cx.jr
        .step("suggest.prompt", || async {
            let input = json!({ "repo": p.repo, "repoDir": b.repo, "out": out, "current": p.criteria });
            write_prompt(cx, b, "suggest", &input, &prompt_file).await
        })
        .await?;
    cx.note("suggest.log.codex", "Codex reads the repository and proposes checks").await;
    let model = model_for(cx, p);
    let command = codex_exec(b, &prompt_file, &format!("{}/suggest-last.txt", b.gespann), &format!("{}/suggest.jsonl", b.gespann), model.as_deref(), "medium");
    let r = with_codex(cx.ctx, &cx.jr, "suggest.signin", p.owner_id, &b.id, || long(cx, b, "suggest.codex", &command, Duration::from_secs(20 * 60), &never)).await?;
    let text_of = match sb.read_file(&b.id, &out).await? {
        Some(t) => Some(t),
        None => sb.read_file(&b.id, &format!("{}/suggest-last.txt", b.gespann)).await?,
    };
    let suggestion = text_of.unwrap_or_default().trim().to_string();
    if suggestion.is_empty() {
        bail!("{}", if r.timed_out { "Codex took longer than 20 minutes".to_string() } else { format!("Codex proposed nothing (exit {}): {}", js_code(r.exit_code), tail(&r.tail, 500)) });
    }
    cx.ctx.db.update_project(p.id, &[("suggestion", text(cut(&suggestion, 8000)))])?;
    cx.log("suggestion ready");
    Ok(())
}
