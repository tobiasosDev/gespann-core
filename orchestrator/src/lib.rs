//! gespann's orchestrator: the job queue, sandboxes and every job step, apart from the UI.
//! See docs/orchestrator.md.

pub mod codex;
pub mod config;
pub mod db;
pub mod jobs;
pub mod journal;
pub mod sandbox;
pub mod ui;
pub mod verify;
pub mod worker;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::OwnedMutexGuard;

/// Everything a job needs.
pub struct Ctx {
    pub db: db::Db,
    pub sb: Arc<dyn sandbox::Sandboxes>,
    pub ui: ui::Ui,
    pub cfg: config::Config,
    pub locks: Locks,
}

/// In-process locks by name and id (a project's first recipe, a recovery, a repair, a Codex refresh).
/// One orchestrator runs at a time.
#[derive(Default)]
pub struct Locks {
    map: Mutex<HashMap<(String, i64), LockCell>>,
}

type LockCell = Arc<tokio::sync::Mutex<()>>;

impl Locks {
    /// Waits for earlier holders of `(name, key)`, then holds it until the guard drops.
    pub async fn lock(&self, name: &str, key: i64) -> OwnedMutexGuard<()> {
        let m = {
            let mut map = self.map.lock().expect("locks");
            map.entry((name.to_string(), key)).or_default().clone()
        };
        m.lock_owned().await
    }

    /// True while someone holds `(name, key)`.
    pub fn held(&self, name: &str, key: i64) -> bool {
        let map = self.map.lock().expect("locks");
        map.get(&(name.to_string(), key)).is_some_and(|m| m.try_lock().is_err())
    }
}

/// One JSON log line to stdout, as the TypeScript server logs.
pub fn log(level: &str, message: &str) {
    println!("{}", serde_json::json!({ "level": level, "message": message }));
}
