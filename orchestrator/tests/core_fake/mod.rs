//! A sandbox host for tests: background commands run until `finished` is set, files live in a map.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use anyhow::Result;
use async_trait::async_trait;
use gespann_orchestrator::sandbox::{CommandResult, CreateOpts, ProcState, ProcessStatus, Sandboxes};

#[derive(Default)]
pub struct Fake {
    pub starts: AtomicU64,
    pub finished: AtomicBool,
    /// What a background command prints (stdout).
    pub output: Mutex<String>,
    /// What `exec` prints (stdout).
    pub exec_output: Mutex<String>,
    pub polled: Mutex<Vec<u64>>,
    pub killed: Mutex<Vec<u64>>,
    pub execs: Mutex<Vec<String>>,
    pub started: Mutex<Vec<String>>,
    pub writes: Mutex<Vec<String>>,
    pub removed: Mutex<Vec<String>>,
    pub files: Mutex<HashMap<String, String>>,
    pub capacity: Mutex<Option<(u32, f64)>>,
}

impl Fake {
    pub fn file(&self, path: &str) -> Option<String> {
        self.files.lock().unwrap().get(path).cloned()
    }
    pub fn set_file(&self, path: &str, text: &str) {
        self.files.lock().unwrap().insert(path.to_string(), text.to_string());
    }
}

#[async_trait]
impl Sandboxes for Fake {
    fn kind(&self) -> &str {
        "fake"
    }
    async fn create(&self, opts: CreateOpts) -> Result<String> {
        Ok(format!("{}-x1", opts.name))
    }
    async fn exists(&self, _: &str) -> Result<bool> {
        Ok(true)
    }
    fn home(&self, _: &str) -> String {
        "/home/user".into()
    }
    async fn ensure_running(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn keep_alive(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn stop(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn remove(&self, id: &str) -> Result<()> {
        self.removed.lock().unwrap().push(id.to_string());
        Ok(())
    }
    async fn exec(&self, _: &str, command: &str, _: u64) -> Result<CommandResult> {
        self.execs.lock().unwrap().push(command.to_string());
        if command.starts_with("rm -f ~/.codex/auth.json") {
            self.files.lock().unwrap().remove("/home/user/.codex/auth.json");
        }
        if command.contains("~/.gespann-openrouter-key") {
            self.files.lock().unwrap().remove("/home/user/.gespann-openrouter-key");
        }
        if let Some(path) = command.strip_prefix("rm -f '").and_then(|p| p.strip_suffix('\'')) {
            self.files.lock().unwrap().remove(path);
        }
        Ok(CommandResult { exit_code: Some(0), stdout: self.exec_output.lock().unwrap().clone(), ..Default::default() })
    }
    async fn start(&self, _: &str, command: &str) -> Result<u64> {
        self.started.lock().unwrap().push(command.to_string());
        Ok(100 + self.starts.fetch_add(1, Ordering::SeqCst))
    }
    async fn status(&self, _: &str, pid: u64, _: usize) -> Result<ProcessStatus> {
        self.polled.lock().unwrap().push(pid);
        let done = self.finished.load(Ordering::SeqCst) || self.killed.lock().unwrap().contains(&pid);
        let out = self.output.lock().unwrap().clone();
        Ok(ProcessStatus {
            state: if done { ProcState::Exited } else { ProcState::Running },
            exit_code: if done { Some(0) } else { None },
            stdout: if out.is_empty() { format!("out of {pid}") } else { out },
            stderr: String::new(),
        })
    }
    async fn kill(&self, _: &str, pid: u64) -> Result<()> {
        self.killed.lock().unwrap().push(pid);
        Ok(())
    }
    async fn read_file(&self, _: &str, path: &str) -> Result<Option<String>> {
        Ok(self.file(path))
    }
    async fn write_file(&self, _: &str, path: &str, content: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push(path.to_string());
        self.set_file(path, &String::from_utf8_lossy(content));
        Ok(())
    }
    async fn download(&self, _: &str, _: &str) -> Result<Vec<u8>> {
        Ok(vec![])
    }
    async fn capacity(&self) -> Result<Option<(u32, f64)>> {
        Ok(*self.capacity.lock().unwrap())
    }
    async fn start_recording(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn stop_recording(&self, _: &str) -> Result<()> {
        Ok(())
    }
}
