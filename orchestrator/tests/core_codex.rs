//! Codex sign-ins in the database stay readable: one sealed by the former TypeScript server
//! (`seal` in `src/server/codex.ts` before the orchestrator took over) opens in Rust.

use gespann_orchestrator::codex::{open, seal};

const SECRET: &str = "a-session-secret-of-at-least-32-characters";
const AUTH: &str = r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"eyJ…","account_id":"acc-1"},"last_refresh":"2026-11-20T08:00:00.123456Z","note":"grüezi ✓"}"#;
/// `AUTH` as the TypeScript server sealed it with `SECRET`: iv.tag.body, each base64.
const SEALED_BY_TYPESCRIPT: &str = "wsHm94/iJwJ8CuSp.zHZAGZkvzubcV1CZ+mMEoA==.iEI0kbvzwmi+aFXvjQJLfF5bTLZnaDgYEpXq1ujROlG4+JxGqEbv6261ZjccHM9xMvFW3PzgMAzQBNQOcjsAiY+giMKWzp7Q6HyVPIPLvMrnBXxicWGcomGsRQwDmVcnIQz7zp25G5DP5LlCbDNnjR9RFMaSR2ylb7K+ta4aD418+mo4hz1qsBPJ2i8j";

#[test]
fn a_sign_in_the_typescript_server_sealed_opens() {
    assert_eq!(open(SECRET, SEALED_BY_TYPESCRIPT).unwrap(), AUTH);
    assert!(open("another-secret", SEALED_BY_TYPESCRIPT).is_err());
}

#[test]
fn seal_and_open_round_trip_in_the_same_format() {
    let sealed = seal(SECRET, AUTH);
    assert_eq!(sealed.split('.').count(), 3, "iv.tag.body");
    assert_ne!(sealed, seal(SECRET, AUTH), "a fresh iv each time");
    assert_eq!(open(SECRET, &sealed).unwrap(), AUTH);
}
