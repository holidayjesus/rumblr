//! DCC/XDCC transfer backend.
//!
//! The `irc` crate delivers DCC as CTCP text (`DCC SEND ...`) inside IRC
//! messages. The file payload itself never travels through the IRC socket, so
//! Rumblr owns this direct TCP receiver, the legacy byte ACK loop, safe download
//! paths, cancellation, and progress events for the webview.

use crate::models::{DccOffer, DccTransfer, DccTransferProgress};
use std::collections::HashMap;
use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

pub(crate) type DccTransferRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const STALL_TIMEOUT: Duration = Duration::from_secs(90);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);
const READ_BUFFER_SIZE: usize = 64 * 1024;

pub(crate) async fn accept_dcc_offer_impl(
    app: AppHandle,
    transfers: DccTransferRegistry,
    offer: DccOffer,
) -> Result<DccTransfer, String> {
    if offer.port == 0 {
        return Err("Passive DCC offers are not supported yet.".to_string());
    }

    let host = resolve_dcc_host(&offer.host)?;
    let safe_file_name = sanitize_file_name(&offer.file_name);
    let save_dir = dcc_download_dir(&app)?;
    let save_path = unique_download_path(&save_dir, &safe_file_name);
    let transfer_id = make_transfer_id(&offer);
    let token = CancellationToken::new();

    {
        let mut active = transfers.lock().await;
        active.insert(transfer_id.clone(), token.clone());
    }

    let transfer = DccTransfer {
        transfer_id: transfer_id.clone(),
        server_id: offer.server_id.clone(),
        from_nick: offer.from_nick.clone(),
        file_name: safe_file_name.clone(),
        host: host.clone(),
        port: offer.port,
        save_path: save_path.to_string_lossy().to_string(),
        size: offer.size,
        bytes_received: 0,
        status: "connecting".to_string(),
    };

    let app_task = app.clone();
    let transfers_task = transfers.clone();
    let offer_task = offer.clone();
    tokio::spawn(async move {
        let result = receive_dcc_file(
            app_task.clone(),
            offer_task,
            transfer_id.clone(),
            safe_file_name,
            host,
            save_path,
            token,
        )
        .await;

        {
            let mut active = transfers_task.lock().await;
            active.remove(&transfer_id);
        }

        if let Err(error) = result {
            emit_progress(
                &app_task,
                DccTransferProgress {
                    transfer_id,
                    server_id: offer.server_id,
                    from_nick: offer.from_nick,
                    file_name: offer.file_name,
                    save_path: None,
                    size: offer.size,
                    bytes_received: 0,
                    percent: None,
                    status: "error".to_string(),
                    message: "DCC transfer failed.".to_string(),
                    error: Some(error),
                },
            );
        }
    });

    Ok(transfer)
}

pub(crate) async fn cancel_dcc_transfer_impl(
    transfers: DccTransferRegistry,
    transfer_id: String,
) -> Result<(), String> {
    let active = transfers.lock().await;
    if let Some(token) = active.get(&transfer_id) {
        token.cancel();
        Ok(())
    } else {
        Err("That DCC transfer is no longer active.".to_string())
    }
}

pub(crate) fn reveal_dcc_download_impl(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| error.to_string())
}

async fn receive_dcc_file(
    app: AppHandle,
    offer: DccOffer,
    transfer_id: String,
    file_name: String,
    host: String,
    save_path: PathBuf,
    token: CancellationToken,
) -> Result<(), String> {
    let addr = format!("{}:{}", host, offer.port);
    emit_progress(
        &app,
        progress_payload(
            &transfer_id,
            &offer,
            &file_name,
            Some(&save_path),
            0,
            "connecting",
            format!("Connecting to {}...", addr),
            None,
        ),
    );

    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| "DCC sender did not accept the connection in time.".to_string())?
        .map_err(|error| format!("DCC socket failed: {}", error))?;
    let mut file = tokio::fs::File::create(&save_path)
        .await
        .map_err(|error| format!("Could not create download file: {}", error))?;

    emit_progress(
        &app,
        progress_payload(
            &transfer_id,
            &offer,
            &file_name,
            Some(&save_path),
            0,
            "transferring",
            "Receiving DCC file...".to_string(),
            None,
        ),
    );

    let mut received = 0_u64;
    let mut buffer = vec![0_u8; READ_BUFFER_SIZE];
    let mut last_emit = Instant::now();

    loop {
        if offer.size.is_some_and(|size| received >= size) {
            break;
        }

        let read_result = tokio::select! {
            _ = token.cancelled() => {
                let _ = tokio::fs::remove_file(&save_path).await;
                emit_progress(
                    &app,
                    progress_payload(
                        &transfer_id,
                        &offer,
                        &file_name,
                        Some(&save_path),
                        received,
                        "cancelled",
                        "DCC transfer cancelled.".to_string(),
                        None,
                    ),
                );
                return Ok(());
            }
            result = timeout(STALL_TIMEOUT, stream.read(&mut buffer)) => result,
        };

        let bytes_read = read_result
            .map_err(|_| "DCC transfer stalled while waiting for data.".to_string())?
            .map_err(|error| format!("DCC read failed: {}", error))?;

        if bytes_read == 0 {
            if offer.size.is_some_and(|size| received < size) {
                return Err("DCC sender closed before the advertised size arrived.".to_string());
            }
            break;
        }

        file.write_all(&buffer[..bytes_read])
            .await
            .map_err(|error| format!("Could not write DCC download: {}", error))?;
        received += bytes_read as u64;

        // Classic DCC SEND expects a four-byte big-endian ACK containing the
        // cumulative received byte count. It is intentionally sent after each
        // chunk so old XDCC bots keep feeding the socket.
        let ack = (received as u32).to_be_bytes();
        stream
            .write_all(&ack)
            .await
            .map_err(|error| format!("DCC ACK failed: {}", error))?;

        if last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL
            || offer.size.is_some_and(|size| received >= size)
        {
            emit_progress(
                &app,
                progress_payload(
                    &transfer_id,
                    &offer,
                    &file_name,
                    Some(&save_path),
                    received,
                    "transferring",
                    "Receiving DCC file...".to_string(),
                    None,
                ),
            );
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("Could not finalize DCC download: {}", error))?;
    emit_progress(
        &app,
        progress_payload(
            &transfer_id,
            &offer,
            &file_name,
            Some(&save_path),
            received,
            "complete",
            "DCC transfer complete.".to_string(),
            None,
        ),
    );
    Ok(())
}

fn dcc_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    path.push("Rumblr");
    path.push("DCC");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn emit_progress(app: &AppHandle, payload: DccTransferProgress) {
    let _ = app.emit("dcc-transfer-progress", payload);
}

fn progress_payload(
    transfer_id: &str,
    offer: &DccOffer,
    file_name: &str,
    save_path: Option<&Path>,
    bytes_received: u64,
    status: &str,
    message: String,
    error: Option<String>,
) -> DccTransferProgress {
    let percent = offer
        .size
        .filter(|size| *size > 0)
        .map(|size| ((bytes_received as f64 / size as f64) * 100.0).min(100.0));
    DccTransferProgress {
        transfer_id: transfer_id.to_string(),
        server_id: offer.server_id.clone(),
        from_nick: offer.from_nick.clone(),
        file_name: file_name.to_string(),
        save_path: save_path.map(|path| path.to_string_lossy().to_string()),
        size: offer.size,
        bytes_received,
        percent,
        status: status.to_string(),
        message,
        error,
    }
}

pub(crate) fn resolve_dcc_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("DCC host is missing.".to_string());
    }
    if trimmed.contains('.') || trimmed.contains(':') {
        return Ok(trimmed.to_string());
    }
    let numeric = trimmed
        .parse::<u32>()
        .map_err(|_| "DCC host is not a valid IPv4 address or integer.".to_string())?;
    Ok(Ipv4Addr::from(numeric).to_string())
}

pub(crate) fn sanitize_file_name(file_name: &str) -> String {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("dcc-download");
    let mut clean = base
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    clean.truncate(160);
    if clean.trim().is_empty() {
        "dcc-download".to_string()
    } else {
        clean
    }
}

fn unique_download_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("dcc-download");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value))
        .unwrap_or_default();

    for index in 1..10_000 {
        let next = dir.join(format!("{} ({}){}", stem, index, extension));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!(
        "{}-{}",
        stem,
        chrono::Utc::now().timestamp_millis()
    ))
}

fn make_transfer_id(offer: &DccOffer) -> String {
    let nick = offer
        .from_nick
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(24)
        .collect::<String>();
    format!("dcc-{}-{}", chrono::Utc::now().timestamp_millis(), nick)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_integer_dcc_host_to_ipv4() {
        assert_eq!(resolve_dcc_host("2130706433").unwrap(), "127.0.0.1");
    }

    #[test]
    fn keeps_dotted_or_ipv6_host_as_supplied() {
        assert_eq!(resolve_dcc_host("192.0.2.25").unwrap(), "192.0.2.25");
        assert_eq!(resolve_dcc_host("2001:db8::1").unwrap(), "2001:db8::1");
    }

    #[test]
    fn sanitizes_path_traversal_and_platform_delimiters() {
        assert_eq!(
            sanitize_file_name("../secret:file?.zip"),
            "secret_file_.zip"
        );
        assert_eq!(sanitize_file_name(""), "dcc-download");
    }
}
