import { state } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { serverLabel } from '../core/buffers.js';
import { ui } from './ui-engine.js';
import { handleCommand } from '../services/irc.js';
import { clear, el } from './dom.js';

const LIST_REQUEST_DEBOUNCE_MS = 2500;
const LIST_STALL_MS = 20000;
let lastListRequestAt = 0;
let listRequestTimeout = 0;

function isAuxiliaryWindow() {
  return document.body.classList.contains("messages-window");
}

function isChannelBrowserOpen() {
  const panel = document.querySelector("#channel-browser-panel");
  return Boolean(panel && (panel.style.display === "flex" || panel.classList.contains("active")));
}

export function renderChannelBrowser() {
  if (isAuxiliaryWindow()) return;
  if (!isChannelBrowserOpen()) return;
  const resultsEl = document.querySelector("#channel-browser-results");
  const countEl = document.querySelector("#channel-browser-count");
  const statusEl = document.querySelector("#channel-browser-status");
  const networkEl = document.querySelector("#channel-browser-network");
  const searchEl = document.querySelector("#channel-browser-search");
  const refreshEl = document.querySelector("#channel-browser-refresh");
  if (!resultsEl) return;

  const query = (searchEl?.value || "").trim().toLowerCase();
  const rows = [...(state.channelListResults || [])]
    .filter((c) => !query || c.name?.toLowerCase().includes(query) || (c.topic || "").toLowerCase().includes(query))
    .sort((a, b) => (parseInt(b.users, 10) || 0) - (parseInt(a.users, 10) || 0));

  if (networkEl) networkEl.textContent = serverLabel(state, state.activeServer);
  if (countEl) countEl.textContent = `${state.channelListResults?.length || 0}`;
  if (statusEl) statusEl.textContent = state.channelListError ? "Blocked" : state.isListing ? "Scanning" : "Ready";
  if (refreshEl) {
    refreshEl.disabled = Boolean(state.isListing);
    refreshEl.setAttribute("aria-busy", state.isListing ? "true" : "false");
  }

  if (state.isListing && rows.length === 0) {
    renderChannelBrowserEmpty(resultsEl, "Scanning channels", "Results will appear as the network sends them.");
    return;
  }

  if (state.channelListError && rows.length === 0) {
    renderChannelBrowserEmpty(resultsEl, "Channel list unavailable", state.channelListError);
    return;
  }

  if (rows.length === 0) {
    renderChannelBrowserEmpty(
      resultsEl,
      state.channelListStatusMessage ? "No channels returned" : "No channels found",
      state.channelListStatusMessage || "Refresh the list or adjust your search."
    );
    return;
  }

  clear(resultsEl);
  rows.slice(0, 500).forEach((channel) => {
    const channelName = channel.name || "";
    const row = el("button", { className: "channel-browser-row", type: "button" }, [
      el("div", { className: "channel-browser-row-main" }, [
        el("div", { className: "channel-browser-row-title" }, [
          el("span", { text: channelName }),
          el("strong", { text: `${parseInt(channel.users, 10) || 0} users` }),
        ]),
        el("div", { className: "channel-browser-topic", text: channel.topic || "No topic set" }),
      ]),
      el("div", { className: "channel-browser-join", text: "Join" }),
    ]);

    // /LIST topics are fully network-controlled text, so channel rows avoid
    // data attributes and HTML strings entirely.
    row.addEventListener("click", async () => {
      if (!channelName) return;
      await handleCommand(`/join ${channelName}`);
      closeChannelBrowser();
    });
    resultsEl.appendChild(row);
  });
}

function renderChannelBrowserEmpty(container, title, message) {
  clear(container);
  container.appendChild(el("div", { className: "channel-browser-empty" }, [
    el("strong", { text: title }),
    el("span", { text: message }),
  ]));
}

export async function openChannelBrowser({ refresh = false } = {}) {
  if (isAuxiliaryWindow()) return;
  ui.show("#channel-browser-panel", "flex");
  renderChannelBrowser();
  document.querySelector("#channel-browser-search")?.focus();

  const hasCachedRows = (state.channelListResults || []).length > 0;
  const shouldRequestList = !state.isListing && (refresh || !hasCachedRows);
  if (!shouldRequestList) return;
  const now = Date.now();
  if (now - lastListRequestAt < LIST_REQUEST_DEBOUNCE_MS) {
    state.channelListStatusMessage = "Waiting a moment before asking the network again.";
    renderChannelBrowser();
    return;
  }

  // A server LIST reply also emits list-start/list-item events. This function
  // is the only place that should ask for /LIST, otherwise incoming rows can
  // recursively reopen the browser and start the scan again.
  lastListRequestAt = now;
  state.channelListResults = [];
  state.isListing = true;
  state.channelListError = "";
  state.channelListStatusMessage = "Requesting channel list...";
  renderChannelBrowser();
  clearTimeout(listRequestTimeout);
  listRequestTimeout = setTimeout(() => {
    if (state.isListing && (state.channelListResults || []).length === 0) {
      state.isListing = false;
      state.channelListError = "The network did not answer LIST. Try Refresh List again in a moment.";
      state.channelListStatusMessage = state.channelListError;
      renderChannelBrowser();
    }
  }, LIST_STALL_MS);
  await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: "/list" }).catch(() => {
    state.isListing = false;
    state.channelListError = "Could not send LIST to the connected network.";
    state.channelListStatusMessage = state.channelListError;
    renderChannelBrowser();
  });
}

export function closeChannelBrowser() {
  ui.hide("#channel-browser-panel");
}
