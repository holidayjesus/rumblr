//! Native window lifecycle helpers.
//!
//! Tauri command functions stay in `lib.rs` because they are part of the public
//! invoke surface. The reusable mechanics for creating, focusing, hiding, and
//! toggling Rumblr windows live here so menu handlers and commands share one
//! implementation.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

pub(crate) fn open_messages_window_impl(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("messages") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        "messages",
        WebviewUrl::App("index.html?view=messages".into()),
    )
    .title("Rumblr Messages")
    .inner_size(1180.0, 760.0)
    .min_inner_size(860.0, 560.0)
    .decorations(false)
    .resizable(true)
    .skip_taskbar(false)
    .visible(true)
    .build()
    .map(|window| {
        #[cfg(target_os = "macos")]
        {
            let _ = apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            );
        }
        let _ = window.set_focusable(true);
    })
    .map_err(|e| e.to_string())
}

pub(crate) fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn focus_messages_window(app: &AppHandle) {
    let _ = open_messages_window_impl(app);
}

pub(crate) fn focus_next_app_window(app: &AppHandle) {
    let main_focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    let messages_exists = app.get_webview_window("messages").is_some();

    if main_focused && messages_exists {
        focus_messages_window(app);
    } else {
        focus_main_window(app);
    }
}

pub(crate) fn hide_all_windows(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
}

pub(crate) fn show_rumblr(app: &AppHandle) {
    focus_main_window(app);
}

pub(crate) fn toggle_rumblr_visibility_impl(app: &AppHandle) {
    let any_visible = app
        .webview_windows()
        .values()
        .any(|window| window.is_visible().unwrap_or(false));
    if any_visible {
        hide_all_windows(app);
    } else {
        show_rumblr(app);
    }
}

fn youtube_player_url(video_id: &str) -> String {
    format!("youtube-player.html?videoId={video_id}")
}

fn youtube_watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}&app=desktop")
}

fn clean_youtube_video_id(video_id: &str) -> Result<String, String> {
    let id = video_id.trim();
    let valid_length = (6..=20).contains(&id.len());
    let valid_chars = id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if valid_length && valid_chars {
        Ok(id.to_string())
    } else {
        Err("Invalid YouTube video id.".to_string())
    }
}

pub(crate) fn promote_youtube_player_to_watch_page_impl(
    window: &WebviewWindow,
    video_id: &str,
) -> Result<(), String> {
    let id = clean_youtube_video_id(video_id)?;
    let url = youtube_watch_url(&id)
        .parse()
        .map_err(|error| format!("Invalid YouTube watch URL: {error}"))?;
    window.navigate(url).map_err(|error| error.to_string())
}

pub(crate) fn open_youtube_player_impl(app: &AppHandle, video_id: &str) -> Result<(), String> {
    let id = clean_youtube_video_id(video_id)?;
    let label_id: String = id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { 'x' })
        .collect();
    let label = format!("youtube-{}", label_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    // Start with Rumblr's local player wrapper. The wrapper owns the YouTube
    // iframe and redirects itself to the full watch page only after Error 153.
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(youtube_player_url(&id).into()))
        .title(format!("YouTube - {}", id))
        .inner_size(860.0, 520.0)
        .min_inner_size(420.0, 260.0)
        .resizable(true)
        .decorations(true)
        .skip_taskbar(false)
        .visible(true)
        .always_on_top(false)
        .build()
        .map(|window| {
            let _ = window.set_focus();
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{clean_youtube_video_id, youtube_player_url, youtube_watch_url};

    #[test]
    fn youtube_video_ids_are_strictly_validated() {
        assert_eq!(
            clean_youtube_video_id("dQw4w9WgXcQ").unwrap(),
            "dQw4w9WgXcQ"
        );
        assert!(clean_youtube_video_id("https://youtube.com/watch?v=dQw4w9WgXcQ").is_err());
        assert!(clean_youtube_video_id("bad id").is_err());
    }

    #[test]
    fn youtube_player_starts_on_local_wrapper() {
        assert_eq!(
            youtube_player_url("dQw4w9WgXcQ"),
            "youtube-player.html?videoId=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn youtube_watch_page_is_only_the_error_fallback_target() {
        assert_eq!(
            youtube_watch_url("dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&app=desktop"
        );
    }
}
