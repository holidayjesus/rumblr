// Rumblr Workstation Backend v0.1.0-alpha
//
// `lib.rs` is the Tauri command surface and IRC runtime coordinator. The data
// contracts, persistent config, text cleanup, and disk logging live in sibling
// modules so this file can focus on wiring application behavior together.
mod commands_config;
mod config;
mod dcc;
mod irc_connection;
mod irc_events;
mod irc_handlers;
mod irc_numeric;
mod irc_outbound;
mod irc_registration;
mod irc_status;
mod irc_support;
mod logging;
mod macos_activity;
mod media;
mod models;
mod text;
mod windows;

use commands_config::{
    cancel_orphaned_connections, export_workstation_state_impl, import_workstation_state_impl,
    load_config_file, open_log_dir_impl, save_config_file,
};
use config::AppConfig;
use dcc::{accept_dcc_offer_impl, cancel_dcc_transfer_impl, reveal_dcc_download_impl};
use irc::client::prelude::*;
use irc_connection::connect_to_server;
use irc_outbound::{send_irc_message_impl, send_typing_state_impl};
use irc_support::emit_network_status;
use media::{get_media_status_impl, media_control_impl};
use models::{DccOffer, DccTransfer};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, UserAttentionType, WebviewWindow, Window};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
use windows::{
    focus_main_window, focus_messages_window, focus_next_app_window, hide_all_windows,
    open_messages_window_impl, open_youtube_player_impl, promote_youtube_player_to_watch_page_impl,
    toggle_rumblr_visibility_impl,
};

struct AppState {
    config: Arc<Mutex<AppConfig>>,
    clients: Arc<Mutex<HashMap<String, Arc<Client>>>>,
    cancellation_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    dcc_transfers: dcc::DccTransferRegistry,
    presence_status: Arc<Mutex<String>>,
}

#[tauri::command]
#[allow(non_snake_case)]
async fn disconnect_from_server(
    window: Window,
    state: tauri::State<'_, AppState>,
    serverId: String,
) -> Result<(), String> {
    let mut tokens = state.cancellation_tokens.lock().await;
    if let Some(token) = tokens.remove(&serverId) {
        token.cancel();
    }
    let mut clients = state.clients.lock().await;
    clients.remove(&serverId);
    emit_network_status(
        &window,
        &serverId,
        "offline",
        "Disconnected.".to_string(),
        None,
        None,
    );
    Ok(())
}

#[tauri::command]
async fn set_presence_status(
    state: tauri::State<'_, AppState>,
    status: String,
) -> Result<(), String> {
    let normalized = match status.as_str() {
        "away" | "busy" => status,
        _ => "online".to_string(),
    };
    let mut presence = state.presence_status.lock().await;
    *presence = normalized;
    Ok(())
}

#[tauri::command]
async fn close_window(window: Window) {
    let _ = window.close();
}

#[tauri::command]
async fn minimize_window(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
async fn toggle_maximize_window(window: Window) {
    if let Ok(m) = window.is_maximized() {
        if m {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
async fn open_messages_window(app: AppHandle) -> Result<(), String> {
    open_messages_window_impl(&app)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn open_youtube_player(app: AppHandle, videoId: String) -> Result<(), String> {
    open_youtube_player_impl(&app, &videoId)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn show_youtube_watch_page(window: WebviewWindow, videoId: String) -> Result<(), String> {
    promote_youtube_player_to_watch_page_impl(&window, &videoId)
}

#[tauri::command]
#[allow(non_snake_case)]
async fn set_native_unread_state(
    window: Window,
    count: i64,
    hasMention: bool,
) -> Result<(), String> {
    let count = count.max(0);
    let badge = if count == 0 { None } else { Some(count) };
    window.set_badge_count(badge).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let label = if count == 0 {
            None
        } else if hasMention {
            Some(format!("!{}", count.min(99)))
        } else {
            Some(count.min(99).to_string())
        };
        window.set_badge_label(label).map_err(|e| e.to_string())?;
    }
    if count > 0 && hasMention && !window.is_focused().unwrap_or(false) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
    Ok(())
}

#[tauri::command]
async fn toggle_rumblr_visibility(app: AppHandle) -> Result<(), String> {
    toggle_rumblr_visibility_impl(&app);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn send_irc_message(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    serverId: String,
    channel: String,
    content: String,
) -> Result<(), String> {
    let clients = state.clients.lock().await;
    if let Some(client) = clients.get(&serverId) {
        send_irc_message_impl(&app, client, &serverId, &channel, &content).await
    } else {
        Err("Handshake required".to_string())
    }
}

#[tauri::command]
#[allow(non_snake_case)]
async fn send_irc_typing_state(
    state: tauri::State<'_, AppState>,
    serverId: String,
    channel: String,
    typingState: String,
) -> Result<(), String> {
    let clients = state.clients.lock().await;
    if let Some(client) = clients.get(&serverId) {
        send_typing_state_impl(client, &channel, &typingState).await
    } else {
        Err("Handshake required".to_string())
    }
}

#[tauri::command]
async fn accept_dcc_offer(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    offer: DccOffer,
) -> Result<DccTransfer, String> {
    accept_dcc_offer_impl(app, state.dcc_transfers.clone(), offer).await
}

#[tauri::command]
#[allow(non_snake_case)]
async fn cancel_dcc_transfer(
    state: tauri::State<'_, AppState>,
    transferId: String,
) -> Result<(), String> {
    cancel_dcc_transfer_impl(state.dcc_transfers.clone(), transferId).await
}

#[tauri::command]
async fn reveal_dcc_download(path: String) -> Result<(), String> {
    reveal_dcc_download_impl(path)
}

#[tauri::command]
async fn load_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AppConfig, String> {
    let config = load_config_file(&app).await?;
    let mut tokens = state.cancellation_tokens.lock().await;
    cancel_orphaned_connections(&config, &mut tokens);

    let mut state_cfg = state.config.lock().await;
    *state_cfg = config.clone();
    Ok(config)
}

#[tauri::command]
async fn save_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AppConfig,
) -> Result<(), String> {
    let mut cfg = state.config.lock().await;
    *cfg = config.clone();
    save_config_file(&app, &config).await
}

#[tauri::command]
async fn test_network_connection(host: String, port: u16, use_ssl: bool) -> Result<String, String> {
    if host.trim().is_empty() {
        return Err("Host is required.".to_string());
    }
    let addr = format!("{}:{}", host.trim(), port);
    let stream = timeout(Duration::from_secs(8), TcpStream::connect(&addr))
        .await
        .map_err(|_| "Connection test timed out.".to_string())?
        .map_err(|e| format!("TCP connection failed: {}", e))?;

    if use_ssl {
        let connector = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| e.to_string())?;
        let connector = tokio_native_tls::TlsConnector::from(connector);
        timeout(
            Duration::from_secs(8),
            connector.connect(host.trim(), stream),
        )
        .await
        .map_err(|_| "TLS handshake timed out.".to_string())?
        .map_err(|e| format!("TLS handshake failed: {}", e))?;
        Ok("TCP and TLS handshake succeeded.".to_string())
    } else {
        Ok("TCP connection succeeded.".to_string())
    }
}

#[tauri::command]
async fn open_log_dir(app: AppHandle) -> Result<(), String> {
    open_log_dir_impl(&app).await
}

#[tauri::command]
async fn export_workstation_state(app: AppHandle) -> Result<String, String> {
    export_workstation_state_impl(&app).await
}

#[tauri::command]
async fn import_workstation_state(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    import_workstation_state_impl(&app).await?;
    load_config(app, state).await?;
    Ok("Configuration restored successfully.".to_string())
}

#[tauri::command]
async fn get_media_status() -> Result<String, String> {
    get_media_status_impl().await
}

#[tauri::command]
async fn media_control(command: String) -> Result<(), String> {
    media_control_impl(command).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            use tauri::Emitter;

            let about_i = MenuItem::with_id(app, "about-ex", "About Rumblr", true, None::<&str>)?;
            let show_main_i = MenuItem::with_id(
                app,
                "show-main-ex",
                "Show Main Window",
                true,
                Some("CmdOrCtrl+1"),
            )?;
            let messages_i = MenuItem::with_id(
                app,
                "messages-ex",
                "Messages Window",
                true,
                Some("CmdOrCtrl+M"),
            )?;
            let mentions_i = MenuItem::with_id(
                app,
                "mentions-ex",
                "Notifications",
                true,
                Some("CmdOrCtrl+N"),
            )?;
            let browse_i = MenuItem::with_id(
                app,
                "browse-ex",
                "Browse Channels",
                true,
                Some("CmdOrCtrl+R"),
            )?;
            let next_window_i = MenuItem::with_id(
                app,
                "next-window-ex",
                "Next Rumblr Window",
                true,
                Some("CmdOrCtrl+Backquote"),
            )?;
            let hide_windows_i = MenuItem::with_id(
                app,
                "hide-windows-ex",
                "Hide Rumblr Windows",
                true,
                Some("CmdOrCtrl+Shift+H"),
            )?;
            let toggle_windows_i = MenuItem::with_id(
                app,
                "toggle-windows-ex",
                "Show/Hide Rumblr",
                true,
                Some("CmdOrCtrl+Shift+Space"),
            )?;
            let options_i = MenuItem::with_id(app, "options-ex", "Options...", true, Some(", "))?;
            let app_m = Submenu::with_items(
                app,
                "Rumblr",
                true,
                &[
                    &about_i,
                    &PredefinedMenuItem::separator(app)?,
                    &show_main_i,
                    &messages_i,
                    &mentions_i,
                    &browse_i,
                    &PredefinedMenuItem::separator(app)?,
                    &next_window_i,
                    &toggle_windows_i,
                    &hide_windows_i,
                    &PredefinedMenuItem::separator(app)?,
                    &options_i,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None::<&str>)?,
                    &PredefinedMenuItem::hide_others(app, None::<&str>)?,
                    &PredefinedMenuItem::show_all(app, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None::<&str>)?,
                ],
            )?;

            let _edit_m = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None::<&str>)?,
                    &PredefinedMenuItem::redo(app, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None::<&str>)?,
                    &PredefinedMenuItem::copy(app, None::<&str>)?,
                    &PredefinedMenuItem::paste(app, None::<&str>)?,
                    &PredefinedMenuItem::select_all(app, None::<&str>)?,
                ],
            )?;

            let share_current_i = MenuItem::with_id(
                app,
                "share-current-ex",
                "Copy Current Buffer Summary",
                true,
                Some("CmdOrCtrl+Shift+C"),
            )?;
            let share_messages_i = MenuItem::with_id(
                app,
                "share-messages-ex",
                "Copy Messages Summary",
                true,
                None::<&str>,
            )?;
            let _share_m = Submenu::with_items(
                app,
                "Share",
                true,
                &[
                    &share_current_i,
                    &share_messages_i,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None::<&str>)?,
                ],
            )?;

            let window_show_main_i = MenuItem::with_id(
                app,
                "window-show-main-ex",
                "Show Main Window",
                true,
                Some("CmdOrCtrl+1"),
            )?;
            let window_messages_i = MenuItem::with_id(
                app,
                "window-messages-ex",
                "Messages Window",
                true,
                Some("CmdOrCtrl+2"),
            )?;
            let window_next_i = MenuItem::with_id(
                app,
                "window-next-ex",
                "Next Rumblr Window",
                true,
                Some("CmdOrCtrl+Backquote"),
            )?;
            let window_toggle_i = MenuItem::with_id(
                app,
                "window-toggle-ex",
                "Show/Hide Rumblr",
                true,
                Some("CmdOrCtrl+Shift+Space"),
            )?;
            let window_m = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &window_show_main_i,
                    &window_messages_i,
                    &window_next_i,
                    &window_toggle_i,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::minimize(app, None::<&str>)?,
                    &PredefinedMenuItem::maximize(app, None::<&str>)?,
                    &PredefinedMenuItem::fullscreen(app, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::bring_all_to_front(app, None::<&str>)?,
                ],
            )?;

            let menu = Menu::with_items(app, &[&app_m, &window_m])?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "about-ex" {
                    let _ = app_handle.emit("open-about", ());
                } else if event.id() == "options-ex" {
                    let _ = app_handle.emit("open-options", ());
                } else if event.id() == "messages-ex" {
                    focus_messages_window(app_handle);
                } else if event.id() == "mentions-ex" {
                    let _ = app_handle.emit("open-mentions", ());
                } else if event.id() == "browse-ex" {
                    let _ = app_handle.emit("open-browse", ());
                } else if event.id() == "show-main-ex" || event.id() == "window-show-main-ex" {
                    focus_main_window(app_handle);
                } else if event.id() == "next-window-ex" || event.id() == "window-next-ex" {
                    focus_next_app_window(app_handle);
                } else if event.id() == "hide-windows-ex" {
                    hide_all_windows(app_handle);
                } else if event.id() == "toggle-windows-ex" || event.id() == "window-toggle-ex" {
                    toggle_rumblr_visibility_impl(app_handle);
                } else if event.id() == "share-current-ex" {
                    let _ = app_handle.emit("native-share-current", ());
                } else if event.id() == "share-messages-ex" {
                    let _ = app_handle.emit("native-share-messages", ());
                }
            });

            let config_dir = app.path().app_config_dir().unwrap();
            if !config_dir.exists() {
                let _ = fs::create_dir_all(&config_dir);
            }
            let mut config_path = config_dir.clone();
            config_path.push("config.json");
            let initial_config = if config_path.exists() {
                fs::read_to_string(&config_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| AppConfig::default())
            } else {
                AppConfig::default()
            };
            app.manage(AppState {
                config: Arc::new(Mutex::new(initial_config)),
                clients: Arc::new(Mutex::new(HashMap::new())),
                cancellation_tokens: Arc::new(Mutex::new(HashMap::new())),
                dcc_transfers: Arc::new(Mutex::new(HashMap::new())),
                presence_status: Arc::new(Mutex::new("online".to_string())),
            });

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            connect_to_server,
            close_window,
            minimize_window,
            toggle_maximize_window,
            open_messages_window,
            open_youtube_player,
            show_youtube_watch_page,
            set_native_unread_state,
            toggle_rumblr_visibility,
            send_irc_message,
            send_irc_typing_state,
            accept_dcc_offer,
            cancel_dcc_transfer,
            reveal_dcc_download,
            open_log_dir,
            disconnect_from_server,
            set_presence_status,
            test_network_connection,
            export_workstation_state,
            import_workstation_state,
            get_media_status,
            media_control
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
