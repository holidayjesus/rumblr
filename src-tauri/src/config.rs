//! Persistent application configuration.
//!
//! This module owns the JSON shape stored in the app config directory. The rest
//! of the backend should treat `AppConfig` as the single source of truth for
//! networks, identity, reconnect policy, display preferences, and notification
//! defaults.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct NotificationRules {
    #[serde(default = "default_notification_mode")]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) quiet_hours: bool,
    #[serde(default = "default_quiet_start")]
    pub(crate) quiet_start: String,
    #[serde(default = "default_quiet_end")]
    pub(crate) quiet_end: String,
    #[serde(default = "default_true")]
    pub(crate) popup_alerts: bool,
    #[serde(default)]
    pub(crate) muted_buffers: HashMap<String, bool>,
}

fn default_notification_mode() -> String {
    "dms".to_string()
}

fn default_quiet_start() -> String {
    "22:00".to_string()
}

fn default_quiet_end() -> String {
    "08:00".to_string()
}

impl Default for NotificationRules {
    fn default() -> Self {
        NotificationRules {
            mode: default_notification_mode(),
            quiet_hours: false,
            quiet_start: default_quiet_start(),
            quiet_end: default_quiet_end(),
            popup_alerts: true,
            muted_buffers: HashMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ServerConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    #[serde(default)]
    pub(crate) nickname: Option<String>,
    #[serde(default)]
    pub(crate) realname: Option<String>,
    #[serde(default = "default_true", alias = "ssl")]
    pub(crate) use_ssl: bool,
    #[serde(default)]
    pub(crate) autojoin: Vec<String>,
    #[serde(default)]
    pub(crate) perform: Vec<String>,
    #[serde(default)]
    pub(crate) sasl_password: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct DisplayConfig {
    #[serde(default = "default_12h")]
    pub(crate) timestamp_format: String,
    #[serde(default = "default_false")]
    pub(crate) show_avatars: bool,
    #[serde(default = "default_false")]
    pub(crate) show_system_messages: bool,
    #[serde(default = "default_false")]
    pub(crate) show_join_part: bool,
    #[serde(default = "default_false")]
    pub(crate) media_shader_visualizer: bool,
}

fn default_12h() -> String {
    "12h".to_string()
}

fn default_false() -> bool {
    false
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct ProfileConfig {
    #[serde(default)]
    pub(crate) avatar_data_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct AppConfig {
    #[serde(default)]
    pub(crate) servers: Vec<ServerConfig>,
    #[serde(default = "default_nick")]
    pub(crate) global_nickname: String,
    #[serde(default)]
    pub(crate) global_alt_nickname: Option<String>,
    #[serde(default = "default_realname")]
    pub(crate) global_realname: String,
    #[serde(default = "default_true")]
    pub(crate) auto_reconnect: bool,
    #[serde(default = "default_true")]
    pub(crate) notifications_enabled: bool,
    #[serde(default)]
    pub(crate) notification_rules: NotificationRules,
    #[serde(default)]
    pub(crate) theme: String,
    #[serde(default = "default_max_messages")]
    pub(crate) max_messages: usize,
    #[serde(default = "default_true")]
    pub(crate) gpu_accel: bool,
    #[serde(default = "default_true")]
    pub(crate) rich_previews: bool,
    #[serde(default)]
    pub(crate) multi_network: bool,
    #[serde(default)]
    pub(crate) auto_connect: bool,
    #[serde(default = "default_display")]
    pub(crate) display: DisplayConfig,
    #[serde(default)]
    pub(crate) profile: ProfileConfig,
}

fn default_display() -> DisplayConfig {
    DisplayConfig {
        timestamp_format: "12h".to_string(),
        show_avatars: false,
        show_system_messages: false,
        show_join_part: false,
        media_shader_visualizer: false,
    }
}

fn default_max_messages() -> usize {
    500
}

fn default_nick() -> String {
    "RumblrUser".to_string()
}

fn default_realname() -> String {
    "Rumblr Workstation User".to_string()
}

impl AppConfig {
    pub(crate) fn load(app: &AppHandle) -> Self {
        let mut path = app.path().app_config_dir().unwrap_or_default();
        path.push("config.json");
        let config = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(AppConfig::default)
        } else {
            AppConfig::default()
        };

        config.normalized_for_runtime()
    }

    pub(crate) fn normalized_for_runtime(mut self) -> Self {
        if !matches!(
            self.notification_rules.mode.as_str(),
            "all" | "mentions" | "dms" | "off"
        ) {
            self.notification_rules.mode = default_notification_mode();
        }

        if !matches!(
            self.display.timestamp_format.as_str(),
            "24h" | "seconds24" | "12h" | "hidden"
        ) {
            self.display.timestamp_format = "24h".to_string();
        }

        self.max_messages = self.max_messages.clamp(50, 50_000);

        for server in &mut self.servers {
            if server.id == "libera"
                && server.host == "irc.libera.chat"
                && server.port == 6667
                && !server.use_ssl
            {
                // A previous frontend migration pushed Libera back to plain
                // 6667. Upgrade that persisted shape before the connection
                // task builds its IRC config, so old dev configs recover.
                server.port = 6697;
                server.use_ssl = true;
            }
        }

        self
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            servers: vec![ServerConfig {
                id: "libera".to_string(),
                name: "Libera.Chat".to_string(),
                host: "irc.libera.chat".to_string(),
                port: 6697,
                nickname: None,
                realname: None,
                use_ssl: true,
                autojoin: vec!["#rumblr".to_string()],
                perform: vec![],
                sasl_password: None,
            }],
            global_nickname: default_nick(),
            global_alt_nickname: None,
            global_realname: default_realname(),
            auto_reconnect: true,
            notifications_enabled: true,
            notification_rules: NotificationRules::default(),
            theme: "carbon".to_string(),
            max_messages: 500,
            gpu_accel: true,
            rich_previews: true,
            multi_network: false,
            auto_connect: false,
            display: default_display(),
            profile: ProfileConfig::default(),
        }
    }
}

pub(crate) async fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    path.push("config.json");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_for_runtime_upgrades_legacy_libera_plaintext_config() {
        let mut config = AppConfig::default();
        config.servers[0].port = 6667;
        config.servers[0].use_ssl = false;

        let normalized = config.normalized_for_runtime();

        assert_eq!(normalized.servers[0].port, 6697);
        assert!(normalized.servers[0].use_ssl);
    }

    #[test]
    fn normalized_for_runtime_preserves_popup_alert_preference() {
        let mut config = AppConfig::default();
        config.notification_rules.popup_alerts = false;

        let normalized = config.normalized_for_runtime();

        assert!(!normalized.notification_rules.popup_alerts);
    }

    #[test]
    fn normalized_for_runtime_repairs_unknown_settings_values() {
        let mut config = AppConfig::default();
        config.notification_rules.mode = "everything-loud".to_string();
        config.display.timestamp_format = "epoch-beats".to_string();
        config.max_messages = 1;

        let normalized = config.normalized_for_runtime();

        assert_eq!(normalized.notification_rules.mode, "dms");
        assert_eq!(normalized.display.timestamp_format, "24h");
        assert_eq!(normalized.max_messages, 50);
    }
}
