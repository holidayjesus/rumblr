//! Backend IRC event builders.
//!
//! The connection loop should decide *when* an IRC event happened, but the
//! serializable shapes and timestamp formatting live here. This keeps message
//! creation consistent across channel text, notices, server replies, and local
//! system events.

use crate::models::{IrcMessage, UserEvent};
use chrono::{SecondsFormat, Utc};

pub(crate) fn irc_message(
    server_id: &str,
    channel: impl Into<String>,
    username: impl Into<String>,
    content: impl Into<String>,
    msg_type: impl Into<String>,
) -> IrcMessage {
    let channel = channel.into();
    let username = username.into();
    let content = content.into();
    let msg_type = msg_type.into();
    let received_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    // Stable backend ids let multiple webviews merge the same IRC event without
    // duplicate rows when the Messages Hub receives both live and snapshot sync.
    let id = format!("{server_id}:{channel}:{username}:{msg_type}:{received_at}");
    IrcMessage {
        id,
        username,
        content,
        timestamp: chrono::Local::now().format("%H:%M").to_string(),
        received_at,
        channel,
        server_id: server_id.to_string(),
        msg_type,
    }
}

pub(crate) fn system_message(
    server_id: &str,
    channel: impl Into<String>,
    content: impl Into<String>,
) -> IrcMessage {
    irc_message(server_id, channel, "System", content, "system")
}

pub(crate) fn user_event(
    server_id: &str,
    channel: impl Into<String>,
    username: impl Into<String>,
    event_type: impl Into<String>,
    new_nick: Option<String>,
) -> UserEvent {
    UserEvent {
        server_id: server_id.to_string(),
        channel: channel.into(),
        username: username.into(),
        event_type: event_type.into(),
        new_nick,
    }
}

pub(crate) fn server_buffer(server_id: &str) -> String {
    format!("*{server_id}")
}

pub(crate) fn is_channel_buffer(name: &str) -> bool {
    name.starts_with('#') || name.starts_with('&')
}
