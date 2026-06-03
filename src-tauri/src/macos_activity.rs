//! macOS process activity helpers.
//!
//! IRC needs a small native hint while a socket is active. Without it, App Nap
//! can throttle background timers hard enough that the IRC crate misses its own
//! keepalive window and reconnects an otherwise healthy session.

#[cfg(target_os = "macos")]
mod platform {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::sync::Once;

    static IRC_ACTIVITY: Once = Once::new();

    pub(crate) fn begin_irc_network_activity_once() {
        IRC_ACTIVITY.call_once(|| {
            let reason = NSString::from_str("Rumblr active IRC connection");
            let process = NSProcessInfo::processInfo();
            let activity = process.beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &reason,
            );

            // Keep the token alive for this app session. The option still lets
            // the Mac sleep normally, but it keeps IRC networking out of App
            // Nap's low-priority timer bucket while Rumblr is running.
            std::mem::forget(activity);
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub(crate) fn begin_irc_network_activity_once() {}
}

pub(crate) use platform::begin_irc_network_activity_once;
