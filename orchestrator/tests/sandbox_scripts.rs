//! The scripts must stay byte-identical to the TypeScript ones: sandboxes made by the TypeScript worker
//! are taken over as they are. Regenerate the fixture from the repo root with
//! `node orchestrator/tests/fixtures/gen-scripts.ts > orchestrator/tests/fixtures/scripts.json`.

use gespann_orchestrator::sandbox::scripts::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/scripts.json")).expect("scripts.json")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

fn rows<'a>(f: &'a Value, key: &str) -> &'a Vec<Value> {
    let r = f[key].as_array().unwrap_or_else(|| panic!("{key} in scripts.json"));
    assert!(!r.is_empty(), "{key} has no cases");
    r
}

#[test]
fn quoting() {
    for row in rows(&fixture(), "q") {
        assert_eq!(q(s(&row[0])), s(&row[1]));
    }
}

#[test]
fn splitting_words() {
    for row in rows(&fixture(), "words") {
        let want: Vec<String> = row[1].as_array().unwrap().iter().map(|w| s(w).to_string()).collect();
        assert_eq!(words(s(&row[0])).unwrap(), want, "{:?}", row[0]);
    }
    assert_eq!(words("a 'b").unwrap_err().to_string(), "unclosed ' in: a 'b");
}

#[test]
fn prelude_matches() {
    for row in rows(&fixture(), "prelude") {
        assert_eq!(prelude(s(&row[0])), s(&row[1]));
    }
}

#[test]
fn recording_scripts_match() {
    let f = fixture();
    for row in rows(&f, "record") {
        assert_eq!(record_script(s(&row[0]), false), s(&row[1]));
        assert_eq!(record_script(s(&row[0]), true), s(&row[2]));
    }
    assert_eq!(stop_record_script(), s(&f["stopRecord"]));
    for row in rows(&f, "finishRecording") {
        assert_eq!(finish_recording_script(s(&row[0])), s(&row[1]));
    }
}

#[test]
fn screen_scripts_match() {
    let f = fixture();
    for row in rows(&f, "screen") {
        assert_eq!(screen_script(s(&row[0])), s(&row[1]));
    }
    for row in rows(&f, "stopScreen") {
        assert_eq!(stop_screen_script(s(&row[0])), s(&row[1]));
    }
}

#[test]
fn install_script_matches() {
    for row in rows(&fixture(), "install") {
        assert_eq!(install_script(s(&row[0]), s(&row[1]), s(&row[2]), s(&row[3])), s(&row[4]));
    }
}
