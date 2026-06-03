//! Media integration for the compact sidebar player.
//!
//! Rumblr's frontend consumes simple string payloads for now. This module keeps
//! the platform-specific AppleScript calls out of the central Tauri command
//! file while preserving the existing media command contract.

pub(crate) async fn get_media_status_impl() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let script = "
            if application \"Spotify\" is running then
                tell application \"Spotify\"
                    if player state is playing or player state is paused then
                        set artUrl to artwork url of current track
                        set pos to player position
                        set dur to (duration of current track) / 1000
                        set albumName to album of current track
                        set vol to sound volume
                        set shuffleState to shuffling
                        set repeatState to repeating
                        return \"Spotify\" & \"||\" & (get artist of current track) & \"||\" & (get name of current track) & \"||\" & artUrl & \"||\" & (player state as string) & \"||\" & pos & \"||\" & dur & \"||\" & albumName & \"||\" & vol & \"||\" & shuffleState & \"||\" & repeatState
                    end if
                end tell
            end if
            if application \"Music\" is running then
                tell application \"Music\"
                    if player state is playing or player state is paused then
                        set pos to player position
                        set dur to duration of current track
                        set albumName to album of current track
                        set vol to sound volume
                        set shuffleState to shuffle enabled
                        set repeatState to song repeat
                        return \"Music\" & \"||\" & (get artist of current track) & \"||\" & (get name of current track) & \"||NONE||\" & (player state as string) & \"||\" & pos & \"||\" & dur & \"||\" & albumName & \"||\" & vol & \"||\" & shuffleState & \"||\" & repeatState
                    end if
                end tell
            end if
            return \"\"
        ";

        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| e.to_string())?;

        let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if status.is_empty() {
            Err("Inactive".to_string())
        } else {
            Ok(status)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Media integration currently restricted to macOS environments.".to_string())
    }
}

pub(crate) async fn media_control_impl(command: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let command_parts: Vec<&str> = command.split(':').collect();
        let action = command_parts.first().copied().unwrap_or("");
        let value = command_parts.get(1).copied().unwrap_or("");

        let script = match action {
            "next" => "
                if application \"Spotify\" is running then tell application \"Spotify\" to next track
                if application \"Music\" is running then tell application \"Music\" to next track
            ".to_string(),
            "prev" => "
                if application \"Spotify\" is running then tell application \"Spotify\" to previous track
                if application \"Music\" is running then tell application \"Music\" to previous track
            ".to_string(),
            "playpause" => "
                if application \"Spotify\" is running then tell application \"Spotify\" to playpause
                if application \"Music\" is running then tell application \"Music\" to playpause
            ".to_string(),
            "seek" => {
                let seconds = value.parse::<f64>().map_err(|_| "Invalid seek target.".to_string())?;
                let clamped = seconds.max(0.0);
                format!("
                    if application \"Spotify\" is running then tell application \"Spotify\" to set player position to {clamped}
                    if application \"Music\" is running then tell application \"Music\" to set player position to {clamped}
                ")
            }
            "volume" => {
                let volume = value.parse::<i32>().map_err(|_| "Invalid volume.".to_string())?;
                let clamped = volume.clamp(0, 100);
                format!("
                    if application \"Spotify\" is running then tell application \"Spotify\" to set sound volume to {clamped}
                    if application \"Music\" is running then tell application \"Music\" to set sound volume to {clamped}
                ")
            }
            "shuffle" => "
                if application \"Spotify\" is running then tell application \"Spotify\" to set shuffling to not shuffling
                if application \"Music\" is running then tell application \"Music\" to set shuffle enabled to not shuffle enabled
            ".to_string(),
            "repeat" => "
                if application \"Spotify\" is running then
                    tell application \"Spotify\"
                        if repeating is off then
                            set repeating to all
                        else if repeating is all then
                            set repeating to one
                        else
                            set repeating to off
                        end if
                    end tell
                end if
                if application \"Music\" is running then
                    tell application \"Music\"
                        if song repeat is off then
                            set song repeat to all
                        else if song repeat is all then
                            set song repeat to one
                        else
                            set song repeat to off
                        end if
                    end tell
                end if
            ".to_string(),
            _ => return Err("Invalid media command.".to_string()),
        };

        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Media control restricted to macOS environments.".to_string())
    }
}
