//! Small IRC protocol support helpers.
//!
//! The long-lived connection loop stays in `lib.rs` for now, but parsing and
//! status-emission helpers live here so protocol details do not pile up around
//! Tauri command wiring.

use crate::config::ServerConfig;
use crate::models::{DccOffer, NetworkStatus};
use crate::text::fallback_nicks;
use irc::client::prelude::Config;
use tauri::{Emitter, Window};

const IRC_KEEPALIVE_PING_SECONDS: u32 = 600;
const IRC_KEEPALIVE_TIMEOUT_SECONDS: u32 = 300;

pub(crate) fn build_irc_config(
    server: &ServerConfig,
    global_nick: &str,
    global_alt_nick: Option<&str>,
    global_realname: &str,
) -> Config {
    let final_nick = server
        .nickname
        .clone()
        .unwrap_or_else(|| global_nick.to_string());

    Config {
        nickname: Some(final_nick.clone()),
        alt_nicks: fallback_nicks(&final_nick, global_alt_nick),
        username: Some(final_nick),
        realname: Some(global_realname.to_string()),
        server: Some(server.host.clone()),
        port: Some(server.port),
        use_tls: Some(should_use_tls(server)),
        channels: channel_buffers(&server.autojoin),
        // The current settings field stores the NickServ/services password, not
        // an IRC server PASS token. Hand it to the IRC crate as `nick_password`
        // so it identifies after registration instead of leaking it during the
        // socket handshake.
        password: None,
        nick_password: server
            .sasl_password
            .clone()
            .filter(|password| !password.trim().is_empty()),
        // IRC sockets can survive as stale file descriptors after Wi-Fi
        // changes or laptop sleep. Keep the probe interval conservative:
        // Libera already sends server PINGs, and an over-eager client timeout
        // can create false reconnects while macOS is waking or throttling idle
        // timers. This catches truly dead sockets without churning idlers.
        ping_time: Some(IRC_KEEPALIVE_PING_SECONDS),
        ping_timeout: Some(IRC_KEEPALIVE_TIMEOUT_SECONDS),
        ..Config::default()
    }
}

fn channel_buffers(buffers: &[String]) -> Vec<String> {
    buffers
        .iter()
        .filter(|buffer| buffer.starts_with('#') || buffer.starts_with('&'))
        .cloned()
        .collect()
}

fn should_use_tls(server: &ServerConfig) -> bool {
    server.use_ssl || server.port == 6697 || server.port == 7000
}

pub(crate) fn parse_dcc_send(server_id: &str, from_nick: &str, content: &str) -> Option<DccOffer> {
    let clean = content.trim_matches('\x01').trim();
    let rest = clean.strip_prefix("DCC SEND ")?;
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !current.is_empty() {
                    parts.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    if parts.len() < 3 {
        return None;
    }
    let port = parts[2].parse().ok()?;
    let size = parts.get(3).and_then(|v| v.parse().ok());
    Some(DccOffer {
        server_id: server_id.to_string(),
        from_nick: from_nick.to_string(),
        file_name: parts[0].clone(),
        host: parts[1].clone(),
        port,
        size,
    })
}

pub(crate) fn emit_network_status(
    window: &Window,
    server_id: &str,
    status: &str,
    message: String,
    retry_in: Option<u64>,
    attempt: Option<u32>,
) {
    let _ = window.emit(
        "network-status",
        NetworkStatus {
            server_id: server_id.to_string(),
            status: status.to_string(),
            message,
            retry_in,
            attempt,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_fixture() -> ServerConfig {
        ServerConfig {
            id: "libera".to_string(),
            name: "Libera.Chat".to_string(),
            host: "irc.libera.chat".to_string(),
            port: 6697,
            nickname: None,
            realname: None,
            use_ssl: false,
            autojoin: vec![
                "#rumblr".to_string(),
                "&ops".to_string(),
                "NickServ".to_string(),
            ],
            perform: vec![],
            sasl_password: None,
        }
    }

    #[test]
    fn build_irc_config_filters_autojoin_to_channel_buffers() {
        let config = build_irc_config(&server_fixture(), "holiday", None, "Rumblr User");

        assert_eq!(config.channels, vec!["#rumblr", "&ops"]);
    }

    #[test]
    fn build_irc_config_enables_tls_for_tls_ports_and_sets_keepalive() {
        let config = build_irc_config(
            &server_fixture(),
            "holiday",
            Some("holiday_"),
            "Rumblr User",
        );

        assert_eq!(config.use_tls, Some(true));
        assert_eq!(config.ping_time, Some(IRC_KEEPALIVE_PING_SECONDS));
        assert_eq!(config.ping_timeout, Some(IRC_KEEPALIVE_TIMEOUT_SECONDS));
        assert_eq!(
            config.alt_nicks.first().map(String::as_str),
            Some("holiday_")
        );
        assert!(config.alt_nicks.len() >= 3);
    }

    #[test]
    fn build_irc_config_uses_saved_password_for_nickserv_not_server_pass() {
        let mut server = server_fixture();
        server.sasl_password = Some("secret".to_string());

        let config = build_irc_config(&server, "holiday", None, "Rumblr User");

        assert_eq!(config.nick_password.as_deref(), Some("secret"));
        assert_eq!(config.password, None);
    }

    #[test]
    fn parse_dcc_send_handles_quoted_file_names() {
        let offer = parse_dcc_send(
            "libera",
            "xdccbot",
            "\x01DCC SEND \"big archive.zip\" 2130706433 5000 1024\x01",
        )
        .unwrap();

        assert_eq!(offer.server_id, "libera");
        assert_eq!(offer.from_nick, "xdccbot");
        assert_eq!(offer.file_name, "big archive.zip");
        assert_eq!(offer.host, "2130706433");
        assert_eq!(offer.port, 5000);
        assert_eq!(offer.size, Some(1024));
    }

    #[test]
    fn parse_dcc_send_accepts_unknown_size() {
        let offer =
            parse_dcc_send("libera", "bot", "\x01DCC SEND file.txt 127.0.0.1 7000\x01").unwrap();

        assert_eq!(offer.file_name, "file.txt");
        assert_eq!(offer.size, None);
    }
}
