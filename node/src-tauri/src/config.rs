use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

const CONFIG_SCHEMA: &str = "mere.run.node.config.v1";

fn default_relay_url() -> String {
    "wss://relay.mere.run/agent".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePreferences {
    #[serde(default = "default_schema")]
    pub schema: String,
    #[serde(default = "default_relay_url")]
    pub relay_url: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub installed_models: Vec<String>,
    #[serde(default)]
    pub launch_at_login: bool,
}

fn default_schema() -> String {
    CONFIG_SCHEMA.to_string()
}

impl Default for NodePreferences {
    fn default() -> Self {
        Self {
            schema: default_schema(),
            relay_url: default_relay_url(),
            device_name: String::new(),
            models: Vec::new(),
            installed_models: Vec::new(),
            launch_at_login: false,
        }
    }
}

pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| error.to_string())
}

pub fn preferences_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("node-config.json"))
}

pub fn remove_legacy_direct_executor_state<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let root = config_dir(app)?;
    let credential = root.join("animatic-executor-credentials.json");
    if credential.is_file() {
        std::fs::remove_file(credential).map_err(|error| error.to_string())?;
    }
    let runtime = root.join("runtime");
    if runtime.is_dir() {
        std::fs::remove_dir_all(runtime).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn load_preferences<R: Runtime>(app: &AppHandle<R>) -> NodePreferences {
    let Ok(path) = preferences_path(app) else {
        return NodePreferences::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return NodePreferences::default();
    };
    let Ok(mut config) = serde_json::from_slice::<NodePreferences>(&bytes) else {
        return NodePreferences::default();
    };
    if config.schema != CONFIG_SCHEMA {
        return NodePreferences::default();
    }
    normalize(&mut config);
    config
}

pub fn save_preferences<R: Runtime>(
    app: &AppHandle<R>,
    mut config: NodePreferences,
) -> Result<NodePreferences, String> {
    config.schema = default_schema();
    normalize(&mut config);
    validate_url(&config.relay_url, &["ws", "wss"], "Relay")?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    atomic_write_private(&preferences_path(app)?, &bytes).map_err(|error| error.to_string())?;
    Ok(config)
}

fn normalize(config: &mut NodePreferences) {
    config.relay_url = config.relay_url.trim().trim_end_matches('/').to_string();
    config.device_name = config.device_name.trim().to_string();
    config.models = normalized_strings(&config.models);
    config.installed_models = normalized_strings(&config.installed_models);
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut result = values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}

fn validate_url(value: &str, schemes: &[&str], label: &str) -> Result<(), String> {
    let scheme = value.split_once("://").map(|(scheme, _)| scheme);
    if value.is_empty() || !scheme.is_some_and(|scheme| schemes.contains(&scheme)) {
        return Err(format!("{label} URL must use {}", schemes.join(" or ")));
    }
    Ok(())
}

pub fn atomic_write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary = path.with_extension(format!("tmp-{}-{suffix}", std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_writes_are_mode_0600() {
        let path = std::env::temp_dir().join(format!(
            "mere-run-node-config-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        atomic_write_private(&path, b"secret").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_file(path).expect("cleanup");
    }
}
