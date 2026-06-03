//! Shared backend payloads sent between Rust and the webview.
//!
//! Keeping these shapes together makes the Tauri event contract easier to audit:
//! if the frontend listens for an event, the serializable payload should usually
//! live here rather than being hidden inside connection or window code.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct IrcMessage {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) content: String,
    pub(crate) timestamp: String,
    pub(crate) received_at: String,
    pub(crate) channel: String,
    pub(crate) server_id: String,
    pub(crate) msg_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct UserListUpdate {
    pub(crate) server_id: String,
    pub(crate) channel: String,
    pub(crate) users: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct UserEvent {
    pub(crate) server_id: String,
    pub(crate) channel: String,
    pub(crate) username: String,
    pub(crate) event_type: String,
    pub(crate) new_nick: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ChannelInfo {
    pub(crate) name: String,
    pub(crate) users: String,
    pub(crate) topic: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct ChannelListStatus {
    pub(crate) server_id: String,
    pub(crate) status: String,
    pub(crate) message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct NetworkStatus {
    pub(crate) server_id: String,
    pub(crate) status: String,
    pub(crate) message: String,
    pub(crate) retry_in: Option<u64>,
    pub(crate) attempt: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct DccOffer {
    pub(crate) server_id: String,
    pub(crate) from_nick: String,
    pub(crate) file_name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) size: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct DccTransfer {
    pub(crate) transfer_id: String,
    pub(crate) server_id: String,
    pub(crate) from_nick: String,
    pub(crate) file_name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) save_path: String,
    pub(crate) size: Option<u64>,
    pub(crate) bytes_received: u64,
    pub(crate) status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct DccTransferProgress {
    pub(crate) transfer_id: String,
    pub(crate) server_id: String,
    pub(crate) from_nick: String,
    pub(crate) file_name: String,
    pub(crate) save_path: Option<String>,
    pub(crate) size: Option<u64>,
    pub(crate) bytes_received: u64,
    pub(crate) percent: Option<f64>,
    pub(crate) status: String,
    pub(crate) message: String,
    pub(crate) error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct TypingUpdate {
    pub(crate) server_id: String,
    pub(crate) buffer: String,
    pub(crate) username: String,
    pub(crate) typing_state: String,
    pub(crate) received_at: String,
}
