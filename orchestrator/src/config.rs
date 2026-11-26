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

/// A sandbox service the orchestrator reaches over HTTP (`SANDBOX_PROVIDER=remote`, docs/remote-sandboxes.md).
#[derive(Debug, Clone, Default)]
pub struct RemoteConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub base_url: String,
    /// Where the UI's internal API answers; default `base_url`.
    pub ui_url: String,
    pub data_dir: String,
    pub db_path: String,
    pub session_secret: String,
    /// "docker", "ssh", "remote" or "" for none: everyone's provider, unless `sandbox_provider_by_user` names them.
    pub sandbox_provider: String,
    /// `SANDBOX_PROVIDER_BY_USER`: lower-case GitHub login → provider spec.
    pub sandbox_provider_by_user: Vec<(String, String)>,
    pub docker: DockerConfig,
    pub ssh: SshConfig,
    pub remote: RemoteConfig,
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
        let sandbox_provider = get("SANDBOX_PROVIDER").trim().to_string();
        if !["docker", "ssh", "remote", ""].contains(&sandbox_provider.as_str()) {
            bail!("SANDBOX_PROVIDER {sandbox_provider} is not docker, ssh or remote");
        }
        let sandbox_provider_by_user = by_user(&get("SANDBOX_PROVIDER_BY_USER"))?;
        let uses = |spec: &str| sandbox_provider == spec || sandbox_provider_by_user.iter().any(|(_, s)| s == spec);
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
        let remote = RemoteConfig { url: get("SANDBOX_REMOTE_URL").trim().trim_end_matches('/').to_string(), token: get("SANDBOX_REMOTE_TOKEN").trim().to_string() };
        if uses("docker") && docker.image.is_empty() {
            bail!("the docker sandbox provider needs SANDBOX_IMAGE");
        }
        if uses("docker") && !safe_path(&docker.home) {
            bail!("SANDBOX_HOME has to be an absolute path of letters, digits, . _ - and /");
        }
        if uses("ssh") && ssh.host.is_empty() {
            bail!("the ssh sandbox provider needs SSH_HOST");
        }
        if uses("remote") && !(remote.url.starts_with("https://") || remote.url.starts_with("http://")) {
            bail!("the remote sandbox provider needs SANDBOX_REMOTE_URL (http or https)");
        }
        if uses("remote") && remote.token.len() < 32 {
            bail!("the remote sandbox provider needs SANDBOX_REMOTE_TOKEN of at least 32 characters");
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
            sandbox_provider_by_user,
            docker,
            ssh,
            remote,
            max_parallel,
            gespann_ref: env("GESPANN_REF").unwrap_or_else(|| "main".into()),
            health_port,
            production,
        })
    }
}

/// `SANDBOX_PROVIDER_BY_USER`: `login=spec` pairs, comma-separated, e.g. `tobi=ssh,ops=docker`.
/// Logins match in any case.
fn by_user(raw: &str) -> Result<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for pair in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let Some((login, spec)) = pair.split_once('=') else { bail!("SANDBOX_PROVIDER_BY_USER: {pair} is not login=provider") };
        let (login, spec) = (login.trim().to_lowercase(), spec.trim().to_string());
        if login.is_empty() || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("SANDBOX_PROVIDER_BY_USER: {login:?} is not a GitHub login");
        }
        if !["docker", "ssh", "remote"].contains(&spec.as_str()) {
            bail!("SANDBOX_PROVIDER_BY_USER: {spec} for {login} is not docker, ssh or remote");
        }
        if out.iter().any(|(l, _)| *l == login) {
            bail!("SANDBOX_PROVIDER_BY_USER names {login} twice");
        }
        out.push((login, spec));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(vars: &[(&str, &str)]) -> Result<Config> {
        let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from(|k| vars.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
    }

    #[test]
    fn providers_by_user() {
        let token = "t".repeat(32);
        let c = cfg(&[("SANDBOX_PROVIDER", "remote"), ("SANDBOX_REMOTE_URL", "http://app:3000/sandboxes/"), ("SANDBOX_REMOTE_TOKEN", &token), ("SANDBOX_PROVIDER_BY_USER", " TobiasosDev=ssh , ops=ssh"), ("SSH_HOST", "ci@ci")]).unwrap();
        assert_eq!(c.sandbox_provider, "remote");
        assert_eq!(c.sandbox_provider_by_user, vec![("tobiasosdev".to_string(), "ssh".to_string()), ("ops".to_string(), "ssh".to_string())]);
        assert_eq!(c.remote.url, "http://app:3000/sandboxes");
    }

    #[test]
    fn each_used_provider_needs_its_settings() {
        let e = cfg(&[("SANDBOX_PROVIDER", "remote"), ("SANDBOX_REMOTE_URL", "http://x"), ("SANDBOX_REMOTE_TOKEN", &"t".repeat(32)), ("SANDBOX_PROVIDER_BY_USER", "tobi=ssh")]).unwrap_err();
        assert!(e.to_string().contains("SSH_HOST"), "{e}");
        let e = cfg(&[("SANDBOX_PROVIDER", "ssh"), ("SSH_HOST", "ci@ci"), ("SANDBOX_PROVIDER_BY_USER", "ops=remote")]).unwrap_err();
        assert!(e.to_string().contains("SANDBOX_REMOTE_URL"), "{e}");
        let e = cfg(&[("SANDBOX_PROVIDER", "remote"), ("SANDBOX_REMOTE_URL", "http://x"), ("SANDBOX_REMOTE_TOKEN", "short")]).unwrap_err();
        assert!(e.to_string().contains("SANDBOX_REMOTE_TOKEN"), "{e}");
        assert!(cfg(&[("SANDBOX_PROVIDER_BY_USER", "tobi=boat")]).is_err());
        assert!(cfg(&[("SANDBOX_PROVIDER_BY_USER", "tobi=ssh,TOBI=ssh"), ("SSH_HOST", "h")]).is_err());
        assert!(cfg(&[("SANDBOX_PROVIDER_BY_USER", "tobi")]).is_err());
    }
}
