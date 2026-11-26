//! What the orchestrator reads from a run: screen sizes (as `src/verify/viewports.ts` stores them), live
//! progress (read by the UI as `src/verify/progress.ts`), same-screen screenshots and copy gaps.
//! Verdicts stay `serde_json::Value`: the in-sandbox CLI writes and judges them.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- viewports.ts

/// A browser size the tester checks the app at, chosen per project on the Setup page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

/// Common device sizes in CSS pixels, smallest first.
pub static VIEWPORTS: LazyLock<Vec<Viewport>> = LazyLock::new(|| {
    [
        ("phone-s", "Small phone", 375, 667),
        ("phone-l", "Large phone", 430, 932),
        ("tablet", "Tablet", 768, 1024),
        ("laptop", "Laptop", 1280, 800),
        ("desktop", "Desktop", 1440, 900),
        ("desktop-l", "Large desktop", 1920, 1080),
    ]
    .into_iter()
    .map(|(id, name, width, height)| Viewport { id: id.into(), name: name.into(), width, height })
    .collect()
});

/// The project's stored list (`phone-s,desktop`), as known sizes in preset order; unknown ids drop out.
pub fn viewports_of(stored: &str) -> Vec<Viewport> {
    let ids: Vec<&str> = stored.split(',').map(str::trim).collect();
    VIEWPORTS.iter().filter(|v| ids.contains(&v.id.as_str())).cloned().collect()
}

/// The virtual screen a run needs so the browser window fits the largest size: the window adds
/// Chromium's tab strip and toolbar (about 90 px) and sits 10 px from the screen's corner.
/// None without sizes: the sandbox keeps its default screen.
pub fn screen_for(viewports: &[Viewport]) -> Option<String> {
    if viewports.is_empty() {
        return None;
    }
    let w = viewports.iter().map(|v| v.width + 20).fold(1440, u32::max);
    let h = viewports.iter().map(|v| v.height + 120).fold(900, u32::max);
    Some(format!("{w}x{h}x24"))
}

// ---- progress.ts

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Sandbox,
    Copy,
    Read,
    Checks,
    Verdict,
}

pub const STAGES: [Stage; 5] = [Stage::Sandbox, Stage::Copy, Stage::Read, Stage::Checks, Stage::Verdict];

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Stage::Sandbox => "sandbox",
            Stage::Copy => "copy",
            Stage::Read => "read",
            Stage::Checks => "checks",
            Stage::Verdict => "verdict",
        }
    }
}

/// When each stage started; a stage is done when the next one has started.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageTimes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
}

impl StageTimes {
    fn slot(&mut self, s: Stage) -> &mut Option<String> {
        match s {
            Stage::Sandbox => &mut self.sandbox,
            Stage::Copy => &mut self.copy,
            Stage::Read => &mut self.read,
            Stage::Checks => &mut self.checks,
            Stage::Verdict => &mut self.verdict,
        }
    }
    pub fn get(&self, s: Stage) -> Option<&String> {
        match s {
            Stage::Sandbox => self.sandbox.as_ref(),
            Stage::Copy => self.copy.as_ref(),
            Stage::Read => self.read.as_ref(),
            Stage::Checks => self.checks.as_ref(),
            Stage::Verdict => self.verdict.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveCheck {
    pub expect: String,
    /// None while the check is planned or running.
    pub result: Option<String>,
    /// The tester said it is on this check now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
    /// When the server first saw the result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Said {
    pub at: String,
    pub text: String,
}

/// Live progress of a run, as `runs.progress` holds it for the run page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    #[serde(default)]
    pub at: StageTimes,
    /// 2 when the copy was fixed and the tester runs again.
    #[serde(default = "one")]
    pub attempt: u32,
    /// When the sandbox stage ended, kept when a second attempt starts the copy again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_done: Option<String>,
    #[serde(default)]
    pub checks: Vec<LiveCheck>,
    /// What the tester said it is doing, newest last, at most `TRAIL`.
    #[serde(default)]
    pub now: Vec<Said>,
}

fn one() -> u32 {
    1
}

pub const TRAIL: usize = 3;
const MAX_CHECKS: usize = 20;
const MAX_TEXT: usize = 300;

pub fn empty_progress() -> Progress {
    Progress { at: StageTimes::default(), attempt: 1, sandbox_done: None, checks: vec![], now: vec![] }
}

fn current(p: &Progress) -> Option<Stage> {
    STAGES.iter().rev().copied().find(|s| p.at.get(*s).is_some())
}

/// Starts `stage` now. A later attempt starts over from the copy, with no checks from the attempt before.
pub fn start_stage(p: &Progress, stage: Stage, at: &str, attempt: Option<u32>) -> Progress {
    let attempt = attempt.unwrap_or(p.attempt);
    // Already running (the copy of a second attempt, after its fix): the stage keeps its start.
    if attempt == p.attempt && current(p) == Some(stage) {
        return p.clone();
    }
    let sandbox_done = p.sandbox_done.clone().or_else(|| p.at.copy.clone());
    let mut next = if attempt == p.attempt {
        p.clone()
    } else {
        Progress { at: StageTimes { sandbox: p.at.sandbox.clone(), ..Default::default() }, attempt, sandbox_done, checks: vec![], now: vec![] }
    };
    // A stage that starts again (a second attempt) drops the stages after it.
    let from = STAGES.iter().position(|s| *s == stage).unwrap_or(0);
    for s in &STAGES[from..] {
        *next.at.slot(*s) = None;
    }
    *next.at.slot(stage) = Some(at.to_string());
    next
}

fn text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(MAX_TEXT).collect())
}

/// Merges what the tester wrote into `progress.json` (`{"checks":[{"expect","result","observed"}],"now":"..."}`).
/// Anything unreadable leaves the progress as it was: the file is the tester's, written mid-run.
pub fn merge_tester(p: &Progress, raw: Option<&str>, at: &str) -> Progress {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else { return p.clone() };
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(raw) else { return p.clone() };
    let mut checks: Vec<LiveCheck> = vec![];
    if let Some(Value::Array(list)) = o.get("checks") {
        for c in list.iter().take(MAX_CHECKS) {
            let expect = if c.is_string() { text(Some(c)) } else { text(c.get("expect")) };
            let Some(expect) = expect else { continue };
            let raw_result = c.get("result").and_then(Value::as_str);
            let result = raw_result.filter(|r| ["pass", "fail", "blocked"].contains(r)).map(String::from);
            let before = p.checks.iter().find(|b| b.expect == expect);
            let observed = if result.is_some() { text(c.get("observed")) } else { None };
            let active = result.is_none() && raw_result == Some("running");
            let seen = result.as_ref().map(|r| match before {
                Some(b) if b.result.as_ref() == Some(r) && b.at.is_some() => b.at.clone().unwrap_or_default(),
                _ => at.to_string(),
            });
            checks.push(LiveCheck { expect, result, active: active.then_some(true), observed, at: seen });
        }
    }
    let mut next = p.clone();
    if !checks.is_empty() && checks != p.checks {
        next.checks = checks;
        if next.at.checks.is_none() {
            next = start_stage(&next, Stage::Checks, at, None);
        }
    }
    if let Some(now) = text(o.get("now")) {
        if next.now.last().map(|n| &n.text) != Some(&now) {
            next.now.push(Said { at: at.to_string(), text: now });
            let drop = next.now.len().saturating_sub(TRAIL);
            next.now.drain(..drop);
        }
    }
    next
}

pub fn parse_progress(raw: Option<&str>) -> Option<Progress> {
    serde_json::from_str(raw.filter(|r| !r.is_empty())?).ok()
}

// ---- same-screen screenshots

/// Side of the grey thumbnail two screenshots are compared on.
pub const THUMB: usize = 24;

/// Mean difference per pixel (0–255) below which two thumbnails count as the same screen.
/// Measured on a real run: the same page with another radio button selected scores 0–1.5,
/// different pages score 2.4 and up.
pub const SAME_SCREEN: f64 = 2.0;

/// Shell snippet that prints `<file> <base64 thumbnail>` per image, with ImageMagick 7 or 6.
/// File names are checked by the caller (letters, digits, `._-`), so plain quotes are enough.
pub fn thumb_command(files: &[String]) -> String {
    let size = format!("{THUMB}x{THUMB}!");
    files
        .iter()
        .map(|f| format!("printf '%s ' '{f}'; (magick '{f}' -resize {size} -colorspace Gray -depth 8 gray:- 2>/dev/null || convert '{f}' -resize {size} -colorspace Gray -depth 8 gray:- 2>/dev/null) | base64 -w0; echo"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn parse_thumbs(stdout: &str) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for line in stdout.split('\n') {
        let mut parts = line.trim().split(' ');
        let (Some(name), Some(b64)) = (parts.next(), parts.next()) else { continue };
        if name.is_empty() || b64.is_empty() {
            continue;
        }
        let Ok(buf) = base64::engine::general_purpose::STANDARD.decode(b64) else { continue };
        if buf.len() == THUMB * THUMB {
            out.insert(name.to_string(), buf);
        }
    }
    out
}

fn distance(a: &[u8], b: &[u8]) -> f64 {
    let sum: u64 = a.iter().zip(b).map(|(x, y)| u64::from(x.abs_diff(*y))).sum();
    sum as f64 / a.len() as f64
}

/// Maps each screenshot that shows the same screen as an earlier one (by file name order) to that
/// earlier one. Files without a thumbnail are kept as they are.
pub fn same_screens(thumbs: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    let mut kept: Vec<(&String, &Vec<u8>)> = vec![];
    let mut alias = BTreeMap::new();
    for (name, t) in thumbs {
        match kept.iter().find(|(_, k)| distance(k, t) < SAME_SCREEN) {
            Some((twin, _)) => {
                alias.insert(name.clone(), (*twin).clone());
            }
            None => kept.push((name, t)),
        }
    }
    alias
}

/// Points the verdict's proof at the kept screenshots, each listed once.
pub fn with_aliases(j: &Value, alias: &BTreeMap<String, String>) -> Value {
    if alias.is_empty() || !j.get("verdict").is_some_and(Value::is_object) {
        return j.clone();
    }
    let map = |files: &Value| -> Value {
        let mut out: Vec<Value> = vec![];
        for f in files.as_array().into_iter().flatten() {
            let f = f.as_str().map(|s| alias.get(s).cloned().unwrap_or_else(|| s.to_string())).map(Value::String).unwrap_or_else(|| f.clone());
            if !out.contains(&f) {
                out.push(f);
            }
        }
        Value::Array(out)
    };
    let mut j = j.clone();
    let v = &mut j["verdict"];
    v["proof"] = map(&v["proof"]);
    for list in ["checks", "goals"] {
        if let Some(items) = v.get_mut(list).and_then(Value::as_array_mut) {
            for c in items {
                if c.get("proof").is_some_and(|p| !p.is_null()) {
                    c["proof"] = map(&c["proof"]);
                }
            }
        }
    }
    j
}

// ---- verdict.ts

fn clean(j: &Value) -> bool {
    j.get("verdict").is_some_and(Value::is_object) && j.get("problems").and_then(Value::as_array).map_or(0, Vec::len) == 0
}

/// Blocked checks the copy could be changed to support: the run fixes the copy and tests again. Also
/// inside a FAIL: the failed checks stand, but the blocked ones would otherwise never be tested.
pub fn copy_gaps(j: Option<&Value>) -> Vec<Value> {
    let Some(j) = j else { return vec![] };
    if !clean(j) || !matches!(j.get("outcome").and_then(Value::as_str), Some("BLOCKED" | "FAIL")) {
        return vec![];
    }
    j["verdict"]["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["result"] == "blocked" && c.get("fix").and_then(Value::as_str).is_some_and(|f| !f.is_empty()))
        .cloned()
        .collect()
}

/// Prefix of the first test's proof files that the combined result keeps.
pub const FIRST: &str = "first-";

/// The result after the copy was fixed and the PR tested again. The second test judges the PR on the
/// fixed copy. A failure the first test found is a fault in the change, not in the copy: when the
/// second test did not fail, the first test's failed checks and missed goals stay in the result and it
/// fails. Their proof is renamed with `FIRST`; the list names the first test's files to keep. `None`
/// when the second test's result stands as it is.
pub fn combine(first: &Value, second: &Value) -> Option<(Value, Vec<String>)> {
    if !clean(first) || !clean(second) || first["outcome"] != "FAIL" || second["outcome"] == "FAIL" {
        return None;
    }
    let (v1, v2) = (&first["verdict"], &second["verdict"]);
    let mut carried: Vec<String> = vec![];
    let note = "In the first test, before the copy was fixed: ";
    let mut moved = |e: &Value| {
        let mut e = e.clone();
        e["observed"] = Value::String(format!("{note}{}", e["observed"].as_str().unwrap_or("")));
        if let Some(proof) = e.get("proof").and_then(Value::as_array).cloned() {
            let names: Vec<String> = proof.iter().filter_map(Value::as_str).map(String::from).collect();
            for f in &names {
                if !carried.contains(f) {
                    carried.push(f.clone());
                }
            }
            e["proof"] = names.iter().map(|f| Value::String(format!("{FIRST}{f}"))).collect();
        }
        e
    };
    let list = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let failed: Vec<Value> = list(v1, "checks").iter().filter(|c| c["result"] == "fail").map(&mut moved).collect();
    let missed: Vec<Value> = list(v1, "goals").iter().filter(|g| g["result"] == "missed").map(&mut moved).collect();
    let same = |a: &Value, b: &Value| a.as_str().unwrap_or("").trim().to_lowercase() == b.as_str().unwrap_or("").trim().to_lowercase();
    let mut verdict = v2.clone();
    verdict["verdict"] = "FAIL".into();
    let mut checks = list(v2, "checks");
    checks.extend(failed);
    verdict["checks"] = Value::Array(checks);
    if let Some(goals) = v2.get("goals").and_then(Value::as_array) {
        verdict["goals"] = goals.iter().map(|g| missed.iter().find(|m| same(&m["issue"], &g["issue"])).unwrap_or(g).clone()).collect();
    }
    let mut proof = list(v2, "proof");
    proof.extend(carried.iter().map(|f| Value::String(format!("{FIRST}{f}"))));
    verdict["proof"] = Value::Array(proof);
    let s2 = v2["summary"].as_str().unwrap_or("");
    let after = format!("After the copy was fixed, the second test ended {}{}", second["outcome"].as_str().unwrap_or(""), if s2.is_empty() { ".".into() } else { format!(": {s2}") });
    verdict["summary"] = [v1["summary"].as_str().unwrap_or(""), &after].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(" ").into();
    Some((serde_json::json!({ "verdict": verdict, "outcome": "FAIL", "problems": [] }), carried))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T1: &str = "2026-11-26T06:34:00.000Z";
    const T2: &str = "2026-11-26T06:35:00.000Z";

    fn ids(v: &[Viewport]) -> Vec<&str> {
        v.iter().map(|v| v.id.as_str()).collect()
    }

    fn check(expect: &str, result: Option<&str>) -> LiveCheck {
        LiveCheck { expect: expect.into(), result: result.map(String::from), active: None, observed: None, at: None }
    }

    #[test]
    fn stored_sizes_come_back_in_preset_order_and_the_screen_fits_the_largest() {
        assert_eq!(ids(&viewports_of("desktop-l, phone-s,watch")), ["phone-s", "desktop-l"]);
        assert!(viewports_of("").is_empty());
        assert_eq!(screen_for(&[]), None);
        assert_eq!(screen_for(&viewports_of("laptop")).as_deref(), Some("1440x920x24"), "the window's toolbar sits above the 800 px page");
        assert_eq!(screen_for(&viewports_of("phone-s,desktop-l")).as_deref(), Some("1940x1200x24"));
        assert_eq!(screen_for(&viewports_of("tablet")).as_deref(), Some("1440x1144x24"));
    }

    #[test]
    fn the_testers_plan_starts_the_checks_stage_and_a_result_keeps_when_it_was_first_seen() {
        let mut p = start_stage(&start_stage(&empty_progress(), Stage::Sandbox, T1, None), Stage::Read, T1, None);
        p = merge_tester(&p, Some(&json!({"checks": [{"expect": "A", "result": null}, "B"], "now": "Reading the diff"}).to_string()), T1);
        assert_eq!(p.at.checks.as_deref(), Some(T1));
        assert_eq!(p.checks, vec![check("A", None), check("B", None)]);
        p = merge_tester(&p, Some(&json!({"checks": [{"expect": "A", "result": "pass", "observed": "fine"}, {"expect": "B"}], "now": "Opening B"}).to_string()), T1);
        p = merge_tester(&p, Some(&json!({"checks": [{"expect": "A", "result": "pass", "observed": "fine"}, {"expect": "B", "result": "weird"}], "now": "Opening B"}).to_string()), T2);
        assert_eq!(p.checks[0], LiveCheck { expect: "A".into(), result: Some("pass".into()), active: None, observed: Some("fine".into()), at: Some(T1.into()) });
        assert_eq!(p.checks[1], check("B", None), "an unknown result counts as not done");
        assert_eq!(p.now.iter().map(|n| n.text.as_str()).collect::<Vec<_>>(), ["Reading the diff", "Opening B"], "the same sentence twice is one entry");
    }

    #[test]
    fn a_broken_file_leaves_the_progress_and_the_trail_keeps_the_last_three() {
        let mut p = empty_progress();
        for raw in [None, Some(""), Some("{"), Some("[]"), Some("\"x\""), Some(r#"{"checks":"no"}"#)] {
            assert_eq!(merge_tester(&p, raw, T1), p);
        }
        for n in ["a", "b", "c", "d"] {
            p = merge_tester(&p, Some(&json!({ "now": n }).to_string()), T1);
        }
        assert_eq!(p.now.iter().map(|n| n.text.as_str()).collect::<Vec<_>>(), ["b", "c", "d"]);
    }

    #[test]
    fn a_second_attempt_starts_over_from_the_copy_and_keeps_when_the_sandbox_started() {
        let mut p = start_stage(&empty_progress(), Stage::Sandbox, T1, None);
        p = start_stage(&p, Stage::Copy, T1, None);
        p = merge_tester(&start_stage(&p, Stage::Read, T1, None), Some(r#"{"checks":["A"],"now":"x"}"#), T1);
        p = start_stage(&p, Stage::Verdict, T1, None);
        p = start_stage(&p, Stage::Copy, T2, Some(2));
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({"at": {"sandbox": T1, "copy": T2}, "attempt": 2, "sandboxDone": T1, "checks": [], "now": []}), "the sandbox keeps its own end");
        assert_eq!(start_stage(&p, Stage::Copy, "2026-11-26T06:40:00.000Z", Some(2)), p, "the copy of the second attempt keeps the start of its fix");
    }

    #[test]
    fn the_check_the_tester_marks_running_is_the_active_one() {
        let p = merge_tester(&empty_progress(), Some(r#"{"checks":[{"expect":"A","result":null},{"expect":"B","result":"running"}]}"#), T1);
        assert_eq!(serde_json::to_value(&p.checks).unwrap(), json!([{"expect": "A", "result": null}, {"expect": "B", "result": null, "active": true}]));
    }

    #[test]
    fn progress_json_has_the_shape_the_web_app_reads() {
        let p = empty_progress();
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"at":{},"attempt":1,"checks":[],"now":[]}"#);
        assert_eq!(parse_progress(Some(&serde_json::to_string(&p).unwrap())), Some(p));
        assert_eq!(parse_progress(Some("{")), None);
        assert_eq!(parse_progress(None), None);
    }

    #[test]
    fn screenshots_of_the_same_screen_are_kept_once_and_the_verdict_points_at_the_kept_one() {
        let page = |v: u8, dot: usize| {
            let mut b = vec![v; THUMB * THUMB];
            for x in b.iter_mut().take(dot) {
                *x = 0;
            }
            b
        };
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let out = [
            format!("01-modal.png {}", b64(&page(200, 0))),
            // 5 of 576 pixels differ: same screen
            format!("02-modal-other-option.png {}", b64(&page(200, 5))),
            format!("03-checkout.png {}", b64(&page(120, 0))),
            format!("broken.png {}", b64(&[0, 0, 0])),
        ]
        .join("\n");
        let thumbs = parse_thumbs(&out);
        assert_eq!(thumbs.len(), 3);
        let alias = same_screens(&thumbs);
        assert_eq!(alias.into_iter().collect::<Vec<_>>(), [("02-modal-other-option.png".to_string(), "01-modal.png".to_string())]);
        let alias = same_screens(&thumbs);
        let judged = with_aliases(
            &json!({
                "outcome": "PASS", "problems": [],
                "verdict": {
                    "verdict": "PASS", "summary": "",
                    "proof": ["01-modal.png", "02-modal-other-option.png", "03-checkout.png"],
                    "checks": [{"expect": "b", "observed": "b", "result": "pass", "proof": ["02-modal-other-option.png"]}, {"expect": "c", "observed": "c", "result": "pass"}]
                }
            }),
            &alias,
        );
        assert_eq!(judged["verdict"]["proof"], json!(["01-modal.png", "03-checkout.png"]));
        assert_eq!(judged["verdict"]["checks"][0]["proof"], json!(["01-modal.png"]));
        assert!(judged["verdict"]["checks"][1].get("proof").is_none(), "a check without proof stays without");
        assert!(judged["verdict"].get("goals").is_none());
    }

    #[test]
    fn the_thumbnail_command_tries_imagemagick_7_then_6() {
        let c = thumb_command(&["a.png".into(), "b.png".into()]);
        assert!(c.starts_with("printf '%s ' 'a.png'; (magick 'a.png' -resize 24x24! -colorspace Gray -depth 8 gray:- 2>/dev/null || convert 'a.png'"));
        assert!(c.contains("| base64 -w0; echo; printf '%s ' 'b.png'"));
    }

    #[test]
    fn a_clean_blocked_or_failed_verdict_asks_for_a_repair() {
        let blocked = json!({
            "outcome": "BLOCKED", "problems": [],
            "verdict": {"verdict": "BLOCKED", "summary": "s", "proof": [], "checks": [
                {"expect": "pricing on the landing page", "observed": "landing not built on the copy", "result": "blocked", "fix": "build and serve apps/landing"},
                {"expect": "pay", "observed": "needs a real card reader", "result": "blocked"},
                {"expect": "login", "observed": "ok", "result": "pass", "fix": "ignored on a pass"}
            ]}
        });
        let gaps = copy_gaps(Some(&blocked));
        assert_eq!(gaps.iter().map(|g| g["expect"].as_str().unwrap()).collect::<Vec<_>>(), ["pricing on the landing page"]);
        // A failed check does not hide a gap in the copy: the blocked check still gets its repair.
        let mut failed = blocked.clone();
        failed["outcome"] = json!("FAIL");
        assert_eq!(copy_gaps(Some(&failed)).len(), 1);
        let mut skipped = blocked.clone();
        skipped["outcome"] = json!("SKIP");
        assert!(copy_gaps(Some(&skipped)).is_empty());
        let mut broken = blocked.clone();
        broken["problems"] = json!(["BLOCKED with a failed check"]);
        assert!(copy_gaps(Some(&broken)).is_empty());
        assert!(copy_gaps(None).is_empty());
        assert!(copy_gaps(Some(&json!({"verdict": null, "outcome": "BLOCKED", "problems": []}))).is_empty());
    }

    #[test]
    fn after_the_copy_is_fixed_a_failure_the_first_test_found_stays_in_the_result() {
        let first = json!({
            "outcome": "FAIL", "problems": [],
            "verdict": {"verdict": "FAIL", "summary": "fail", "proof": ["report-error.png"], "checks": [
                {"expect": "pair Zotero", "observed": "no Zotero client", "result": "blocked", "fix": "provide a Zotero test client"},
                {"expect": "open the report", "observed": "React error #185", "result": "fail", "proof": ["report-error.png"]}
            ], "goals": [{"issue": "#7", "goal": "g", "observed": "report breaks", "result": "missed", "proof": ["report-error.png"]}]}
        });
        let passed = json!({
            "outcome": "PASS", "problems": [],
            "verdict": {"verdict": "PASS", "summary": "pass", "proof": ["paired.png", "report.png"], "checks": [
                {"expect": "pair Zotero", "observed": "paired", "result": "pass", "proof": ["paired.png"]},
                {"expect": "open the report", "observed": "opened", "result": "pass", "proof": ["report.png"]}
            ], "goals": [{"issue": " #7", "goal": "g", "observed": "ok", "result": "met"}]}
        });
        let (j, carried) = combine(&first, &passed).expect("the first test's failure is kept");
        assert_eq!(j["outcome"], "FAIL");
        assert_eq!(j["verdict"]["verdict"], "FAIL");
        assert_eq!(carried, ["report-error.png"]);
        let checks: Vec<(&str, &str)> = j["verdict"]["checks"].as_array().unwrap().iter().map(|c| (c["expect"].as_str().unwrap(), c["result"].as_str().unwrap())).collect();
        assert_eq!(checks, [("pair Zotero", "pass"), ("open the report", "pass"), ("open the report", "fail")]);
        assert!(j["verdict"]["checks"][2]["observed"].as_str().unwrap().starts_with("In the first test, before the copy was fixed: React error #185"));
        assert_eq!(j["verdict"]["checks"][2]["proof"], json!(["first-report-error.png"]));
        assert_eq!(j["verdict"]["goals"][0]["result"], "missed");
        assert_eq!(j["verdict"]["proof"], json!(["paired.png", "report.png", "first-report-error.png"]));
        assert_eq!(j["verdict"]["summary"], "fail After the copy was fixed, the second test ended PASS: pass");
        // A second FAIL, or a first test that was only blocked, is reported as the second test found it.
        let mut failed_again = passed.clone();
        failed_again["outcome"] = json!("FAIL");
        assert!(combine(&first, &failed_again).is_none());
        let mut blocked = first.clone();
        blocked["outcome"] = json!("BLOCKED");
        assert!(combine(&blocked, &passed).is_none());
    }
}
