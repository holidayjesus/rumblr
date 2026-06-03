export function connectionFallbackMessage(status) {
  if (status === "online") return "Connected";
  if (status === "connecting") return "Working...";
  if (status === "retrying") return "Retrying...";
  if (status === "failed") return "Connection failed.";
  return "Offline";
}

export function connectionDetailMessage(appState, serverId, status) {
  const detail = appState.netDetails?.[String(serverId)];
  // Runtime status is the authority for controls. Persisted health details can
  // survive restarts or canceled reconnects, so only show their text when the
  // detail status agrees with the current status that drives the button.
  if (detail?.status === status && detail.message) return detail.message;
  return connectionFallbackMessage(status);
}

export function setRuntimeNetworkStatus(appState, serverId, status, message = "") {
  const sid = String(serverId);
  appState.netStatus[sid] = status;
  const detail = appState.netDetails[sid] || { server_id: sid };
  const keepExistingMessage = !message && detail.status === status && detail.message;
  appState.netDetails[sid] = {
    ...detail,
    server_id: sid,
    status,
    message: keepExistingMessage ? detail.message : (message || connectionFallbackMessage(status)),
    updated_at: Date.now(),
  };
  return sid;
}

export function recordNetworkTraffic(appState, serverId, message = "Connected; receiving IRC traffic.") {
  const sid = String(serverId || "");
  if (!sid || sid === "global") return { sid, reconciled: false };
  const wasOnline = appState.netStatus?.[sid] === "online" && appState.netDetails?.[sid]?.status === "online";
  const detail = appState.netDetails[sid] || { server_id: sid };
  // Incoming IRC events are the strongest frontend-side proof that the socket
  // is alive. Store that proof without making every chat line rerender chrome.
  appState.netStatus[sid] = "online";
  appState.netDetails[sid] = {
    ...detail,
    server_id: sid,
    status: "online",
    message: message || detail.message || connectionFallbackMessage("online"),
    updated_at: Date.now(),
    last_rx_at: Date.now(),
  };
  return { sid, reconciled: !wasOnline };
}

export function shouldReconcileLiveTraffic(appState, serverId) {
  const sid = String(serverId || "");
  if (!sid || sid === "global") return false;
  return appState.netStatus[sid] !== "online" || appState.netDetails?.[sid]?.status !== "online";
}
