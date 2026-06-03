import { boot } from './core/boot.js';
import { ui, setupGlobalErrorHandler, focusInput, notify } from './ui/ui-engine.js';
import { handleCommand } from './services/irc.js';
import { setupSidebarResizer, selectChannel, renderUserList } from './ui/sidebar.js';
import { openConfig, closeConfig, saveConfig, setupConfigTabs } from './ui/modals.js';
import { state, norm } from './core/state.js';
import { emit, invoke, listen } from './core/tauri.js';
import { sessionStore } from './core/persistence.js';
import { applyTheme } from './core/config-applier.js';
import { serverLabel } from './core/buffers.js';
import { closeChannelBrowser, openChannelBrowser, renderChannelBrowser } from './ui/channel-browser.js';
import { markAllAttentionRead, openMentionsCenter, renderMentionsCenter, syncAttentionButton } from './ui/attention-center.js';
import { applyMessagesHubSnapshot, hydrateMessagesWindowState, openMessagesConversation, openMessagesPanel, syncMessengerPresence } from './ui/messages-window.js';
import { renderMessages, renderChannelList, formatTimestamp } from './ui/messages.js';
import { setComposerValue, setupComposer } from './ui/composer.js';
import { createSwitcher } from './ui/buffer-switcher.js';
import { finishInteraction, finishInteractionOnFrame, getPerformanceSnapshot, scheduleFrameTask, startInteraction, startInteractionMonitor } from './core/performance.js';
import { syncProfileAvatarImages } from './ui/avatar.js';
import { setupOnboarding, maybeOpenOnboarding } from './ui/onboarding.js';
import { setupYoutubePopoutLinks } from './ui/youtube-popout.js';
import { setupDccUi } from './ui/dcc.js';

setupGlobalErrorHandler();
startInteractionMonitor();
setupYoutubePopoutLinks();
setupProductionMenuGuards();
window.rumblrPerformance = {
  snapshot: getPerformanceSnapshot,
};

function setupProductionMenuGuards() {
  document.addEventListener("contextmenu", (event) => {
    if (!event.target?.closest?.(".ctx-menu")) event.preventDefault();
  }, { capture: true });

  window.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    const inspectShortcut = event.key === "F12"
      || ((event.metaKey || event.ctrlKey) && event.altKey && ["i", "j", "c"].includes(key))
      || ((event.metaKey || event.ctrlKey) && ["u"].includes(key));
    if (inspectShortcut) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });
}

const attentionHandlers = {
  openConversation: openMessagesConversation,
  switchBuffer: (serverId, buffer) => window.switchBuffer(serverId, buffer),
};

let bufferSwitcher = null;

function getActiveServerLabel() {
  return serverLabel(state, state.activeServer);
}

function currentInboxSnapshot() {
  // Keep this payload small and explicit: the Messages window needs only the
  // current message map, unread map, and active network to rebuild its hub.
  return {
    messages: state.messages,
    unreads: state.unreads,
    activeServer: String(state.activeServer || ""),
    sentAt: Date.now(),
  };
}

function saveCurrentInboxSnapshot() {
  const snapshot = currentInboxSnapshot();
  sessionStore.saveMessageSnapshot(snapshot.messages);
  sessionStore.saveInboxSnapshot(snapshot);
  return snapshot;
}

async function openMessagesWindow() {
  saveCurrentInboxSnapshot();
  sessionStore.flush();
  await invoke("open_messages_window").catch(() => openMessagesPanel());
}

function prepareTrafficLightControls() {
  // Tauri drag regions can swallow clicks if a control inherits draggable
  // chrome behavior. Normalize every traffic-light cluster before binding.
  const labels = [
    ["close", "Close"],
    ["minimize", "Minimize"],
    ["maximize", "Zoom"],
  ];
  document.querySelectorAll(".traffic-lights").forEach((group) => {
    group.removeAttribute("data-tauri-drag-region");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", group.getAttribute("aria-label") || "Window controls");
  });
  document.querySelectorAll(".traffic-lights .dot").forEach((control) => {
    control.setAttribute("role", "button");
    control.tabIndex = 0;
    if (!control.getAttribute("aria-label")) {
      const [, label] = labels.find(([className]) => control.classList.contains(className)) || ["", "Window control"];
      control.setAttribute("aria-label", label);
    }
  });
}

function bindTrafficLightControl(selector, handler) {
  document.querySelectorAll(selector).forEach((control) => {
    const run = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await handler(event);
      } catch (error) {
        console.warn("[Rumblr] Window control failed", error);
      }
    };

    control.addEventListener("click", run);
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") run(event);
    });
  });
}


function recentLinesForBuffer(serverId, channel, limit = 8) {
  const buffers = state.messages?.[serverId] || {};
  const rows = Object.entries(buffers)
    .filter(([key]) => norm(key) === norm(channel))
    .flatMap(([, msgs]) => msgs || [])
    .slice(-limit);
  return rows.map((m) => {
    const time = (m.timestamp || "").split(":").slice(0, 2).join(":");
    return `[${formatTimestamp(m.received_at || m.timestamp) || time || "--:--"}] ${m.username || "System"}: ${m.content || ""}`;
  });
}

async function copyShareText(kind = "current") {
  const serverId = String(state.activeServer || "");
  const channel = state.activeChannel || "system";
  const title = kind === "messages" ? "Rumblr Messages" : `Rumblr ${channel}`;
  const lines = kind === "messages"
    ? Object.entries(state.messages?.[serverId] || {})
      .filter(([key]) => !key.startsWith("#") && !key.startsWith("&"))
      .flatMap(([key, msgs]) => recentLinesForBuffer(serverId, key, 3).map((line) => `${key}  ${line}`))
      .slice(-12)
    : recentLinesForBuffer(serverId, channel, 12);
  const text = [`${title}`, `Network: ${serverId || "none"}`, "", ...(lines.length ? lines : ["No recent lines."])].join("\n");
  await navigator.clipboard?.writeText(text);
  notify("Copied share summary");
}

window.addEventListener("DOMContentLoaded", () => {
  console.log("[SYSTEM] DOMContentLoaded fired. Booting workstation...");
  const params = new URLSearchParams(window.location.search);
  const isMessagesWindow = params.get("view") === "messages";

  if (isMessagesWindow) document.body.classList.add("messages-window");

  boot().then(() => {
    setupSidebarResizer();
    setupConfigTabs();
    setupOnboarding();
    listen("native-share-current", () => copyShareText("current")).catch(() => { });
    listen("native-share-messages", () => copyShareText("messages")).catch(() => { });
    if (isMessagesWindow) {
      listen("inbox-sync", (event) => {
        applyMessagesHubSnapshot(event?.payload || {});
        openMessagesPanel();
      }).catch(() => { });
      // Storage restore is a fallback. This request gives the standalone hub a
      // fresh in-memory snapshot from the main chat window when it opens.
      emit("request-inbox-sync", { requestedAt: Date.now() }).catch(() => { });
    } else {
      listen("request-inbox-sync", () => {
        emit("inbox-sync", saveCurrentInboxSnapshot()).catch(() => { });
      }).catch(() => { });
    }
    hydrateMessagesWindowState();
    syncProfileAvatarImages();
    syncAttentionButton();
    if (isMessagesWindow) openMessagesPanel();
    else {
      focusInput();
      maybeOpenOnboarding();
    }
    console.log("[SYSTEM] Workstation initialized.");
  });

  // Global exports for inline handlers
  window.handleCommand = handleCommand;
  window.openConfig = openConfig;
  window.selectChannel = selectChannel;
  window.state = state;
  window.handleActionChip = (cmd) => setComposerValue(`${cmd} `);

  // Button Bindings
  // Static shell controls are wired here instead of inline HTML attributes so
  // window chrome and modal buttons follow the same event path as rendered UI.
  prepareTrafficLightControls();
  setupDccUi();
  bindTrafficLightControl("[data-hide-panel]", (event) => ui.hide(event.currentTarget.dataset.hidePanel));
  ui.on("#btn-profile-config", "click", openConfig);
  ui.on("#btn-open-options", "click", openConfig);
  ui.on("#btn-config-cancel", "click", closeConfig);
  ui.on("#btn-config-save", "click", saveConfig);
  ui.on("#btn-net-cancel", "click", () => ui.hide("#network-editor-panel"));
  ui.on(".header-plus", "click", () => openChannelBrowser({ refresh: true }));
  bindTrafficLightControl("#channel-browser-close", closeChannelBrowser);
  ui.on("#channel-browser-panel", "click", (e) => { if (e.target.id === "channel-browser-panel") closeChannelBrowser(); });
  ui.on("#channel-browser-refresh", "click", () => openChannelBrowser({ refresh: true }));
  ui.on("#channel-browser-search", "input", renderChannelBrowser);
  ui.on("#buffer-switcher", "click", (e) => {
    if (e.target.id === "buffer-switcher") ui.hide("#buffer-switcher");
  });
  bufferSwitcher = createSwitcher({
    getServerLabel: getActiveServerLabel,
    openMessagesWindow,
    openChannelBrowser,
    openConfig,
    copyShareText,
    clearSearch: () => {
      state.searchQuery = "";
      renderMessages(state.activeServer, state.activeChannel);
    },
    switchBuffer: (serverId, buffer) => window.switchBuffer(serverId, buffer),
    openMessagesConversation,
    setComposerValue,
  });
  setupComposer({
    openSwitcher: () => bufferSwitcher?.open(),
    closePanels: () => {
      closeConfig();
      ui.hide("#about-modal");
      ui.hide("#buffer-switcher");
      ui.hide("#mentions-panel");
    },
  });

  // About Modal
  const openAbout = () => {
    ui.show("#about-modal");
  };
  ui.on(".brand-footer", "click", openAbout);
  listen("open-about", openAbout);


  ui.on("#about-modal", "click", (e) => {
    if (e.target.id === 'about-modal') ui.hide("#about-modal");
  });
  ui.on("#btn-open-messages", "click", async () => {
    await openMessagesWindow();
  });
  ui.on("#btn-open-mentions", "click", () => openMentionsCenter(attentionHandlers));
  ui.on("#mentions-read-all", "click", () => {
    markAllAttentionRead();
    renderMentionsCenter(attentionHandlers);
  });
  ui.on("#mentions-close", "click", () => ui.hide("#mentions-panel"));
  ui.on("#mentions-panel", "click", (e) => {
    if (e.target.id === "mentions-panel") ui.hide("#mentions-panel");
  });
  ui.on("#messages-panel", "click", (e) => {
    if (!document.body.classList.contains("messages-window") && e.target.id === 'messages-panel') ui.hide("#messages-panel");
  });
  ui.on("#messages-presence-select", "change", async (e) => {
    const next = e.target.value;
    if (window.setRumblrPresence) await window.setRumblrPresence(next);
    else {
      state.presence = next;
      sessionStore.setPresence(next);
      await invoke("set_presence_status", { status: next }).catch(() => { });
      window.dispatchEvent(new CustomEvent("presence-updated", { detail: next }));
    }
    syncMessengerPresence();
  });

  // SASL Toggle
  ui.on("#toggle-sasl-view", "click", () => {
    const input = document.querySelector("#net-sasl");
    const trigger = document.querySelector("#toggle-sasl-view");
    if (input.type === "password") { input.type = "text"; trigger.textContent = "HIDE"; }
    else { input.type = "password"; trigger.textContent = "SHOW"; }
  });

  // Window Controls (Traffic Lights)
  bindTrafficLightControl("#win-close", () => invoke("close_window"));
  bindTrafficLightControl("#win-minimize", () => invoke("minimize_window"));
  bindTrafficLightControl("#win-maximize", () => invoke("toggle_maximize_window"));
  bindTrafficLightControl("#messages-win-close", async () => {
    if (document.body.classList.contains("messages-window")) await invoke("close_window");
    else ui.hide("#messages-panel");
  });
  bindTrafficLightControl("#messages-win-minimize", async () => {
    if (document.body.classList.contains("messages-window")) await invoke("minimize_window");
    else ui.hide("#messages-panel");
  });
  bindTrafficLightControl("#messages-win-maximize", async () => {
    if (!document.body.classList.contains("messages-window")) {
      document.querySelector(".messages-modal-content")?.classList.toggle("expanded");
      return;
    }
    await invoke("toggle_maximize_window");
  });
  document.querySelector(".messages-profile-action")?.addEventListener("click", () => {
    openMessagesPanel();
    setTimeout(() => window.dispatchEvent(new CustomEvent("messages-compose")), 0);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      bufferSwitcher?.open();
    }
    if (e.key === "Escape") {
      ui.hide("#mentions-panel");
      ui.hide("#buffer-switcher");
      ui.hide("#options-panel");
      closeChannelBrowser();
      const switcher = document.querySelector("#buffer-switcher");
      if (switcher?.style.display === "flex") ui.hide("#buffer-switcher");
    }
    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === "m") { e.preventDefault(); openMessagesWindow(); }
      if (key === "n") { e.preventDefault(); openMentionsCenter(attentionHandlers); }
      if (key === "r") { e.preventDefault(); openChannelBrowser({ refresh: true }); }
    }
  });

});

window.switchBuffer = (srvId, name) => {
  const mark = startInteraction("buffer-switch", { serverId: String(srvId || ""), buffer: String(name || "") });
  try {
    selectChannel(srvId, name);
    document.querySelector("#buffer-switcher").style.display = 'none';
  } finally {
    finishInteraction(mark, "work");
    finishInteractionOnFrame(mark);
  }
};

window.addEventListener("refresh-messages", () => {
  const mark = startInteraction("message-refresh", { channel: state.activeChannel });
  scheduleFrameTask("refresh-messages", () => {
    try {
      renderMessages(state.activeServer, state.activeChannel);
      refreshSecondaryAttentionSurfaces();
    } finally {
      finishInteraction(mark, "work");
      finishInteractionOnFrame(mark);
    }
  });
});

window.addEventListener("messages-updated", () => {
  scheduleFrameTask("messages-updated", refreshSecondaryAttentionSurfaces);
});

function refreshSecondaryAttentionSurfaces() {
  syncAttentionButton();
  const panel = document.querySelector("#messages-panel");
  if (panel && panel.style.display === "flex") openMessagesPanel();
  const mentionsPanel = document.querySelector("#mentions-panel");
  if (mentionsPanel && mentionsPanel.style.display === "flex") renderMentionsCenter(attentionHandlers);
}

window.addEventListener("presence-updated", (e) => {
  state.presence = e.detail || state.presence;
  syncMessengerPresence();
});

window.addEventListener("pagehide", () => {
  // Last-chance local persistence catches quiet exits where no new message or
  // channel switch happened after the user changed window/session state.
  saveCurrentInboxSnapshot();
  sessionStore.saveRuntimeSession(state);
  sessionStore.flush();
});

window.addEventListener("refresh-sidebar", syncAttentionButton);

window.addEventListener("message-popup-open", (event) => {
  const { serverId, buffer } = event.detail || {};
  if (!buffer) return;
  if (String(buffer).startsWith("#") || String(buffer).startsWith("&")) {
    window.switchBuffer(serverId || state.activeServer, buffer);
    return;
  }
  openMessagesConversation(buffer, serverId || state.activeServer);
});

window.addEventListener("storage", (e) => {
  if (sessionStore.isPresenceStorageEvent(e)) {
    state.presence = e.newValue;
    syncMessengerPresence();
  }
  if (sessionStore.isThemeStorageEvent(e)) {
    applyTheme(e.newValue, { persist: false });
  }
  if (
    document.body.classList.contains("messages-window") &&
    (sessionStore.isMessagesOpenRequestEvent(e) || sessionStore.isInboxSnapshotEvent(e) || sessionStore.isMessageSnapshotEvent(e))
  ) {
    hydrateMessagesWindowState({ force: true });
    openMessagesPanel();
  }
});

window.addEventListener("refresh-list-view", () => {
  if (document.body.classList.contains("messages-window")) return;
  renderChannelBrowser();
  if (state.activeChannel === '(LIST)') renderChannelList();
});

listen("open-mentions", () => openMentionsCenter(attentionHandlers));
listen("open-browse", () => openChannelBrowser({ refresh: true }));

window.addEventListener("refresh-user-list", () => {
  renderUserList();
});
