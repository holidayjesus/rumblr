//! Outbound IRC message sending.
//!
//! Frontend commands all arrive through one Tauri command, but they are not all
//! sent the same way: slash commands in channel/system context become raw IRC
//! commands, while normal text becomes `PRIVMSG` and is logged locally.

use crate::logging::append_to_log;
use crate::text::{redact_command_for_log, redact_sensitive_text, truncate_text};
use irc::client::prelude::Client;
use std::sync::Arc;
use tauri::AppHandle;

pub(crate) async fn send_irc_message_impl(
    app: &AppHandle,
    client: &Arc<Client>,
    server_id: &str,
    channel: &str,
    content: &str,
) -> Result<(), String> {
    let is_channel_target = channel.starts_with('#') || channel.starts_with('&');
    let is_command_context = is_channel_target || channel == "system";
    if is_command_context && content.starts_with('/') && !content.starts_with("//") {
        let parts: Vec<&str> = content[1..].splitn(2, ' ').collect();
        let final_cmd = if parts.len() > 1 {
            format!("{} {}", parts[0].to_uppercase(), parts[1])
        } else {
            parts[0].to_uppercase()
        };
        println!(
            "[IRC] Sending command to {}: {}",
            server_id,
            redact_command_for_log(&final_cmd)
        );
        client.send(final_cmd.as_str()).map_err(|e| e.to_string())
    } else {
        println!(
            "[IRC] Sending PRIVMSG to {}/{}: {}",
            server_id,
            channel,
            truncate_text(&redact_sensitive_text(content), 512)
        );
        append_to_log(app, server_id, channel, "Me", content).await;
        client
            .send_privmsg(channel, content)
            .map_err(|e| e.to_string())
    }
}

pub(crate) fn typing_tagmsg_command(channel: &str, typing_state: &str) -> Result<String, String> {
    let target = channel.trim();
    if target.is_empty()
        || target
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '\r' | '\n' | '\0' | ':' | ','))
    {
        return Err("Invalid typing target".to_string());
    }

    let state = match typing_state.trim().to_ascii_lowercase().as_str() {
        "active" => "active",
        "paused" => "paused",
        "done" => "done",
        _ => return Err("Invalid typing state".to_string()),
    };

    Ok(format!("@+typing={} TAGMSG {}", state, target))
}

pub(crate) async fn send_typing_state_impl(
    client: &Arc<Client>,
    channel: &str,
    typing_state: &str,
) -> Result<(), String> {
    // IRCv3 typing indicators are client-only message tags on TAGMSG. They are
    // intentionally separate from PRIVMSG so typing state never reaches logs or
    // persistent message history.
    let command = typing_tagmsg_command(channel, typing_state)?;
    client.send(command.as_str()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_tagmsg_command_allows_only_known_states_and_safe_targets() {
        assert_eq!(
            typing_tagmsg_command("#rumblr", "active").unwrap(),
            "@+typing=active TAGMSG #rumblr"
        );
        assert_eq!(
            typing_tagmsg_command("NickServ", "DONE").unwrap(),
            "@+typing=done TAGMSG NickServ"
        );
        assert!(typing_tagmsg_command("#rumblr", "thinking").is_err());
        assert!(typing_tagmsg_command("#rumblr\r\nJOIN #bad", "active").is_err());
        assert!(typing_tagmsg_command("", "active").is_err());
    }
}
