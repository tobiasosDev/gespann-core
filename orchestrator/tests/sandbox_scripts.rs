//! The scripts stay byte-identical to the ones the former TypeScript worker wrote (fixtures/scripts.json):
//! sandboxes it made, with their screens, recordings and installed gespann, keep working as they are.

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

/// The sandbox's screen starts at the size a run asks for, keeps a matching one, and stop forgets the size.
#[test]
fn screen_script_starts_keeps_and_resizes_the_screen() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let d = dir.path().to_str().unwrap().to_string();
    // A stand-in Xvfb: reports display 42 + its start count on fd 3, notes its size and stays up.
    let xvfb = bin.path().join("Xvfb");
    std::fs::write(&xvfb, format!("#!/bin/bash\nn=$(( $(wc -l < {d}/starts 2>/dev/null || echo 0) + 42 ))\necho \"$5\" >> {d}/starts\necho $n >&3\nexec sleep 30\n")).unwrap();
    std::fs::set_permissions(&xvfb, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.path().display(), std::env::var("PATH").unwrap_or_default());
    let run = |script: String| {
        let out = Command::new("bash").arg("-c").arg(script).env("PATH", &path).env("DISPLAY", ":77").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    let starts = || std::fs::read_to_string(dir.path().join("starts")).unwrap().trim().lines().map(String::from).collect::<Vec<_>>();
    let screen = dir.path().join(".gespann-screen");
    run(screen_script(&d));
    assert_eq!(starts(), ["1440x900x24"]);
    run(screen_script(&d));
    assert_eq!(starts().len(), 1, "a live screen of the right size stays");
    std::fs::write(&screen, "1940x1200x24\n").unwrap();
    run(screen_script(&d));
    assert_eq!(starts(), ["1440x900x24", "1940x1200x24"]);
    assert_eq!(std::fs::read_to_string(dir.path().join(".gespann-display")).unwrap().trim(), ":43", "the new screen's display");
    run(screen_script(&d));
    assert_eq!(starts().len(), 2);
    run(stop_screen_script(&d));
    run(screen_script(&d));
    assert_eq!(starts(), ["1440x900x24", "1940x1200x24", "1440x900x24"], "after stop the next job gets the default screen");
    std::fs::write(&screen, "1940x1200x24; rm -rf /\n").unwrap();
    run(screen_script(&d));
    assert_eq!(starts().len(), 3, "a malformed size is ignored");
    run(stop_screen_script(&d));
}
