//! The remote provider speaks docs/remote-sandboxes.md to a sandbox service: one request per call,
//! the bearer token on each, and retries while the service is down or busy.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use gespann_orchestrator::sandbox::remote::Remote;
use gespann_orchestrator::sandbox::{CreateOpts, ProcState, Purpose, Sandboxes};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "a-remote-token-of-at-least-32-characters";

#[derive(Default)]
struct Seen {
    /// "METHOD /path?query" per request.
    lines: Vec<String>,
    bodies: Vec<Value>,
    auth_ok: Vec<bool>,
    /// The first `busy` requests answer 503.
    busy: usize,
    /// The first `gateway` requests answer 502.
    gateway: usize,
}

/// A sandbox service with one sandbox `sbx-1`, as a raw HTTP server.
async fn service(busy: usize) -> (String, Arc<Mutex<Seen>>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/sandboxes-api", l.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen { busy, ..Default::default() }));
    let s2 = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let seen = s2.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head, body) = loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        let len = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        while buf.len() < i + 4 + len {
                            let n = s.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (head, buf[i + 4..i + 4 + len].to_vec());
                    }
                };
                let line = head.lines().next().unwrap_or("").rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or_default();
                let auth_ok = head.lines().any(|l| l.eq_ignore_ascii_case(&format!("authorization: Bearer {TOKEN}")));
                let line = line.replacen("/sandboxes-api", "", 1);
                let (status, reply): (u16, Vec<u8>) = {
                    let mut st = seen.lock().unwrap();
                    st.lines.push(line.clone());
                    st.bodies.push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                    st.auth_ok.push(auth_ok);
                    if st.busy > 0 {
                        st.busy -= 1;
                        (503, b"{}".to_vec())
                    } else if st.gateway > 0 {
                        st.gateway -= 1;
                        (502, b"{}".to_vec())
                    } else {
                        answer(&line)
                    }
                };
                let out = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", reply.len());
                let _ = s.write_all(out.as_bytes()).await;
                let _ = s.write_all(&reply).await;
            });
        }
    });
    (base, seen)
}

fn answer(line: &str) -> (u16, Vec<u8>) {
    let j = |v: Value| (200, v.to_string().into_bytes());
    match line {
        "GET /info" => j(json!({ "kind": "cloud", "home": "/home/user", "maxJobs": 250, "pollSeconds": 5, "jobScript": "echo ready", "testerNote": "use the browser tool" })),
        "POST /sandboxes" => j(json!({ "id": "sbx-1" })),
        "GET /sandboxes/sbx-1" => j(json!({ "state": "running" })),
        "GET /sandboxes/gone" => (404, br#"{"error":"no such sandbox"}"#.to_vec()),
        "POST /sandboxes/sbx-1/exec" => j(json!({ "exitCode": 0, "stdout": "hi\n", "stderr": "", "timedOut": false })),
        "POST /sandboxes/sbx-1/processes" => j(json!({ "pid": 42 })),
        "GET /sandboxes/sbx-1/processes/42?tailBytes=100" => j(json!({ "state": "exited", "exitCode": 3, "stdout": "out", "stderr": "err" })),
        "GET /sandboxes/sbx-1/file?path=%2Fhome%2Fuser%2Fa%20b.txt" => j(json!({ "content": "text" })),
        "GET /sandboxes/sbx-1/file?path=%2Fmissing" => (404, br#"{"error":"no such file"}"#.to_vec()),
        "GET /sandboxes/sbx-1/download?path=%2Fv.mp4" => (200, vec![0, 1, 2, 255]),
        "POST /sandboxes/sbx-1/stop" => (500, br#"{"error":"the sandbox could not stop"}"#.to_vec()),
        _ => j(json!({})),
    }
}

#[tokio::test]
async fn every_call_is_one_request_of_the_protocol() {
    let (base, seen) = service(0).await;
    let r = Remote::connect(&base, TOKEN).await.unwrap();
    assert_eq!((r.kind(), r.home("sbx-1").as_str(), r.max_jobs(), r.min_poll()), ("cloud", "/home/user", Some(250), Duration::from_secs(5)));
    assert_eq!((r.job_script("/home/user").as_deref(), r.tester_note().as_deref()), (Some("echo ready"), Some("use the browser tool")));

    let id = r.create(CreateOpts { name: "gespann-acme-shop".into(), purpose: Purpose::Project, labels: vec![("gespann_project".into(), "7".into())], ttl_seconds: None }).await.unwrap();
    assert_eq!(id, "sbx-1");
    assert!(r.exists("sbx-1").await.unwrap());
    assert!(!r.exists("gone").await.unwrap(), "404 means gone for good");
    r.ensure_running("sbx-1").await.unwrap();
    let e = r.exec("sbx-1", "echo hi", 30).await.unwrap();
    assert_eq!((e.exit_code, e.stdout.as_str(), e.timed_out), (Some(0), "hi\n", false));
    assert_eq!(r.start("sbx-1", "codex exec").await.unwrap(), 42);
    let st = r.status("sbx-1", 42, 100).await.unwrap();
    assert_eq!((st.state, st.exit_code, st.stdout.as_str(), st.stderr.as_str()), (ProcState::Exited, Some(3), "out", "err"));
    assert_eq!(r.read_file("sbx-1", "/home/user/a b.txt").await.unwrap().as_deref(), Some("text"));
    assert_eq!(r.read_file("sbx-1", "/missing").await.unwrap(), None);
    r.write_file("sbx-1", "/home/user/.codex/auth.json", b"{\"k\":1}").await.unwrap();
    assert_eq!(r.download("sbx-1", "/v.mp4").await.unwrap(), vec![0, 1, 2, 255]);
    r.start_recording("sbx-1", "/home/user/out/rec.mp4").await.unwrap();
    r.stop_recording("sbx-1").await.unwrap();
    r.kill("sbx-1", 42).await.unwrap();
    let err = r.stop("sbx-1").await.unwrap_err().to_string();
    assert!(err.contains("500") && err.contains("the sandbox could not stop"), "the service's message reaches the job log: {err}");
    r.remove("sbx-1").await.unwrap();

    let st = seen.lock().unwrap();
    assert!(st.auth_ok.iter().all(|ok| *ok), "every request carries the token");
    let at = |l: &str| st.lines.iter().position(|x| x == l).unwrap_or_else(|| panic!("no request {l}: {:?}", st.lines));
    assert_eq!(st.bodies[at("POST /sandboxes")], json!({ "name": "gespann-acme-shop", "purpose": "project", "labels": { "gespann_project": "7" }, "ttlSeconds": null }));
    assert_eq!(st.bodies[at("POST /sandboxes/sbx-1/exec")], json!({ "command": "echo hi", "timeoutSeconds": 30 }));
    assert_eq!(st.bodies[at("PUT /sandboxes/sbx-1/file")], json!({ "path": "/home/user/.codex/auth.json", "base64": "eyJrIjoxfQ==" }));
    assert_eq!(st.bodies[at("POST /sandboxes/sbx-1/recording")], json!({ "file": "/home/user/out/rec.mp4" }));
    for l in ["POST /sandboxes/sbx-1/running", "DELETE /sandboxes/sbx-1/processes/42", "DELETE /sandboxes/sbx-1/recording", "DELETE /sandboxes/sbx-1"] {
        at(l);
    }
}

#[tokio::test]
async fn a_busy_or_deploying_service_is_waited_for() {
    let (base, seen) = service(2).await;
    let r = Remote::connect(&base, TOKEN).await.unwrap();
    assert_eq!(r.kind(), "cloud");
    assert_eq!(seen.lock().unwrap().lines, ["GET /info", "GET /info", "GET /info"], "two 503s, then the answer");

    // Busy for longer than the call's patience: it gives up and says why.
    let r = r.with_patience(Duration::from_secs(2));
    seen.lock().unwrap().busy = 1000;
    let err = r.exec("sbx-1", "true", 30).await.unwrap_err().to_string();
    assert!(err.contains("no answer") && err.contains("503"), "{err}");

    // A 502 may come after the service started the command: a POST is not sent again, a read is.
    seen.lock().unwrap().busy = 0;
    seen.lock().unwrap().gateway = 1;
    let before = seen.lock().unwrap().lines.len();
    let err = r.start("sbx-1", "codex exec").await.unwrap_err().to_string();
    assert!(err.contains("502"), "{err}");
    assert_eq!(seen.lock().unwrap().lines.len(), before + 1, "the start was sent once");
    seen.lock().unwrap().gateway = 1;
    assert!(r.exists("sbx-1").await.unwrap(), "a read tries again after a 502");
}
