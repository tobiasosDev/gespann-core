//! gespann's orchestrator: the job queue, sandboxes and every job step, apart from the UI.
//! See docs/orchestrator.md.

pub mod agent_auth;
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
    /// The sandbox providers; each user's jobs use one of them (`provider_for`).
    pub pool: sandbox::pool::Pool,
    pub ui: ui::Ui,
    pub cfg: config::Config,
    pub locks: Locks,
}

impl Ctx {
    /// The sandboxes of this user's projects and Codex sign-in; None when no provider serves them.
    pub fn provider_for(&self, user_id: i64) -> anyhow::Result<Option<&sandbox::pool::Provider>> {
        let login = self.db.user_login(user_id)?;
        Ok(self.pool.for_login(login.as_deref()))
    }

    /// `provider_for`, as an error when no provider serves the user.
    pub fn sandboxes_for(&self, user_id: i64) -> anyhow::Result<Arc<dyn sandbox::Sandboxes>> {
        self.provider_for(user_id)?
            .map(|p| p.sb.clone())
            .ok_or_else(|| anyhow::anyhow!("no sandbox provider serves this user on this instance (SANDBOX_PROVIDER, SANDBOX_PROVIDER_BY_USER)"))
    }
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
