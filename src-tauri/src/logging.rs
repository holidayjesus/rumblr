//! File and webview logging helpers.
//!
//! IRC clients need durable local logs, but those logs should be conservative:
//! path components are sanitized, credentials are redacted, and log files are
//! created private to the current user on Unix platforms.

use crate::text::{redact_sensitive_text, sanitize_log_text};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Window};

const MAX_LOG_LINE_CHARS: usize = 4_096;

pub(crate) async fn log_path(
    app: &AppHandle,
    server: &str,
    channel: &str,
) -> Result<PathBuf, String> {
    let mut path = app.path().app_log_dir().map_err(|e| e.to_string())?;
    path.push(safe_log_component(server));
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    path.push(format!("{}.log", safe_log_component(channel)));
    Ok(path)
}

pub(crate) async fn append_to_log(
    app: &AppHandle,
    server: &str,
    channel: &str,
    nick: &str,
    msg: &str,
) {
    if let Ok(path) = log_path(app, server, channel).await {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let clean_nick = sanitize_log_text(nick, 128);
        let clean_msg = sanitize_log_text(&redact_sensitive_text(msg), MAX_LOG_LINE_CHARS);
        let line = format!("[{}] <{}> {}\n", timestamp, clean_nick, clean_msg);
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

pub(crate) async fn emit_log(window: &Window, msg: &str) {
    let _ = window.emit("debug-log", redact_sensitive_text(msg));
}

fn safe_log_component(input: &str) -> String {
    let sanitized: String = input
        .chars()
        .filter_map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => Some(c),
            '#' | '&' => None,
            _ => Some('_'),
        })
        .take(80)
        .collect();
    if sanitized.is_empty() {
        "buffer".to_string()
    } else {
        sanitized
    }
}
