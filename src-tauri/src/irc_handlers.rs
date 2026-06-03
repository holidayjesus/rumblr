//! IRC command handlers.
//!
//! The connection task owns socket lifetime, retries, and cancellation. This
//! module owns the "what does this IRC command mean to Rumblr?" layer, which
//! keeps protocol behavior auditable without turning the connection loop into a
//! monolith.

use crate::config::ServerConfig;
use crate::irc_events::{
    irc_message, is_channel_buffer, server_buffer, system_message, user_event,
};
use crate::irc_numeric::display_message_for_numeric;
use crate::irc_support::{emit_network_status, parse_dcc_send};
use crate::logging::append_to_log;
use crate::models::{ChannelInfo, ChannelListStatus, TypingUpdate, UserListUpdate};
use crate::text::{clean_irc_display_text, redact_sensitive_text, truncate_text};
use chrono::Utc;
use irc::client::prelude::*;
use irc::proto::message::Tag;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Window};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

const MAX_NOTIFICATION_BODY_CHARS: usize = 512;

pub(crate) struct IrcCommandContext<'a> {
    pub(crate) app: &'a AppHandle,
    pub(crate) window: &'a Window,
    pub(crate) client: &'a Arc<Client>,
    pub(crate) server_id: &'a str,
    pub(crate) server: &'a ServerConfig,
    pub(crate) presence: &'a Arc<Mutex<String>>,
    pub(crate) notifications_enabled: bool,
}

pub(crate) async fn handle_irc_command(
    ctx: &IrcCommandContext<'_>,
    msg: Message,
    registered: &mut bool,
    ran_perform: &mut bool,
) {
    let raw = msg.to_string();
    let username = msg.source_nickname().unwrap_or("system").to_string();
    let tags = msg.tags.clone();

    match msg.command {
        Command::PRIVMSG(target, content) => {
            handle_privmsg(ctx, username, target, content).await;
        }
        Command::NOTICE(target, content) => {
            handle_notice(ctx, username, target, content).await;
        }
        Command::CAP(_, subcommand, _, capability) => {
            let _ = ctx.window.emit(
                "debug-log",
                format!(
                    "[CAP] {} {}",
                    subcommand.to_str(),
                    capability.unwrap_or_default()
                ),
            );
        }
        Command::Response(Response::RPL_NAMREPLY, params) => {
            if params.len() >= 4 {
                let _ = ctx.window.emit(
                    "user-list-item",
                    UserListUpdate {
                        server_id: ctx.server_id.to_string(),
                        channel: params[2].clone(),
                        users: params[3]
                            .split_whitespace()
                            .map(|user| user.to_string())
                            .collect(),
                    },
                );
            }
        }
        Command::Response(Response::RPL_ENDOFNAMES, params) => {
            if params.len() >= 2 {
                let _ = ctx.window.emit(
                    "user-list-end",
                    UserListUpdate {
                        server_id: ctx.server_id.to_string(),
                        channel: params[1].clone(),
                        users: vec![],
                    },
                );
            }
        }
        Command::JOIN(channel, _, _) => {
            let _ = ctx.app.emit(
                "user-event",
                user_event(
                    ctx.server_id,
                    channel.clone(),
                    username.clone(),
                    "JOIN",
                    None,
                ),
            );
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    channel.clone(),
                    "System",
                    format!("{} joined {}", username, channel),
                    "system",
                ),
            );
            if username == ctx.client.current_nickname() {
                let _ = ctx.client.send(format!("NAMES {}", channel).as_str());
            }
        }
        Command::PART(channel, reason) => {
            let reason = reason.unwrap_or_else(|| "No reason".to_string());
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    channel.clone(),
                    "System",
                    format!("{} left ({})", username, reason),
                    "system",
                ),
            );
            let _ = ctx.app.emit(
                "user-event",
                user_event(ctx.server_id, channel, username, "PART", None),
            );
        }
        Command::QUIT(reason) => {
            let reason = reason.unwrap_or_else(|| "No reason".to_string());
            let _ = ctx.window.emit(
                "debug-log",
                format!("[QUIT] {} left ({})", username, reason),
            );
            let _ = ctx.app.emit(
                "user-event",
                user_event(ctx.server_id, "", username, "QUIT", None),
            );
        }
        Command::KICK(channel, target, reason) => {
            let reason = reason.unwrap_or_else(|| "No reason".to_string());
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    channel.clone(),
                    "System",
                    format!("{} was kicked by {} ({})", target, username, reason),
                    "system",
                ),
            );
            let _ = ctx.app.emit(
                "user-event",
                user_event(ctx.server_id, channel, target, "PART", None),
            );
        }
        Command::INVITE(invitee, channel) => {
            let _ = ctx.app.emit(
                "irc-message",
                system_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    invite_message(&username, &invitee, &channel),
                ),
            );
        }
        Command::ChannelMODE(channel, modes) => {
            if !modes.is_empty() {
                let mode_text = modes
                    .iter()
                    .map(|mode| mode.to_string())
                    .collect::<Vec<_>>()
                    .join(" ");
                let _ = ctx.app.emit(
                    "irc-message",
                    irc_message(
                        ctx.server_id,
                        channel.clone(),
                        "Mode",
                        format!("{} set mode {}", username, mode_text),
                        "system",
                    ),
                );
                let _ = ctx.client.send(format!("NAMES {}", channel).as_str());
            }
        }
        Command::TOPIC(channel, topic) => {
            let topic = topic
                .as_deref()
                .map(clean_irc_display_text)
                .unwrap_or_default();
            let _ = ctx.app.emit(
                "user-event",
                user_event(ctx.server_id, channel, username, "TOPIC", Some(topic)),
            );
        }
        Command::NICK(new_nick) => {
            let _ = ctx.app.emit(
                "user-event",
                user_event(ctx.server_id, "", username, "NICK", Some(new_nick)),
            );
        }
        Command::AWAY(reason) => {
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    "Away",
                    away_message(&username, reason.as_deref()),
                    "notice",
                ),
            );
        }
        Command::ACCOUNT(account) => {
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    "Account",
                    account_message(&username, &account),
                    "notice",
                ),
            );
        }
        Command::CHGHOST(user, host) => {
            let _ = ctx.app.emit(
                "irc-message",
                system_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    format!("{} changed host to {}.", user, host),
                ),
            );
        }
        Command::WALLOPS(content) => {
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    "Wallops",
                    format!("{}: {}", username, clean_irc_display_text(&content)),
                    "notice",
                ),
            );
        }
        Command::Response(Response::RPL_TOPIC, params) => {
            if params.len() >= 3 {
                let _ = ctx.app.emit(
                    "user-event",
                    user_event(
                        ctx.server_id,
                        params[1].clone(),
                        "system",
                        "TOPIC",
                        Some(clean_irc_display_text(&params[2])),
                    ),
                );
            }
        }
        Command::Response(Response::RPL_TOPICWHOTIME, params) => {
            if params.len() >= 4 {
                let _ = ctx.app.emit(
                    "irc-message",
                    system_message(
                        ctx.server_id,
                        params[1].clone(),
                        format!("Topic set by {}", params[2]),
                    ),
                );
            }
        }
        Command::Response(Response::RPL_LISTSTART, _) => {
            let _ = ctx.window.emit("irc-list-start", ctx.server_id.to_string());
        }
        Command::Response(Response::RPL_LIST, params) => {
            if params.len() >= 4 {
                let _ = ctx.window.emit(
                    "irc-list-item",
                    ChannelInfo {
                        name: params[1].clone(),
                        users: params[2].clone(),
                        topic: clean_irc_display_text(&params[3]),
                    },
                );
            }
        }
        Command::Response(Response::RPL_LISTEND, _) => {
            let _ = ctx.window.emit("irc-list-end", ctx.server_id.to_string());
        }
        Command::Response(Response::RPL_TRYAGAIN, params)
        | Command::Response(Response::ERR_TOOMANYTARGETS, params)
            if list_numeric_message(&params).is_some() =>
        {
            emit_list_error(
                ctx,
                list_numeric_message(&params)
                    .as_deref()
                    .unwrap_or("The network asked us to slow down before requesting LIST again."),
            );
        }
        Command::Response(Response::RPL_ENDOFMOTD, _) => {
            let _ = ctx.window.emit(
                "debug-log",
                format!(
                    "[SYSTEM] {} registration complete; MOTD ended.",
                    ctx.server.name
                ),
            );
        }
        Command::Response(Response::RPL_MOTD, params)
        | Command::Response(Response::RPL_MOTDSTART, params) => {
            if params.len() >= 2 {
                let _ = ctx.window.emit(
                    "debug-log",
                    format!(
                        "[MOTD] {}",
                        redact_sensitive_text(&clean_irc_display_text(&params[1]))
                    ),
                );
            }
        }
        Command::Response(Response::RPL_WELCOME, params) => {
            handle_welcome(ctx, params, registered, ran_perform);
        }
        Command::Response(Response::ERR_NICKNAMEINUSE, _) => {
            let current = ctx.client.current_nickname().to_string();
            let new_nick = format!("{}_", current).trim().to_string();
            let _ = ctx.window.emit(
                "debug-log",
                format!("[SYSTEM] Nick in use, trying {}", new_nick),
            );
            let _ = ctx.client.send(format!("NICK {}", new_nick).as_str());
        }
        Command::Response(Response::RPL_LOGGEDIN, params) => {
            if let Some(message) =
                display_message_for_numeric(Response::RPL_LOGGEDIN, &params, ctx.server_id)
            {
                let _ = ctx.app.emit("irc-message", message);
            }
        }
        Command::Response(Response::RPL_HOSTHIDDEN, params) => {
            if params.len() >= 3 {
                let _ = ctx.app.emit(
                    "irc-message",
                    system_message(
                        ctx.server_id,
                        server_buffer(ctx.server_id),
                        clean_irc_display_text(&format!("Hidden host active: {}", params[2])),
                    ),
                );
            }
        }
        Command::Response(Response::ERR_USERONCHANNEL, params) => {
            if params.len() >= 3 {
                let channel = params[2].clone();
                let _ = ctx.app.emit(
                    "irc-message",
                    system_message(
                        ctx.server_id,
                        channel.clone(),
                        format!("Already joined {}", channel),
                    ),
                );
            }
        }
        Command::Response(Response::ERR_NOTONCHANNEL, params) => {
            if params.len() >= 2 {
                let channel = params[1].clone();
                let _ = ctx.app.emit(
                    "irc-message",
                    system_message(
                        ctx.server_id,
                        server_buffer(ctx.server_id),
                        format!("Cannot part {}; you are not on that channel.", channel),
                    ),
                );
            }
        }
        Command::Response(Response::RPL_WHOISUSER, params) => {
            if params.len() >= 5 {
                let real = params.get(5).map(|value| value.as_str()).unwrap_or("");
                emit_notice_buffer(
                    ctx,
                    &params[1],
                    "WHOIS",
                    clean_irc_display_text(&format!(
                        "{} ({}@{}) - {}",
                        params[1], params[2], params[3], real
                    )),
                );
            }
        }
        Command::Response(Response::RPL_WHOISSERVER, params) => {
            if params.len() >= 3 {
                emit_notice_buffer(
                    ctx,
                    &params[1],
                    "WHOIS",
                    clean_irc_display_text(&format!("Server: {}", params[2])),
                );
            }
        }
        Command::Response(Response::RPL_WHOISCHANNELS, params) => {
            if params.len() >= 3 {
                emit_notice_buffer(
                    ctx,
                    &params[1],
                    "WHOIS",
                    clean_irc_display_text(&format!("Channels: {}", params[2])),
                );
            }
        }
        Command::Response(Response::RPL_WHOISIDLE, params) => {
            if params.len() >= 3 {
                let idle_secs = params[2].parse::<u64>().unwrap_or(0);
                emit_notice_buffer(
                    ctx,
                    &params[1],
                    "WHOIS",
                    format!("Idle: {}", idle_label(idle_secs)),
                );
            }
        }
        Command::Response(Response::RPL_ENDOFWHOIS, params) => {
            if params.len() >= 2 {
                emit_notice_buffer(ctx, &params[1], "WHOIS", "End of WHOIS");
            }
        }
        Command::Response(Response::RPL_AWAY, params) => {
            if params.len() >= 3 {
                emit_notice_buffer(
                    ctx,
                    &params[1],
                    "Away",
                    clean_irc_display_text(&format!("{} is away: {}", params[1], params[2])),
                );
            }
        }
        Command::Response(response, params) => {
            if let Some(message) = display_message_for_numeric(response, &params, ctx.server_id) {
                let _ = ctx.app.emit("irc-message", message);
            } else if let Some(content) = summarize_unknown_numeric(&raw) {
                let _ = ctx.app.emit(
                    "irc-message",
                    system_message(ctx.server_id, server_buffer(ctx.server_id), content),
                );
            } else {
                let _ = ctx.window.emit(
                    "debug-log",
                    format!("[UNHANDLED] {}", redact_sensitive_text(&raw)),
                );
            }
        }
        Command::PING(payload, _) => {
            let _ = ctx.window.emit(
                "debug-log",
                format!("[HEALTH] Server ping from {}: {}", ctx.server.name, payload),
            );
            emit_network_status(
                ctx.window,
                ctx.server_id,
                "online",
                format!("{} is online. Last server ping just now.", ctx.server.name),
                None,
                None,
            );
        }
        Command::ERROR(content) => {
            let content = clean_irc_display_text(&content);
            let _ = ctx.window.emit(
                "debug-log",
                format!("[ERROR] Server ERROR from {}: {}", ctx.server.name, content),
            );
            let _ = ctx.app.emit(
                "irc-message",
                system_message(
                    ctx.server_id,
                    server_buffer(ctx.server_id),
                    format!("Server closed the connection: {}", content),
                ),
            );
            emit_network_status(
                ctx.window,
                ctx.server_id,
                "offline",
                format!("{} closed the connection.", ctx.server.name),
                None,
                None,
            );
        }
        Command::PONG(_, _) => {
            let _ = ctx.window.emit(
                "debug-log",
                format!("[HEALTH] Pong received from {}.", ctx.server.name),
            );
            emit_network_status(
                ctx.window,
                ctx.server_id,
                "online",
                format!("{} is online. Keepalive acknowledged.", ctx.server.name),
                None,
                None,
            );
        }
        Command::Raw(command, params)
            if raw_numeric_list_message(&command, &params, &raw).is_some() =>
        {
            emit_list_error(
                ctx,
                raw_numeric_list_message(&command, &params, &raw)
                    .as_deref()
                    .unwrap_or("The network could not complete LIST."),
            );
        }
        Command::Raw(command, params) if command.eq_ignore_ascii_case("TAGMSG") => {
            handle_tagmsg(ctx, tags.as_deref(), username, params);
        }
        _ => {
            let _ = ctx.window.emit(
                "debug-log",
                format!("[UNHANDLED] {}", redact_sensitive_text(&raw)),
            );
        }
    }
}

async fn handle_privmsg(
    ctx: &IrcCommandContext<'_>,
    username: String,
    target: String,
    content: String,
) {
    let is_channel = is_channel_buffer(&target);
    let buffer = if is_channel {
        target.clone()
    } else {
        username.clone()
    };

    if content == "\x01VERSION\x01" || content.starts_with("\x01VERSION") {
        let _ = ctx
            .client
            .send(format!("NOTICE {} :\x01VERSION Rumblr 0.1.0 (macOS)\x01", username).as_str());
        return;
    }
    if content == "\x01PING\x01" || content.starts_with("\x01PING ") {
        let pong_data = content.trim_matches('\x01').replace("PING", "PING");
        let _ = ctx
            .client
            .send(format!("NOTICE {} :\x01{}\x01", username, pong_data).as_str());
        return;
    }
    if content.starts_with("\x01DCC SEND ") {
        if let Some(offer) = parse_dcc_send(ctx.server_id, &username, &content) {
            let offer_summary = dcc_offer_summary(&offer.file_name, offer.size);
            append_to_log(ctx.app, ctx.server_id, &buffer, &username, &offer_summary).await;
            maybe_notify(ctx, &username, &target, &offer_summary, is_channel).await;
            let _ = ctx.app.emit(
                "irc-message",
                irc_message(
                    ctx.server_id,
                    buffer,
                    username.clone(),
                    offer_summary,
                    "dcc",
                ),
            );
            let _ = ctx.app.emit("dcc-offer", offer);
        }
        return;
    }

    let (actual_content, msg_type) =
        if content.starts_with("\x01ACTION ") && content.ends_with('\x01') {
            (
                clean_irc_display_text(&content[8..content.len() - 1]),
                "action",
            )
        } else {
            (clean_irc_display_text(&content), "privmsg")
        };

    append_to_log(ctx.app, ctx.server_id, &buffer, &username, &actual_content).await;
    maybe_notify(ctx, &username, &target, &actual_content, is_channel).await;
    let _ = ctx.app.emit(
        "irc-message",
        irc_message(ctx.server_id, buffer, username, actual_content, msg_type),
    );
}

fn dcc_offer_summary(file_name: &str, size: Option<u64>) -> String {
    let size = size
        .map(|bytes| format!("{} bytes", bytes))
        .unwrap_or_else(|| "unknown size".to_string());
    format!("DCC offer: {} ({})", file_name, size)
}

async fn handle_notice(
    ctx: &IrcCommandContext<'_>,
    username: String,
    target: String,
    content: String,
) {
    if username == "system" && target == "*" {
        return;
    }

    let clean_content = clean_irc_display_text(&content);
    let buffer = if is_channel_buffer(&target) {
        target
    } else if username == "system" || username.is_empty() {
        server_buffer(ctx.server_id)
    } else {
        username.clone()
    };

    append_to_log(ctx.app, ctx.server_id, &buffer, &username, &clean_content).await;
    let _ = ctx.app.emit(
        "irc-message",
        irc_message(ctx.server_id, buffer, username, clean_content, "notice"),
    );
}

fn handle_tagmsg(
    ctx: &IrcCommandContext<'_>,
    tags: Option<&[Tag]>,
    username: String,
    params: Vec<String>,
) {
    let Some(target) = params.first() else {
        return;
    };
    let Some(typing_state) = typing_state_from_tags(tags) else {
        return;
    };
    if username == "system" || username == ctx.client.current_nickname() {
        return;
    }

    let buffer = if is_channel_buffer(target) {
        target.clone()
    } else {
        username.clone()
    };

    let _ = ctx.app.emit(
        "typing-update",
        TypingUpdate {
            server_id: ctx.server_id.to_string(),
            buffer,
            username,
            typing_state,
            received_at: Utc::now().to_rfc3339(),
        },
    );
}

fn typing_state_from_tags(tags: Option<&[Tag]>) -> Option<String> {
    tags?.iter().find_map(|Tag(key, value)| {
        let is_typing_tag =
            key.eq_ignore_ascii_case("+typing") || key.eq_ignore_ascii_case("typing");
        if !is_typing_tag {
            return None;
        }
        match value.as_deref().unwrap_or("").to_ascii_lowercase().as_str() {
            "active" => Some("active".to_string()),
            "paused" => Some("paused".to_string()),
            "done" => Some("done".to_string()),
            _ => None,
        }
    })
}

fn handle_welcome(
    ctx: &IrcCommandContext<'_>,
    params: Vec<String>,
    registered: &mut bool,
    ran_perform: &mut bool,
) {
    *registered = true;
    let message = params
        .last()
        .map(|message| clean_irc_display_text(message))
        .unwrap_or_else(|| "Connected".to_string());
    let _ = ctx.window.emit(
        "debug-log",
        format!("[WELCOME] {}", redact_sensitive_text(&message)),
    );
    emit_network_status(
        ctx.window,
        ctx.server_id,
        "online",
        format!("{} is online.", ctx.server.name),
        None,
        None,
    );

    let welcome_buffer = ctx
        .server
        .autojoin
        .first()
        .cloned()
        .unwrap_or_else(|| server_buffer(ctx.server_id));
    let _ = ctx.app.emit(
        "irc-message",
        irc_message(ctx.server_id, welcome_buffer, "Server", message, "system"),
    );

    if *ran_perform {
        return;
    }
    *ran_perform = true;
    // Auto-perform commands wait for 001 so service/channel commands run only
    // after the server has accepted registration.
    for cmd in &ctx.server.perform {
        let clean_cmd = cmd.strip_prefix('/').unwrap_or(cmd);
        if let Err(error) = ctx.client.send(clean_cmd) {
            let _ = ctx.window.emit(
                "debug-log",
                format!(
                    "[ERROR] Perform command failed: {}",
                    redact_sensitive_text(&error.to_string())
                ),
            );
        }
    }
}

async fn maybe_notify(
    ctx: &IrcCommandContext<'_>,
    username: &str,
    target: &str,
    content: &str,
    is_channel: bool,
) {
    let presence_status = {
        let presence = ctx.presence.lock().await;
        presence.clone()
    };
    if !ctx.notifications_enabled || presence_status == "busy" || username == "system" {
        return;
    }

    let title = if is_channel {
        format!("{} in {}", username, target)
    } else {
        format!("Private Message from {}", username)
    };
    let body = truncate_text(content, MAX_NOTIFICATION_BODY_CHARS);
    let _ = ctx
        .app
        .notification()
        .builder()
        .title(title)
        .body(&body)
        .show();
}

fn invite_message(inviter: &str, invitee: &str, channel: &str) -> String {
    format!("{inviter} invited {invitee} to {channel}.")
}

fn away_message(username: &str, reason: Option<&str>) -> String {
    match reason.filter(|value| !value.trim().is_empty()) {
        Some(reason) => format!("{username} is away: {}", clean_irc_display_text(reason)),
        None => format!("{username} is back."),
    }
}

fn account_message(username: &str, account: &str) -> String {
    if account == "*" || account.trim().is_empty() {
        format!("{username} logged out of their account.")
    } else {
        format!(
            "{username} is logged in as {}.",
            clean_irc_display_text(account)
        )
    }
}

fn emit_notice_buffer(
    ctx: &IrcCommandContext<'_>,
    buffer: impl Into<String>,
    username: impl Into<String>,
    content: impl Into<String>,
) {
    let _ = ctx.app.emit(
        "irc-message",
        irc_message(ctx.server_id, buffer, username, content, "notice"),
    );
}

fn idle_label(idle_secs: u64) -> String {
    if idle_secs < 60 {
        format!("{}s", idle_secs)
    } else if idle_secs < 3600 {
        format!("{}m {}s", idle_secs / 60, idle_secs % 60)
    } else {
        format!("{}h {}m", idle_secs / 3600, (idle_secs % 3600) / 60)
    }
}

fn emit_list_error(ctx: &IrcCommandContext<'_>, message: &str) {
    let message = clean_irc_display_text(message);
    let message = if message.is_empty() {
        "The network could not complete LIST.".to_string()
    } else {
        message
    };
    let _ = ctx.window.emit(
        "irc-list-error",
        ChannelListStatus {
            server_id: ctx.server_id.to_string(),
            status: "error".to_string(),
            message: message.clone(),
        },
    );
    let _ = ctx.window.emit(
        "debug-log",
        format!(
            "[LIST] {} refused or delayed LIST: {}",
            ctx.server.name, message
        ),
    );
}

fn list_numeric_message(params: &[String]) -> Option<String> {
    let mentions_list = params
        .iter()
        .any(|param| param.trim().eq_ignore_ascii_case("LIST"));
    if !mentions_list {
        return None;
    }
    let message = params
        .iter()
        .rev()
        .find(|param| !param.trim().is_empty() && !param.trim().eq_ignore_ascii_case("LIST"))
        .map(|param| clean_irc_display_text(param))
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| {
            "The network asked us to wait before requesting LIST again.".to_string()
        });
    Some(message)
}

fn raw_numeric_list_message(command: &str, params: &[String], raw: &str) -> Option<String> {
    let is_unknown_numeric = command.len() == 3 && command.chars().all(|ch| ch.is_ascii_digit());
    if !is_unknown_numeric || matches!(command, "321" | "322" | "323") {
        return None;
    }
    if let Some(message) = list_numeric_message(params) {
        return Some(message);
    }
    if raw.to_ascii_uppercase().contains(" LIST") {
        return summarize_unknown_numeric(raw)
            .or_else(|| Some("The network could not complete LIST.".to_string()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_event_copy_is_stable_and_readable() {
        assert_eq!(
            invite_message("alice", "RumblrUser", "#rumblr"),
            "alice invited RumblrUser to #rumblr."
        );
    }

    #[test]
    fn away_event_copy_covers_away_and_back_states() {
        assert_eq!(away_message("alice", Some("lunch")), "alice is away: lunch");
        assert_eq!(away_message("alice", None), "alice is back.");
    }

    #[test]
    fn account_event_copy_covers_login_and_logout_states() {
        assert_eq!(
            account_message("alice", "alice-account"),
            "alice is logged in as alice-account."
        );
        assert_eq!(
            account_message("alice", "*"),
            "alice logged out of their account."
        );
    }

    #[test]
    fn typing_tag_parser_accepts_ircv3_client_only_typing_states() {
        let tags = vec![Tag("+typing".to_string(), Some("active".to_string()))];
        assert_eq!(
            typing_state_from_tags(Some(&tags)),
            Some("active".to_string())
        );

        let tags = vec![Tag("typing".to_string(), Some("DONE".to_string()))];
        assert_eq!(
            typing_state_from_tags(Some(&tags)),
            Some("done".to_string())
        );

        let tags = vec![Tag("+typing".to_string(), Some("unknown".to_string()))];
        assert_eq!(typing_state_from_tags(Some(&tags)), None);
    }

    #[test]
    fn list_numeric_message_recognizes_list_throttles() {
        let params = vec![
            "RumblrUser".to_string(),
            "LIST".to_string(),
            "Please wait a while and try again.".to_string(),
        ];
        assert_eq!(
            list_numeric_message(&params),
            Some("Please wait a while and try again.".to_string())
        );
    }

    #[test]
    fn raw_numeric_list_message_recognizes_unknown_list_errors() {
        let params = vec![
            "RumblrUser".to_string(),
            "LIST".to_string(),
            "Output too large, truncated".to_string(),
        ];
        assert_eq!(
            raw_numeric_list_message(
                "416",
                &params,
                ":server 416 RumblrUser LIST :Output too large, truncated"
            ),
            Some("Output too large, truncated".to_string())
        );
    }
}

fn summarize_unknown_numeric(raw: &str) -> Option<String> {
    let parts: Vec<&str> = raw.trim().splitn(4, ' ').collect();
    if parts.len() < 4 || parts[1].parse::<u16>().is_err() {
        return None;
    }
    let text = parts[3].trim_start_matches(':');
    if text.is_empty() {
        None
    } else {
        Some(clean_irc_display_text(text))
    }
}
