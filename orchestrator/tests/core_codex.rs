//! A Codex sign-in sealed by the TypeScript UI opens in Rust, and the other way round.

use std::process::Command;

use gespann_orchestrator::codex::{open, seal};

/// Runs `src/server/codex.ts` in node (24+ runs .ts directly): `seal` or `open` with the given input.
fn node(mode: &str, secret: &str, input: &str) -> Option<String> {
    let codex = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/server/codex.ts").canonicalize().expect("src/server/codex.ts");
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("x.mjs");
    let url = format!("file://{}", codex.display());
    std::fs::write(
        &script,
        format!("import {{ seal, open }} from {url:?};\nconst {{ MODE, SECRET, INPUT }} = process.env;\nprocess.stdout.write(MODE === 'seal' ? seal(SECRET, INPUT) : open(SECRET, INPUT));\n"),
    )
    .unwrap();
    let out = match Command::new("node").arg(&script).env("MODE", mode).env("SECRET", secret).env("INPUT", input).output() {
        Ok(out) => out,
        Err(e) => {
            eprintln!("skipped: node is not available ({e})");
            return None;
        }
    };
    assert!(out.status.success(), "node: {}", String::from_utf8_lossy(&out.stderr));
    Some(String::from_utf8(out.stdout).unwrap())
}

const SECRET: &str = "a-session-secret-of-at-least-32-characters";
const AUTH: &str = r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"eyJ…","account_id":"acc-1"},"last_refresh":"2026-11-20T08:00:00.123456Z","note":"grüezi ✓"}"#;

#[test]
fn typescript_seals_rust_opens() {
    let Some(sealed) = node("seal", SECRET, AUTH) else { return };
    assert_eq!(open(SECRET, &sealed).unwrap(), AUTH);
    assert!(open("another-secret", &sealed).is_err());
}

#[test]
fn rust_seals_typescript_opens() {
    let sealed = seal(SECRET, AUTH);
    let Some(plain) = node("open", SECRET, &sealed) else { return };
    assert_eq!(plain, AUTH);
}
