//! Long-lived IRC connection task orchestration.
//!
//! `lib.rs` exposes Tauri commands; this module owns the actual network
//! lifecycle: connect, register, process stream events, retry, and cancel. That
//! split keeps command wiring separate from IRC runtime behavior.

use crate::irc_handlers::{handle_irc_command, IrcCommandContext};
use crate::irc_registration::{send_registration, RegistrationDetails};
use crate::irc_status::{
    reconnect_delay, reconnect_status_message, should_reconnect, stream_ended_message,
};
use crate::irc_support::{build_irc_config, emit_network_status};
use crate::logging::emit_log;
use crate::text::redact_sensitive_text;
use crate::AppState;
use futures::StreamExt;
use irc::client::prelude::*;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};
use tokio_util::sync::CancellationToken;

const IRC_REGISTRATION_TIMEOUT_SECONDS: u64 = 25;

#[tauri::command]
#[allow(non_snake_case)]
pub(crate) async fn connect_to_server(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, AppState>,
    serverId: String,
) -> Result<String, String> {
    emit_log(
        &window,
        &format!(
            "[SYSTEM] Resetting workstation state for network: {}",
            serverId
        ),
    )
    .await;

    {
        let mut tokens = state.cancellation_tokens.lock().await;
        if let Some(token) = tokens.get(&serverId) {
            token.cancel();
        }
        let new_token = CancellationToken::new();
        tokens.insert(serverId.clone(), new_token);
    }

    let (server_cfg, global_nick, global_alt_nick, global_real, notifications_enabled, multi_net) = {
        let config_lock = state.config.lock().await;
        let cfg = config_lock
            .servers
            .iter()
            .find(|s| s.id == serverId)
            .cloned()
            .ok_or_else(|| format!("Network '{}' not found", serverId))?;
        (
            cfg,
            config_lock.global_nickname.clone(),
            config_lock.global_alt_nickname.clone(),
            config_lock.global_realname.clone(),
            config_lock.notifications_enabled,
            config_lock.multi_network,
        )
    };

    if !multi_net {
        let tokens = state.cancellation_tokens.lock().await;
        for (id, token) in tokens.iter() {
            if id != &serverId {
                token.cancel();
            }
        }
        let mut clients = state.clients.lock().await;
        for id in tokens.keys() {
            if id != &serverId {
                clients.remove(id);
                emit_network_status(
                    &window,
                    id,
                    "offline",
                    "Disconnected because single-network mode is enabled.".to_string(),
                    None,
                    None,
                );
            }
        }
    }

    let sid = serverId.clone();
    let window_clone = window.clone();
    let tokens = state.cancellation_tokens.lock().await;
    let token = tokens.get(&serverId).ok_or("Token lost")?.clone();
    drop(tokens);

    let state_handle = state.inner().clients.clone();
    let config_handle = state.inner().config.clone();
    let presence_handle = state.inner().presence_status.clone();
    let server_cfg_task = server_cfg.clone();
    let res_name = server_cfg.name.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        crate::macos_activity::begin_irc_network_activity_once();

        let mut retry_count = 0;

        loop {
            if token.is_cancelled() {
                break;
            }

            let irc_config = build_irc_config(
                &server_cfg_task,
                &global_nick,
                global_alt_nick.as_deref(),
                &global_real,
            );
            let registration =
                RegistrationDetails::from_config(&server_cfg_task, &global_nick, &global_real);

            let _ = window_clone.emit(
                "debug-log",
                format!(
                    "[NETWORK] Connecting to {} (Attempt {})...",
                    server_cfg_task.name,
                    retry_count + 1
                ),
            );
            emit_network_status(
                &window_clone,
                &sid,
                "connecting",
                format!("Connecting to {}...", server_cfg_task.name),
                None,
                Some(retry_count + 1),
            );

            let client_res = Client::from_config(irc_config).await;
            match client_res {
                Ok(mut client) => {
                    retry_count = 0;

                    match client.stream() {
                        Ok(mut stream) => {
                            let mut registered = false;
                            let mut ran_perform = false;

                            let arc_client = Arc::new(client);
                            {
                                let mut clients = state_handle.lock().await;
                                clients.insert(sid.clone(), arc_client.clone());
                            }

                            let _ = window_clone.emit(
                                "debug-log",
                                format!(
                                    "[SYSTEM] {} socket is open; waiting for IRC welcome.",
                                    server_cfg_task.name
                                ),
                            );
                            emit_network_status(
                                &window_clone,
                                &sid,
                                "connecting",
                                format!(
                                    "{} socket open; waiting for welcome...",
                                    server_cfg_task.name
                                ),
                                None,
                                None,
                            );
                            println!("[IRC] Connection live for {}", sid);

                            send_registration(&window_clone, &arc_client, &registration);
                            emit_network_status(
                                &window_clone,
                                &sid,
                                "connecting",
                                format!(
                                    "{} registration sent; waiting for welcome...",
                                    server_cfg_task.name
                                ),
                                None,
                                None,
                            );

                            let handler_context = IrcCommandContext {
                                app: &app_clone,
                                window: &window_clone,
                                client: &arc_client,
                                server_id: &sid,
                                server: &server_cfg_task,
                                presence: &presence_handle,
                                notifications_enabled,
                            };

                            tokio::select! {
                                _ = token.cancelled() => {
                                    let _ = arc_client.send_quit("Rumblr Client shutdown");
                                    break;
                                }
                                _ = async {
                                    loop {
                                        if token.is_cancelled() { break; }
                                        let next_message = if registered {
                                            stream.next().await
                                        } else {
                                            match tokio::time::timeout(
                                                Duration::from_secs(IRC_REGISTRATION_TIMEOUT_SECONDS),
                                                stream.next(),
                                            )
                                            .await
                                            {
                                                Ok(message) => message,
                                                Err(_) => {
                                                    let _ = window_clone.emit(
                                                        "debug-log",
                                                        format!(
                                                            "[ERROR] {} did not send welcome within {} seconds after the socket opened.",
                                                            server_cfg_task.name,
                                                            IRC_REGISTRATION_TIMEOUT_SECONDS
                                                        ),
                                                    );
                                                    break;
                                                }
                                            }
                                        };

                                        let Some(message) = next_message else { break; };
                                        match message {
                                            Ok(msg) => {
                                                let raw_msg = msg.to_string();
                                                let _ = window_clone.emit("debug-log", format!("[RAW] {}", redact_sensitive_text(&raw_msg)));
                                                handle_irc_command(&handler_context, msg, &mut registered, &mut ran_perform).await;
                                            }
                                            Err(e) => {
                                                println!("[IRC] Stream error on {}: {}", sid, e);
                                                let _ = window_clone.emit("debug-log", format!("[ERROR] Stream error: {}", redact_sensitive_text(&e.to_string())));
                                                break;
                                            }
                                        }
                                    }
                                    println!("[IRC] Stream ended for {}", sid);
                                } => {}
                            }
                            {
                                let mut clients = state_handle.lock().await;
                                // A reconnect can cancel an older task while a
                                // newer task has already installed its client.
                                // Only the task that owns the current Arc gets
                                // to remove it; otherwise an old shutdown makes
                                // the UI look disconnected while IRC traffic is
                                // still arriving from the new socket.
                                let owns_current_client = clients
                                    .get(&sid)
                                    .map(|current| Arc::ptr_eq(current, &arc_client))
                                    .unwrap_or(false);
                                if owns_current_client {
                                    clients.remove(&sid);
                                }
                            }
                            if !token.is_cancelled() {
                                let _ = window_clone.emit(
                                    "debug-log",
                                    format!(
                                        "[NETWORK] {}",
                                        stream_ended_message(&server_cfg_task.name, registered)
                                    ),
                                );
                            }
                            if !token.is_cancelled() && !registered {
                                emit_network_status(
                                    &window_clone,
                                    &sid,
                                    "failed",
                                    format!(
                                        "{} disconnected before welcome.",
                                        server_cfg_task.name
                                    ),
                                    None,
                                    Some(retry_count + 1),
                                );
                            }
                        }
                        Err(e) => {
                            let _ = window_clone.emit(
                                "debug-log",
                                format!(
                                    "[ERROR] Stream setup failed: {}",
                                    redact_sensitive_text(&e.to_string())
                                ),
                            );
                            emit_network_status(
                                &window_clone,
                                &sid,
                                "failed",
                                format!("Stream setup failed: {}", e),
                                None,
                                Some(retry_count + 1),
                            );
                        }
                    }
                }
                Err(e) => {
                    let _ = window_clone.emit(
                        "debug-log",
                        format!(
                            "[ERROR] Connection failed: {}",
                            redact_sensitive_text(&e.to_string())
                        ),
                    );
                    emit_network_status(
                        &window_clone,
                        &sid,
                        "failed",
                        format!("Connection failed: {}", e),
                        None,
                        Some(retry_count + 1),
                    );
                }
            }

            let auto_reconnect = {
                let cfg = config_handle.lock().await;
                cfg.auto_reconnect
            };

            if !should_reconnect(auto_reconnect, token.is_cancelled()) {
                if !token.is_cancelled() {
                    emit_network_status(
                        &window_clone,
                        &sid,
                        "offline",
                        "Connection stopped.".to_string(),
                        None,
                        None,
                    );
                }
                break;
            }

            retry_count += 1;
            let delay = reconnect_delay(retry_count);
            let _ = window_clone.emit(
                "debug-log",
                format!("[SYSTEM] Retrying {} in {} seconds...", sid, delay),
            );
            emit_network_status(
                &window_clone,
                &sid,
                "retrying",
                reconnect_status_message(delay),
                Some(delay as u64),
                Some(retry_count + 1),
            );
            tokio::select! {
                _ = token.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_secs(delay as u64)) => {}
            }
        }
        // User-visible cancellation state is emitted by the command that
        // requested the cancel. Letting a retired task emit "offline" here can
        // stomp a newer successful reconnect for the same server.
    });

    Ok(format!("Handshake pending for {}", res_name))
}
