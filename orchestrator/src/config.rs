//! The orchestrator's settings, from the same environment variables as `gespann serve`
//! (`src/server/config.ts`), plus `UI_URL` and `HEALTH_PORT`.

use anyhow::{bail, Result};

use crate::sandbox::scripts::{safe_path, words};

#[derive(Debug, Clone, Default)]
pub struct DockerConfig {
    pub image: String,
    pub args: Vec<String>,
    pub command: Vec<String>,
    pub user: String,
    pub home: String,
}

#[derive(Debug, Clone, Default)]
pub struct SshConfig {
    pub host: String,
    pub port: String,
    pub key_file: String,
    /// The private key itself (`SSH_PRIVATE_KEY`), written to a file under DATA_DIR/ssh at startup.
    pub key: String,
    pub known_hosts: String,
    pub root: String,
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub base_url: String,
    /// Where the UI's internal API answers; default `base_url`.
    pub ui_url: String,
    pub data_dir: String,
    pub db_path: String,
    pub session_secret: String,
    /// "docker", "ssh" or "" for none.
    pub sandbox_provider: String,
    pub docker: DockerConfig,
    pub ssh: SshConfig,
    pub max_parallel: Option<u32>,
    pub gespann_ref: String,
    pub health_port: u16,
    pub production: bool,
}

impl Config {
    pub fn from_env() -> Result<Config> {
        Self::from(|k| std::env::var(k).ok())
    }

    pub fn from(env: impl Fn(&str) -> Option<String>) -> Result<Config> {
        let get = |k: &str| env(k).unwrap_or_default();
        let production = get("NODE_ENV") == "production";
        let data_dir = env("DATA_DIR").unwrap_or_else(|| if production { "/data".into() } else { ".data".into() });
        let base_url = env("BASE_URL").unwrap_or_else(|| "http://localhost:3000".into()).trim_end_matches('/').to_string();
        let session_secret = env("SESSION_SECRET").unwrap_or_else(|| if production { String::new() } else { "dev-only-session-secret".into() });
        if production && (!base_url.starts_with("https://") || session_secret.len() < 32) {
            bail!("production needs an https BASE_URL and a SESSION_SECRET of at least 32 characters");
        }
        let sandbox_provider = get("SANDBOX_PROVIDER");
        if !get("SANDBOX_PROVIDER_BY_USER").trim().is_empty() {
            bail!("SANDBOX_PROVIDER_BY_USER is not supported: one SANDBOX_PROVIDER serves every user");
        }
        if !["docker", "ssh", ""].contains(&sandbox_provider.as_str()) {
            bail!("SANDBOX_PROVIDER {sandbox_provider} is not docker or ssh");
        }
        let docker = DockerConfig {
            image: get("SANDBOX_IMAGE"),
            args: words(&get("SANDBOX_DOCKER_ARGS"))?,
            command: words(&get("SANDBOX_COMMAND"))?,
            user: get("SANDBOX_USER"),
            home: env("SANDBOX_HOME").unwrap_or_else(|| "/home/user".into()),
        };
        let ssh = SshConfig {
            host: get("SSH_HOST"),
            port: get("SSH_PORT"),
            key_file: get("SSH_KEY_FILE"),
            key: get("SSH_PRIVATE_KEY").replace("\\n", "\n"),
            known_hosts: get("SSH_KNOWN_HOSTS").replace("\\n", "\n"),
            root: env("SANDBOX_ROOT").unwrap_or_else(|| "~/gespann-sandboxes".into()),
        };
        if sandbox_provider == "docker" && docker.image.is_empty() {
            bail!("SANDBOX_PROVIDER=docker needs SANDBOX_IMAGE");
        }
        if sandbox_provider == "docker" && !safe_path(&docker.home) {
            bail!("SANDBOX_HOME has to be an absolute path of letters, digits, . _ - and /");
        }
        if sandbox_provider == "ssh" && ssh.host.is_empty() {
            bail!("SANDBOX_PROVIDER=ssh needs SSH_HOST");
        }
        let max = get("MAX_PARALLEL_JOBS").trim().to_string();
        let max_parallel = if max.is_empty() {
            None
        } else {
            match max.parse::<u32>() {
                Ok(n) if (1..=999).contains(&n) => Some(n),
                _ => bail!("MAX_PARALLEL_JOBS {max} is not a whole number from 1 to 999"),
            }
        };
        let health_port = match env("HEALTH_PORT") {
            Some(p) => p.parse().map_err(|_| anyhow::anyhow!("HEALTH_PORT {p} is not a port"))?,
            None => 3001,
        };
        Ok(Config {
            ui_url: env("UI_URL").map(|u| u.trim_end_matches('/').to_string()).unwrap_or_else(|| base_url.clone()),
            db_path: env("DATABASE_PATH").unwrap_or_else(|| format!("{data_dir}/gespann.sqlite")),
            base_url,
            data_dir,
            session_secret,
            sandbox_provider,
            docker,
            ssh,
            max_parallel,
            gespann_ref: env("GESPANN_REF").unwrap_or_else(|| "main".into()),
            health_port,
            production,
        })
    }
}
