//! The UI client: retries while the UI is down, fails at once on a refusal.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use gespann_orchestrator::ui::{internal_token, Ui};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Answers each request with the next of `answers` (status, body); the last one repeats.
/// Returns the base URL, the request count, and the requests' heads.
async fn server(answers: Vec<(u16, &'static str)>) -> (String, Arc<AtomicUsize>, Arc<std::sync::Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let n = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (n2, seen2) = (n.clone(), seen.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let i = n2.fetch_add(1, Ordering::SeqCst);
            let (status, body) = answers[i.min(answers.len() - 1)];
            let mut buf = vec![0u8; 16384];
            let mut got = Vec::new();
            // The head, then as much body as content-length says.
            loop {
                let k = s.read(&mut buf).await.unwrap_or(0);
                if k == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..k]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if got.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            seen2.lock().unwrap().push(String::from_utf8_lossy(&got).to_string());
            let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(reply.as_bytes()).await;
            let _ = s.shutdown().await;
        }
    });
    (base, n, seen)
}

#[test]
fn token_matches_typescript() {
    // node -e 'crypto.createHash("sha256").update("gespann-internal:dev-only-session-secret").digest("hex")'
    assert_eq!(internal_token("dev-only-session-secret"), "5343a6a9d48ef2cafb6ebc9fe19dd6b3ca25a7edd12732e7e70de57c64336d9e");
}

#[tokio::test]
async fn retries_while_the_ui_is_down() {
    let (base, n, seen) = server(vec![(503, "down"), (503, "down"), (200, r#"{"refused":null}"#)]).await;
    let ui = Ui::new(&base, "dev-only-session-secret").with_patience(Duration::from_secs(20));
    assert_eq!(ui.admit(5).await.unwrap(), None);
    assert_eq!(n.load(Ordering::SeqCst), 3);
    let head = seen.lock().unwrap()[2].clone();
    assert!(head.starts_with("POST /internal/jobs/5/admit "), "{head}");
    assert!(head.to_ascii_lowercase().contains(&format!("authorization: bearer {}", internal_token("dev-only-session-secret"))));
}

#[tokio::test]
async fn a_refusal_fails_at_once() {
    let (base, n, _) = server(vec![(401, r#"{"error":"unauthorized"}"#)]).await;
    let ui = Ui::new(&base, "wrong").with_patience(Duration::from_secs(20));
    let started = std::time::Instant::now();
    let err = ui.git_token(3).await.unwrap_err().to_string();
    assert!(err.contains("401") && err.contains("unauthorized"), "{err}");
    assert_eq!(n.load(Ordering::SeqCst), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn gives_up_when_patience_runs_out_and_reads_answers() {
    // Nobody listens: connection errors until patience runs out.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    let ui = Ui::new(&base, "s").with_patience(Duration::from_millis(1500));
    assert!(ui.ended(1).await.is_err());
    // check is best effort: no error, no panic.
    ui.check(1, "t", "s").await;

    let (base, _, seen) = server(vec![(200, r#"{"pull":{"state":"open","merged":false,"head":"abc"}}"#), (200, r##"{"prText":"# t\n\nb\n","issues":[{"ref":"#1","title":"i","url":"u","body":"b"}],"issuesMd":"m","unread":null}"##), (200, "{}")]).await;
    let ui = Ui::new(&base, "s");
    let p = ui.pull(9).await.unwrap().unwrap();
    assert_eq!((p.state.as_str(), p.merged, p.head.as_str()), ("open", false, "abc"));
    let c = ui.context(9).await.unwrap();
    assert_eq!((c.issues[0].reference.as_str(), c.issues_md.as_str(), c.unread), ("#1", "m", None));
    ui.report(9, 4, None, &["a.png".to_string()]).await.unwrap();
    let req = seen.lock().unwrap()[2].clone();
    assert!(req.contains(r#""jobId":4"#) && req.contains(r#""judged":null"#) && req.contains(r#""files":["a.png"]"#), "{req}");
}
