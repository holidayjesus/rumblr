import { state } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { ui } from './ui-engine.js';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function setStatus(selector, message, tone = "idle") {
  const status = document.querySelector(selector);
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function setOfferButtonState(stateName) {
  const accept = document.querySelector("#dcc-offer-accept");
  const decline = document.querySelector("#dcc-offer-decline");
  const cancel = document.querySelector("#dcc-transfer-cancel");
  const reveal = document.querySelector("#dcc-transfer-reveal");

  if (accept) accept.style.display = stateName === "pending" ? "inline-flex" : "none";
  if (decline) decline.textContent = stateName === "complete" || stateName === "error" ? "Close" : "Decline";
  if (cancel) cancel.style.display = stateName === "active" ? "inline-flex" : "none";
  if (reveal) reveal.style.display = stateName === "complete" ? "inline-flex" : "none";
}

function updateProgress(bytesReceived = 0, size = null, percent = null) {
  const fill = document.querySelector("#dcc-progress-fill");
  const label = document.querySelector("#dcc-progress-label");
  const safePercent = typeof percent === "number"
    ? Math.max(0, Math.min(100, percent))
    : (size ? Math.max(0, Math.min(100, (Number(bytesReceived) / Number(size)) * 100)) : 0);
  if (fill) fill.style.width = `${safePercent}%`;
  if (label) {
    label.textContent = size
      ? `${formatBytes(bytesReceived)} / ${formatBytes(size)}`
      : `${formatBytes(bytesReceived)} received`;
  }
}

export function openDccPanel(nick) {
  state.dccTargetNick = nick;
  ui.show("#dcc-panel");
  ui.set("#dcc-target-nick", nick || "No nick selected");
  ui.val("#xdcc-bot", nick || "");
  ui.val("#xdcc-pack", "");
  setStatus("#dcc-status", "Ready.", "idle");
  setTimeout(() => document.querySelector("#xdcc-pack")?.focus(), 0);
}

function closeDccPanel() {
  ui.hide("#dcc-panel");
}

async function requestXdccPack() {
  const bot = ui.val("#xdcc-bot").trim();
  const pack = ui.val("#xdcc-pack").trim().replace(/^#/, "");
  if (!bot || !pack) {
    setStatus("#dcc-status", "Enter a bot nick and pack number.", "warn");
    return;
  }

  try {
    await invoke("send_irc_message", {
      serverId: String(state.activeServer),
      channel: bot,
      content: `XDCC SEND #${pack}`,
    });
    setStatus("#dcc-status", `Requested pack #${pack} from ${bot}.`, "ok");
  } catch (error) {
    setStatus("#dcc-status", `XDCC request failed: ${error}`, "warn");
  }
}

export function showDccOffer(offer) {
  if (!offer || document.body.classList.contains("messages-window")) return;
  state.pendingDccOffer = offer;
  state.activeDccTransferId = "";
  state.activeDccSavePath = "";
  ui.set("#dcc-offer-file", offer.file_name || "DCC file");
  ui.set("#dcc-offer-from", offer.from_nick || "Unknown sender");
  ui.set("#dcc-offer-size", formatBytes(offer.size));
  ui.set("#dcc-offer-host", `${offer.host || "unknown"}:${offer.port || ""}`);
  updateProgress(0, offer.size, 0);
  setStatus("#dcc-offer-status", "Ready to receive.", "idle");
  setOfferButtonState("pending");
  ui.show("#dcc-offer-panel");
}

function closeDccOffer() {
  state.pendingDccOffer = null;
  state.activeDccTransferId = "";
  state.activeDccSavePath = "";
  ui.hide("#dcc-offer-panel");
}

async function acceptDccOffer() {
  const offer = state.pendingDccOffer;
  if (!offer) {
    setStatus("#dcc-offer-status", "No DCC offer is active.", "warn");
    return;
  }

  setOfferButtonState("active");
  setStatus("#dcc-offer-status", "Connecting to sender...", "idle");
  try {
    const transfer = await invoke("accept_dcc_offer", { offer });
    state.activeDccTransferId = transfer.transfer_id;
    state.activeDccSavePath = transfer.save_path;
    updateProgress(0, transfer.size, 0);
  } catch (error) {
    setOfferButtonState("error");
    setStatus("#dcc-offer-status", String(error), "warn");
  }
}

async function cancelActiveTransfer() {
  const transferId = state.activeDccTransferId;
  if (!transferId) {
    closeDccOffer();
    return;
  }
  try {
    await invoke("cancel_dcc_transfer", { transferId });
    setStatus("#dcc-offer-status", "Cancelling transfer...", "warn");
  } catch (error) {
    setStatus("#dcc-offer-status", String(error), "warn");
  }
}

async function revealDownload() {
  const path = state.activeDccSavePath;
  if (!path) return;
  await invoke("reveal_dcc_download", { path }).catch((error) => {
    setStatus("#dcc-offer-status", String(error), "warn");
  });
}

export function handleDccTransferProgress(progress) {
  if (!progress?.transfer_id) return;
  if (state.activeDccTransferId && progress.transfer_id !== state.activeDccTransferId) return;
  state.activeDccTransferId = progress.transfer_id;
  if (progress.save_path) state.activeDccSavePath = progress.save_path;

  updateProgress(progress.bytes_received, progress.size, progress.percent);
  if (progress.status === "complete") {
    setOfferButtonState("complete");
    setStatus("#dcc-offer-status", `Saved to ${progress.save_path || "Downloads/Rumblr/DCC"}.`, "ok");
  } else if (progress.status === "cancelled") {
    setOfferButtonState("error");
    setStatus("#dcc-offer-status", "Transfer cancelled.", "warn");
  } else if (progress.status === "error") {
    setOfferButtonState("error");
    setStatus("#dcc-offer-status", progress.error || progress.message || "Transfer failed.", "warn");
  } else {
    setOfferButtonState("active");
    setStatus("#dcc-offer-status", progress.message || "Receiving DCC file...", "idle");
  }
}

export function setupDccUi() {
  ui.on("#dcc-panel", "click", (event) => {
    if (event.target.id === "dcc-panel") closeDccPanel();
  });
  ui.on("#dcc-offer-panel", "click", (event) => {
    if (event.target.id === "dcc-offer-panel") closeDccOffer();
  });
  ui.on("#dcc-panel-close", "click", closeDccPanel);
  ui.on("#dcc-panel-minimize", "click", closeDccPanel);
  ui.on("#dcc-offer-close", "click", closeDccOffer);
  ui.on("#dcc-offer-minimize", "click", closeDccOffer);
  ui.on("#xdcc-request", "click", requestXdccPack);
  ui.on("#dcc-offer-accept", "click", acceptDccOffer);
  ui.on("#dcc-offer-decline", "click", closeDccOffer);
  ui.on("#dcc-transfer-cancel", "click", cancelActiveTransfer);
  ui.on("#dcc-transfer-reveal", "click", revealDownload);

  window.openDccPanel = openDccPanel;
  window.closeDccPanel = closeDccPanel;
  window.requestXdccPack = requestXdccPack;
  window.closeDccOffer = closeDccOffer;
  window.declineDccOffer = closeDccOffer;
  window.acceptDccOffer = acceptDccOffer;
}
