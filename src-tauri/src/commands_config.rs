//! Config and workstation-state command helpers.
//!
//! These functions perform the file-system work behind the Tauri commands in
//! `lib.rs`. Keeping them here makes it clear which operations mutate persisted
//! config and which only validate/export it.

use crate::config::{config_path, AppConfig};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

pub(crate) async fn load_config_file(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app).await?;
    if !path.exists() {
        let default_cfg = AppConfig::default();
        let content = serde_json::to_string_pretty(&default_cfg).map_err(|e| e.to_string())?;
        fs::write(&path, content).map_err(|e| e.to_string())?;
        return Ok(default_cfg);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(config.normalized_for_runtime())
}

pub(crate) async fn save_config_file(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app).await?;
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

pub(crate) fn cancel_orphaned_connections(
    config: &AppConfig,
    tokens: &mut std::collections::HashMap<String, CancellationToken>,
) {
    let valid_ids: std::collections::HashSet<String> =
        config.servers.iter().map(|s| s.id.clone()).collect();
    let orphaned_ids: Vec<String> = tokens
        .keys()
        .filter(|id| !valid_ids.contains(*id))
        .cloned()
        .collect();

    for id in orphaned_ids {
        if let Some(token) = tokens.remove(&id) {
            token.cancel();
        }
    }
}

pub(crate) async fn open_log_dir_impl(app: &AppHandle) -> Result<(), String> {
    let path = app.path().app_log_dir().map_err(|e| e.to_string())?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(path).spawn();
    Ok(())
}

pub(crate) async fn export_workstation_state_impl(app: &AppHandle) -> Result<String, String> {
    let mut config = AppConfig::load(app);
    for server in &mut config.servers {
        server.sasl_password = None;
    }
    let mut path = app.path().desktop_dir().map_err(|e| e.to_string())?;
    path.push("rumblr_configuration_backup.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

pub(crate) async fn import_workstation_state_impl(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app.path().desktop_dir().map_err(|e| e.to_string())?;
    path.push("rumblr_configuration_backup.json");
    if !path.exists() {
        return Err(
            "Backup file not found on Desktop (rumblr_configuration_backup.json)".to_string(),
        );
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let _config: AppConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let destination = config_path(app).await?;
    fs::write(&destination, content).map_err(|e| e.to_string())?;
    Ok(destination)
}
