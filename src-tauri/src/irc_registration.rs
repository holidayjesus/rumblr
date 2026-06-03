//! IRC registration handshake helpers.
//!
//! The connection task owns sockets and retries; this module owns the first
//! protocol writes that turn an open socket into a registered IRC session.

use crate::config::ServerConfig;
use crate::text::redact_sensitive_text;
use irc::client::prelude::*;
use irc::proto::CapSubCommand::{END, REQ};
use std::sync::Arc;
use tauri::{Emitter, Window};

pub(crate) struct RegistrationDetails {
    pub(crate) nick: String,
    user: String,
    realname: String,
}

impl RegistrationDetails {
    pub(crate) fn from_config(
        server: &ServerConfig,
        global_nick: &str,
        global_realname: &str,
    ) -> Self {
        let nick = server
            .nickname
            .clone()
            .unwrap_or_else(|| global_nick.to_string());
        RegistrationDetails {
            user: nick.clone(),
            nick,
            realname: server
                .realname
                .clone()
                .unwrap_or_else(|| global_realname.to_string()),
        }
    }
}

pub(crate) fn send_registration(
    window: &Window,
    client: &Arc<Client>,
    details: &RegistrationDetails,
) {
    let _ = window.emit(
        "debug-log",
        format!("[REGISTRATION] Sending CAP/NICK/USER for {}", details.nick),
    );

    send_registration_step(
        window,
        "CAP REQ message-tags",
        client.send(Command::CAP(
            None,
            REQ,
            None,
            Some("message-tags".to_string()),
        )),
    );

    send_registration_step(
        window,
        "CAP END",
        client.send(Command::CAP(None, END, None, None)),
    );

    // Do not send the saved NickServ password as IRC PASS. The IRC crate uses
    // `Config::nick_password` after MOTD, which is the correct services flow.
    send_registration_step(
        window,
        "NICK",
        client.send(Command::NICK(details.nick.clone())),
    );
    send_registration_step(
        window,
        "USER",
        client.send(Command::USER(
            details.user.clone(),
            "0".to_string(),
            details.realname.clone(),
        )),
    );
}

fn send_registration_step(window: &Window, label: &str, result: irc::error::Result<()>) {
    if let Err(error) = result {
        let _ = window.emit(
            "debug-log",
            format!(
                "[ERROR] {} failed: {}",
                label,
                redact_sensitive_text(&error.to_string())
            ),
        );
    }
}
