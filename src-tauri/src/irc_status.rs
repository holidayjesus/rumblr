//! IRC connection status policy.
//!
//! Keep retry timing and status wording out of the connection loop so the loop
//! can eventually move into `irc_connection.rs` without dragging policy details
//! along with it.

const MAX_RECONNECT_DELAY_SECONDS: u32 = 30;
const RECONNECT_BACKOFF_STEP_SECONDS: u32 = 5;

pub(crate) fn reconnect_delay(attempt: u32) -> u32 {
    std::cmp::min(
        MAX_RECONNECT_DELAY_SECONDS,
        attempt * RECONNECT_BACKOFF_STEP_SECONDS,
    )
}

pub(crate) fn should_reconnect(auto_reconnect: bool, cancelled: bool) -> bool {
    auto_reconnect && !cancelled
}

pub(crate) fn reconnect_status_message(delay_seconds: u32) -> String {
    format!("Retrying in {delay_seconds} seconds...")
}

pub(crate) fn stream_ended_message(network_name: &str, registered: bool) -> String {
    let phase = if registered {
        "after registration"
    } else {
        "before IRC welcome"
    };
    format!("{network_name} stream ended {phase}; reconnect policy will decide next step.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_delay_uses_capped_linear_backoff() {
        assert_eq!(reconnect_delay(1), 5);
        assert_eq!(reconnect_delay(2), 10);
        assert_eq!(reconnect_delay(6), 30);
        assert_eq!(reconnect_delay(99), 30);
    }

    #[test]
    fn stream_end_message_names_registration_phase() {
        assert!(stream_ended_message("Libera.Chat", false).contains("before IRC welcome"));
        assert!(stream_ended_message("Libera.Chat", true).contains("after registration"));
    }

    #[test]
    fn reconnect_policy_respects_user_cancel_and_auto_reconnect() {
        assert!(should_reconnect(true, false));
        assert!(!should_reconnect(false, false));
        assert!(!should_reconnect(true, true));
    }

    #[test]
    fn retry_status_message_is_stable_for_frontend_state() {
        assert_eq!(reconnect_status_message(30), "Retrying in 30 seconds...");
    }
}
