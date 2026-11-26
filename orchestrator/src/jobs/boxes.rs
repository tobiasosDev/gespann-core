//! A project's sandbox and what every job does with it first: take one, install gespann, bring the
//! repo and the project's current recipe into it, and save the recipe back as the project's bundle.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use super::{cut, never, tail, Cx};
use crate::codex::{Agent, Provider};
use crate::db::{AgentRow, Project, Slot};
use crate::journal::Long;
use crate::sandbox::scripts::{install_script, q};
use crate::sandbox::{CreateOpts, LongResult, Purpose};

/// A project's sandbox and the places in it: the repo checkout, gespann's files, the recipe.
#[derive(Debug, Clone)]
pub(crate) struct Sbx {
    pub id: String,
    pub slot: Slot,
    pub repo: String,
    pub gespann: String,
    pub project: String,
    pub recipe: String,
    pub core: String,
}

pub(crate) fn sbx(cx: &Cx<'_>, slot: Slot) -> Sbx {
    let id = slot.sandbox_id.clone();
    let home = cx.sb().home(&id);
    let gespann = format!("{home}/gespann");
    Sbx {
        id,
        slot,
        repo: format!("{home}/repo"),
        project: format!("{gespann}/project"),
        recipe: format!("{gespann}/project/verify.yml"),
        core: format!("{gespann}/core"),
        gespann,
    }
}

/// A sandbox of the project for this job, reused across jobs: it keeps the repo, the images and the
/// build caches. Each job holds its own, so jobs of one project run side by side without sharing a
/// checkout; a project gets another sandbox when all of its sandboxes are busy. After a takeover the
/// job gets the slot it holds back. `key` names the install step, which runs once per call site.
pub(crate) async fn ensure_sandbox(cx: &Cx<'_>, p: &Project, key: &str) -> Result<Sbx> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    let mut slot = db.take_slot(p.id, cx.job.id)?;
    // A sandbox deleted by hand, or made by the provider the instance used before, is replaced.
    while let Some(s) = slot.clone() {
        if sb.exists(&s.sandbox_id).await? {
            break;
        }
        cx.log(&format!("sandbox {} no longer exists on {}; creating a new one", s.sandbox_id, sb.kind()));
        db.drop_slot(s.id)?;
        slot = db.take_slot(p.id, cx.job.id)?;
    }
    let slot = match slot {
        Some(s) => {
            // Once: after a takeover the job only gets its slot back.
            if db.slots(p.id)?.len() > 1 {
                cx.note(&format!("{key}.slot"), &format!("using sandbox {}", s.sandbox_id)).await;
            }
            s
        }
        None => {
            let n = db.slots(p.id)?.len();
            let name = cut(&format!("gespann-{}", replace_runs(&p.repo)), 60);
            let id = sb.create(CreateOpts { name, purpose: Purpose::Project, labels: vec![("gespann_project".into(), p.id.to_string())], ttl_seconds: None }).await?;
            let s = db.add_slot(p.id, &id, cx.job.id)?;
            if n == 0 {
                db.update_project(p.id, &[("sandbox_id", crate::db::text(id.clone()))])?;
            }
            let more = if n > 0 { format!(", the project's sandbox number {}: the others are busy", n + 1) } else { String::new() };
            cx.log(&format!("created sandbox {id} ({}){more}", sb.kind()));
            s
        }
    };
    sb.ensure_running(&slot.sandbox_id).await?;
    let b = sbx(cx, slot);
    if let Err(e) = install_gespann(cx, &b, key).await {
        stop_sandbox(cx, &b).await;
        return Err(e);
    }
    Ok(b)
}

/// `replace(/[^A-Za-z0-9-]+/g, "-")`.
fn replace_runs(s: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

/// The sandbox runs gespann at `GESPANN_REF`; then the provider's own job script, if it has one.
async fn install_gespann(cx: &Cx<'_>, b: &Sbx, key: &str) -> Result<()> {
    let home = cx.sb().home(&b.id);
    let mut script = vec![install_script(&cx.ctx.cfg.gespann_ref, &b.core, "https://github.com/tobiasosDev/gespann-core.git", "\"$(npm prefix -g)/bin/gespann\"")];
    // env.sh is the provider's to fill; emptied first, so a job never sources what an older script left.
    script.push(format!(": > {}/env.sh", b.gespann));
    if let Some(extra) = cx.sb().job_script(&home) {
        script.push(format!("(\n{extra}\n)"));
    }
    let r = long(cx, b, key, &script.join("\n"), Duration::from_secs(600), &never).await?;
    if r.exit_code != Some(0) {
        bail!("gespann install failed: {}", r.tail);
    }
    // Once: a takeover gets the stored result, and its log must not claim gespann was installed again.
    let lines: Vec<&str> = r.tail.split('\n').filter_map(|l| l.strip_prefix("gespann: ")).collect();
    let _ = cx
        .jr
        .step(&format!("{key}.log"), || async {
            for line in &lines {
                cx.log(line);
            }
            Ok(())
        })
        .await;
    Ok(())
}

/// A long command under the journal: started once under `key`, attached to after a takeover.
pub(crate) async fn long(cx: &Cx<'_>, b: &Sbx, key: &str, command: &str, timeout: Duration, cancelled: &(dyn Fn() -> bool + Send + Sync)) -> Result<LongResult> {
    cx.jr.long(cx.sb(), &b.id, key, command, Long { timeout, cancelled, on_tick: None }).await
}

/// Sourced before every recipe and Codex command: the provider's job script may set variables there.
pub(crate) fn with_env(b: &Sbx, command: &str) -> String {
    format!(". {}/env.sh 2>/dev/null; {command}", b.gespann)
}

/// The job's agent: the owner's provider from Settings, and the model (the project's own first when it
/// belongs to that provider, otherwise the owner's for it). Decided once per job; a takeover keeps it.
pub(crate) async fn agent_for(cx: &Cx<'_>, p: &Project) -> Result<Agent> {
    cx.jr
        .step("agent", || async {
            let row = cx.ctx.db.agent(p.owner_id)?.unwrap_or_default();
            let codex_model = if row.openrouter { None } else { cx.ctx.db.codex_model(p.owner_id)? };
            Ok(pick_agent(&row, p.model.as_deref(), codex_model))
        })
        .await
}

fn pick_agent(row: &AgentRow, project_model: Option<&str>, codex_model: Option<String>) -> Agent {
    // OpenRouter ids name the vendor (`vendor/model`), Codex's never do: a project's model set for
    // the other provider is left out rather than sent where it does not exist.
    let own = project_model.filter(|m| !m.is_empty() && m.contains('/') == row.openrouter).map(str::to_string);
    if row.openrouter {
        // The context size belongs to the owner's model; a project's own model goes without it.
        let context = if own.is_some() { None } else { row.openrouter_context };
        Agent { provider: Provider::Openrouter, model: own.or(row.openrouter_model.clone()), context }
    } else {
        Agent { provider: Provider::Codex, model: own.or(codex_model), context: None }
    }
}

pub(crate) fn codex_exec(b: &Sbx, prompt_file: &str, last_file: &str, jsonl_file: &str, agent: &Agent, effort: &str) -> String {
    let (env, m) = agent.codex_args();
    with_env(
        b,
        &format!(
            "cd {} && {env}codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check{m} -c model_reasoning_effort={effort} -o {} - < {} > {} 2>&1",
            b.repo,
            q(last_file),
            q(prompt_file),
            q(jsonl_file)
        ),
    )
}

/// The last line of `text` that parses as a JSON object of type T: the summary line the CLI prints.
pub(crate) fn last_json<T: DeserializeOwned>(text: &str) -> Option<T> {
    text.trim().split('\n').rev().filter(|l| l.starts_with('{')).find_map(|l| serde_json::from_str(l).ok())
}

/// Fetches with a short-lived installation token that never appears on a command line.
pub(crate) async fn git(cx: &Cx<'_>, b: &Sbx, p: &Project, command: &str, timeout: u64) -> Result<()> {
    let sb = cx.sb();
    let token = cx.ctx.ui.git_token(p.id).await?;
    let token_file = format!("{}/.git-token", b.gespann);
    sb.exec(&b.id, &format!("mkdir -p {} && umask 077 && : > {token_file}", b.gespann), 30).await?;
    let ran = async {
        sb.write_file(&b.id, &token_file, token.as_bytes()).await?;
        let helper = format!("!f() {{ echo username=x-access-token; echo password=$(cat {token_file}); }}; f");
        let r = sb.exec(&b.id, &format!("git -c credential.helper= -c credential.helper={} {command} 2>&1", q(&helper)), timeout).await?;
        if r.exit_code != Some(0) {
            bail!("git {} failed: {}", command.split(' ').next().unwrap_or(""), tail(&r.stdout, 1500));
        }
        Ok(())
    }
    .await;
    let _ = sb.exec(&b.id, &format!("rm -f {token_file}"), 30).await;
    ran
}

pub(crate) async fn ensure_repo(cx: &Cx<'_>, b: &Sbx, p: &Project) -> Result<()> {
    let present = cx.sb().exec(&b.id, &format!("test -d {}/.git", b.repo), 30).await?;
    if present.exit_code != Some(0) {
        git(cx, b, p, &format!("clone --quiet https://github.com/{}.git {}", p.repo, b.repo), 600).await?;
    }
    Ok(())
}

/// Stops the sandbox after its job; the next job that takes it starts it again.
pub(crate) async fn stop_sandbox(cx: &Cx<'_>, b: &Sbx) {
    let _ = cx.sb().stop(&b.id).await;
}

pub(crate) fn bundle_file(cx: &Cx<'_>, project_id: i64) -> String {
    format!("{}/projects/{project_id}/recipe.tgz", cx.ctx.cfg.data_dir)
}

/// Keeps the sandbox's recipe dir (recipe, scripts, notes) as the project's current bundle on the
/// server, so the project's other sandboxes take it over. Called after a setup or repair passed.
pub(crate) async fn save_bundle(cx: &Cx<'_>, p: &Project, b: &Sbx) -> Result<()> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    let tgz = format!("{}/project.tgz", b.gespann);
    let r = sb.exec(&b.id, &format!("tar -czf {tgz} -C {} project 2>&1", b.gespann), 120).await?;
    if r.exit_code != Some(0) {
        bail!("could not pack the recipe: {}", tail(&r.stdout, 300));
    }
    let data = sb.download(&b.id, &tgz).await?;
    let _ = sb.exec(&b.id, &format!("rm -f {tgz}"), 30).await;
    let file = bundle_file(cx, p.id);
    if let Some(dir) = Path::new(&file).parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(format!("{file}.tmp"), data)?;
    std::fs::rename(format!("{file}.tmp"), &file)?;
    let version = db.project(p.id)?.map_or(0, |p| p.bundle) + 1;
    db.update_project(p.id, &[("bundle", crate::db::int(version))])?;
    db.set_slot_bundle(b.slot.id, version)?;
    Ok(())
}

async fn has_recipe(cx: &Cx<'_>, b: &Sbx) -> Result<bool> {
    Ok(cx.sb().exec(&b.id, &format!("test -f {}", b.recipe), 30).await?.exit_code == Some(0))
}

/// Brings the project's current recipe into this sandbox when it has an older one or none. Projects
/// from before bundles get theirs from a sandbox that has a recipe. True when the sandbox has a recipe.
pub(crate) async fn sync_recipe(cx: &Cx<'_>, p: &Project, b: &Sbx) -> Result<bool> {
    let (db, sb) = (&cx.ctx.db, cx.sb());
    let file = bundle_file(cx, p.id);
    let saved = || db.project(p.id).ok().flatten().is_some_and(|p| p.bundle != 0) && Path::new(&file).exists();
    if !saved() {
        // One job at a time makes the first bundle; the others wait and take it over.
        let _held = cx.ctx.locks.lock("bootstrapping", p.id).await;
        if !saved() {
            // Not from a sandbox another job is using: its recipe may be a setup's unchecked draft.
            let busy = |s: &Slot| s.job_id.is_some_and(|id| matches!(db.job_status(id).ok().flatten().as_deref(), Some("queued" | "running")));
            let others: Vec<Slot> = db.slots(p.id)?.into_iter().filter(|s| s.id != b.slot.id && !busy(s)).collect();
            for s in std::iter::once(b.slot.clone()).chain(others) {
                let other = if s.id == b.slot.id { b.clone() } else { sbx(cx, s) };
                if !sb.exists(&other.id).await.unwrap_or(false) || !has_recipe(cx, &other).await.unwrap_or(false) {
                    continue;
                }
                save_bundle(cx, p, &other).await?;
                break;
            }
        }
    }
    let mine = db.slot(b.slot.id)?.map_or(b.slot.bundle, |s| s.bundle);
    let version = db.project(p.id)?.map_or(0, |p| p.bundle);
    if version != 0 && mine != version && Path::new(&file).exists() {
        let data = std::fs::read(&file)?;
        let tgz = format!("{}/project.tgz", b.gespann);
        sb.exec(&b.id, &format!("mkdir -p {}", b.gespann), 30).await?;
        sb.write_file(&b.id, &format!("{tgz}.b64"), base64::engine::general_purpose::STANDARD.encode(data).as_bytes()).await?;
        // Unpacked next to it and swapped in, so nothing ever sees half a recipe.
        let r = sb
            .exec(
                &b.id,
                &format!("set -e; cd {}; base64 -d < project.tgz.b64 > project.tgz; rm -rf project.new; mkdir project.new; tar -xzf project.tgz -C project.new; rm -rf project.old; if [ -d project ]; then mv project project.old; fi; mv project.new/project project; rm -rf project.new project.old project.tgz project.tgz.b64", b.gespann),
                120,
            )
            .await?;
        if r.exit_code != Some(0) {
            bail!("{}", cut(&format!("could not unpack the recipe: {}{}", r.stdout, r.stderr), 500));
        }
        db.set_slot_bundle(b.slot.id, version)?;
        cx.log("took over the project's current recipe");
    }
    has_recipe(cx, b).await
}

/// Writes one of the CLI's prompts into the sandbox: `gespann verify prompt <kind>` reads `input`
/// from a file next to it and its output becomes `prompt_file`.
pub(crate) async fn write_prompt(cx: &Cx<'_>, b: &Sbx, kind: &str, input: &Value, prompt_file: &str) -> Result<()> {
    let sb = cx.sb();
    let input_file = format!("{}.input.json", prompt_file.trim_end_matches(".txt"));
    sb.write_file(&b.id, &input_file, input.to_string().as_bytes()).await?;
    let r = sb.exec(&b.id, &with_env(b, &format!("gespann verify prompt {kind} --input {} > {}", q(&input_file), q(prompt_file))), 120).await?;
    if r.exit_code != Some(0) {
        bail!("could not write the {kind} prompt: {}", tail(&format!("{}{}", r.stdout, r.stderr), 500));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RecipeLine {
    ok: bool,
    #[serde(default)]
    timeout: f64,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// What the tester needs from a valid recipe.
pub(crate) struct Recipe {
    /// Minutes.
    pub timeout: f64,
    pub prompt: Option<String>,
}

/// Checks the recipe at `file` with the CLI (`parseRecipe`); its error says what is wrong.
pub(crate) async fn recipe_check(cx: &Cx<'_>, b: &Sbx, file: &str) -> Result<Recipe> {
    let r = cx.sb().exec(&b.id, &with_env(b, &format!("gespann verify recipe --recipe {}", q(file))), 60).await?;
    match last_json::<RecipeLine>(&r.stdout) {
        Some(l) if l.ok => Ok(Recipe { timeout: l.timeout, prompt: l.prompt.filter(|p| !p.is_empty()) }),
        Some(l) => Err(anyhow!(l.error.unwrap_or_else(|| "the recipe is not valid".into()))),
        None => Err(anyhow!("could not check the recipe: {}", tail(&format!("{}{}", r.stdout, r.stderr), 500))),
    }
}

/// A number as JavaScript prints it: `30`, `37.5`.
pub(crate) fn js_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// An exit code as JavaScript prints it: `0`, `null`.
pub(crate) fn js_code(c: Option<i32>) -> String {
    c.map_or_else(|| "null".into(), |c| c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_names_replace_every_run_of_other_characters_with_one_dash() {
        assert_eq!(replace_runs("acme/shop.web__x"), "acme-shop-web-x");
    }

    #[test]
    fn the_summary_line_is_the_last_json_object() {
        #[derive(Deserialize)]
        struct L {
            ok: bool,
        }
        let out = "building\n{\"ok\":false}\n{not json\n{\"ok\":true}\ndone\n";
        assert!(last_json::<L>(out).is_some_and(|l| l.ok));
        assert!(last_json::<L>("nothing").is_none());
    }

    #[test]
    fn numbers_print_as_in_javascript() {
        assert_eq!(js_num(30.0), "30");
        assert_eq!(js_num(37.5), "37.5");
        assert_eq!(js_code(None), "null");
    }

    #[test]
    fn a_projects_model_counts_only_for_its_own_provider() {
        let or = AgentRow { openrouter: true, openrouter_key: None, openrouter_model: Some("anthropic/claude-x".into()), openrouter_context: Some(200_000) };
        assert_eq!(pick_agent(&or, Some("gpt-6.2-sol"), None), Agent { provider: Provider::Openrouter, model: Some("anthropic/claude-x".into()), context: Some(200_000) });
        assert_eq!(pick_agent(&or, Some("openai/gpt-x"), None), Agent { provider: Provider::Openrouter, model: Some("openai/gpt-x".into()), context: None });
        let codex = AgentRow::default();
        assert_eq!(pick_agent(&codex, Some("openai/gpt-x"), Some("gpt-6.2-astra".into())).model.as_deref(), Some("gpt-6.2-astra"));
        assert_eq!(pick_agent(&codex, Some("gpt-6.2-sol"), Some("gpt-6.2-astra".into())).model.as_deref(), Some("gpt-6.2-sol"));
        assert_eq!(pick_agent(&codex, Some(""), None).model, None);
    }

    #[test]
    fn codex_exec_passes_requested_reasoning_effort() {
        let b = Sbx { id: "b".into(), slot: Slot::default(), repo: "/r".into(), gespann: "/g".into(), project: "/g/project".into(), recipe: "/g/project/verify.yml".into(), core: "/g/core".into() };
        let codex = |model: Option<&str>| Agent { provider: Provider::Codex, model: model.map(str::to_string), context: None };
        assert!(codex_exec(&b, "/p", "/l", "/j", &codex(None), "medium").contains("&& codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -c model_reasoning_effort=medium"));
        assert!(codex_exec(&b, "/p", "/l", "/j", &codex(Some("gpt-5")), "high").contains("-m 'gpt-5' -c model_reasoning_effort=high"));
        let or = Agent { provider: Provider::Openrouter, model: Some("x/y".into()), context: None };
        let c = codex_exec(&b, "/p", "/l", "/j", &or, "high");
        assert!(c.contains(r#"&& test -n "$_k" && OPENROUTER_API_KEY="$_k" codex exec "#), "{c}");
        assert!(c.contains("-m 'x/y' -c model_provider=openrouter -c 'model_providers.openrouter="), "{c}");
    }
}
