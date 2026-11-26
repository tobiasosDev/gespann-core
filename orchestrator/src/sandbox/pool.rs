//! The instance's sandbox providers and who gets which: `SANDBOX_PROVIDER` for everyone,
//! `SANDBOX_PROVIDER_BY_USER` for the GitHub logins it names. Each provider is made once and runs its
//! own number of jobs at once, so a full one never holds up the users of another.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::{from_spec, Sandboxes};
use crate::config::Config;
use crate::worker::{parallel_jobs, Parallel};

pub struct Provider {
    /// What configured it: "docker", "ssh" or "remote".
    pub spec: String,
    pub sb: Arc<dyn Sandboxes>,
    pub parallel: Parallel,
    /// Lower-case logins `SANDBOX_PROVIDER_BY_USER` gives this provider.
    pub logins: Vec<String>,
    /// `SANDBOX_PROVIDER`: everyone not named gets it.
    pub default: bool,
}

impl Provider {
    /// For the log: whom it serves, e.g. "tobi, ops" or "everyone else".
    pub fn serves(&self, named: bool) -> String {
        let mut who = self.logins.clone();
        if self.default {
            who.push(if named { "everyone else" } else { "everyone" }.into());
        }
        who.join(", ")
    }
}

pub struct Pool {
    providers: Vec<Provider>,
}

impl Pool {
    pub fn new(providers: Vec<Provider>) -> Pool {
        Pool { providers }
    }

    /// One provider for everyone (tests, and instances with a single provider).
    pub fn single(sb: Arc<dyn Sandboxes>, parallel: Parallel) -> Pool {
        Pool { providers: vec![Provider { spec: sb.kind().to_string(), sb, parallel, logins: Vec::new(), default: true }] }
    }

    /// Makes every provider the config names, once however many users share it, and reads its size.
    pub async fn from_config(cfg: &Config) -> Result<Pool> {
        let mut specs: Vec<&str> = Vec::new();
        for spec in std::iter::once(cfg.sandbox_provider.as_str()).chain(cfg.sandbox_provider_by_user.iter().map(|(_, s)| s.as_str())) {
            if !spec.is_empty() && !specs.contains(&spec) {
                specs.push(spec);
            }
        }
        let mut providers = Vec::new();
        for spec in specs {
            let sb = from_spec(cfg, spec).await?.ok_or_else(|| anyhow!("no sandbox provider {spec}"))?;
            let parallel = parallel_jobs(cfg.max_parallel, sb.as_ref()).await;
            let logins = cfg.sandbox_provider_by_user.iter().filter(|(_, s)| s == spec).map(|(l, _)| l.clone()).collect();
            providers.push(Provider { spec: spec.to_string(), sb, parallel, logins, default: spec == cfg.sandbox_provider });
        }
        Ok(Pool { providers })
    }

    pub fn providers(&self) -> &[Provider] {
        &self.providers
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// True when some login has a provider of its own.
    pub fn named(&self) -> bool {
        self.providers.iter().any(|p| !p.logins.is_empty())
    }

    /// The provider (by index) for this user's sandboxes, or None when they have none: their jobs stay queued.
    pub fn index_for(&self, login: Option<&str>) -> Option<usize> {
        let login = login.map(str::to_lowercase);
        if let Some(l) = &login {
            if let Some(i) = self.providers.iter().position(|p| p.logins.contains(l)) {
                return Some(i);
            }
        }
        self.providers.iter().position(|p| p.default)
    }

    pub fn get(&self, i: usize) -> &Provider {
        &self.providers[i]
    }

    pub fn for_login(&self, login: Option<&str>) -> Option<&Provider> {
        self.index_for(login).map(|i| self.get(i))
    }
}
