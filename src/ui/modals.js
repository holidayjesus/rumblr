import { state, PRESETS, THEMES } from '../core/state.js';
import { ui } from './ui-engine.js';
import { invoke } from '../core/tauri.js';
import { saveAppConfig } from '../core/config-store.js';
import { sessionStore } from '../core/persistence.js';
import { getPerformanceSnapshot, INTERACTION_BUDGET_MS } from '../core/performance.js';
import { renderSidebar } from './sidebar.js';
import { clear, el } from './dom.js';
import { identiconUrl, syncProfileAvatarImages } from './avatar.js';

const MAX_PROFILE_AVATAR_BYTES = 1024 * 1024;
const RUNTIME_SETTING_IDS = new Set([
  "cfg-notification-mode",
  "cfg-notifications",
  "cfg-popup-alerts",
  "cfg-quiet-hours",
  "cfg-quiet-start",
  "cfg-quiet-end",
  "cfg-show-avatars",
  "cfg-show-system-messages",
  "cfg-show-join-part",
  "cfg-media-shader-visualizer",
  "cfg-timestamp-format",
  "cfg-max-messages",
  "cfg-gpu-accel",
  "cfg-rich-previews",
]);
let stagedProfileAvatarDataUrl = "";
let settingsSnapshot = null;

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

export async function openConfig() {
  ui.show("#options-panel");
  settingsSnapshot = cloneConfig(state.config);
  setSettingsSaveStatus("Changes preview immediately. Cancel restores the last saved state.", "idle");
  ui.val("#cfg-global-nick", state.config.global_nickname || "");
  ui.val("#cfg-global-alt-nick", state.config.global_alt_nickname || "");
  ui.val("#cfg-global-realname", state.config.global_realname || "");
  stagedProfileAvatarDataUrl = state.config.profile?.avatar_data_url || "";
  renderProfileAvatarPreview();
  ui.val("#cfg-max-messages", state.config.max_messages || 500);
  document.querySelector("#cfg-gpu-accel").checked = state.config.gpu_accel !== false;
  document.querySelector("#cfg-rich-previews").checked = state.config.rich_previews !== false;
  document.querySelector("#cfg-auto-reconnect").checked = state.config.auto_reconnect !== false;
  document.querySelector("#cfg-auto-connect").checked = state.config.auto_connect === true;
  document.querySelector("#cfg-notifications").checked = state.config.notifications_enabled !== false;
  document.querySelector("#cfg-multi-net").checked = state.config.multi_network === true;
  const display = state.config.display || {};
  document.querySelector("#cfg-show-avatars").checked = display.show_avatars !== false;
  document.querySelector("#cfg-show-system-messages").checked = display.show_system_messages !== false;
  document.querySelector("#cfg-show-join-part").checked = display.show_join_part !== false;
  document.querySelector("#cfg-media-shader-visualizer").checked = display.media_shader_visualizer === true;
  ui.val("#cfg-timestamp-format", display.timestamp_format || "24h");
  state.signalFilter = display.show_join_part === false;
  const rules = state.config.notification_rules || state.notificationRules;
  state.notificationRules = { ...state.notificationRules, ...rules, mutedBuffers: rules?.mutedBuffers || rules?.muted_buffers || {} };
  ui.val("#cfg-notification-mode", state.notificationRules.mode || "all");
  document.querySelector("#cfg-popup-alerts").checked = state.notificationRules.popupAlerts !== false && state.notificationRules.popup_alerts !== false;
  document.querySelector("#cfg-quiet-hours").checked = state.notificationRules.quietHours === true || state.notificationRules.quiet_hours === true;
  ui.val("#cfg-quiet-start", state.notificationRules.quietStart || state.notificationRules.quiet_start || "22:00");
  ui.val("#cfg-quiet-end", state.notificationRules.quietEnd || state.notificationRules.quiet_end || "08:00");
  renderThemePicker(sessionStore.getTheme(state.config.theme || "carbon"));
  syncSettingsControlAvailability();
  renderSettingsControlHints();
  renderPerformanceMetrics();
  
  state.tempServers = JSON.parse(JSON.stringify(state.config.servers || []));
  renderServerConfigList();
}

export function closeConfig({ restore = true } = {}) {
  if (restore && settingsSnapshot) {
    state.config = cloneConfig(settingsSnapshot);
    state.maxMessages = Number(state.config.max_messages) || state.maxMessages;
    state.signalFilter = state.config.display?.show_join_part === false;
    state.notificationRules = {
      mode: state.config.notification_rules?.mode || state.notificationRules.mode,
      quietHours: state.config.notification_rules?.quiet_hours ?? state.notificationRules.quietHours,
      quietStart: state.config.notification_rules?.quiet_start || state.notificationRules.quietStart,
      quietEnd: state.config.notification_rules?.quiet_end || state.notificationRules.quietEnd,
      popupAlerts: state.config.notification_rules?.popup_alerts ?? state.notificationRules.popupAlerts,
      mutedBuffers: state.config.notification_rules?.muted_buffers || state.notificationRules.mutedBuffers || {},
    };
    stagedProfileAvatarDataUrl = state.config.profile?.avatar_data_url || "";
    import('../core/config-applier.js').then(m => m.applyConfigToDom(state.config.theme, { persist: false }));
    syncProfileAvatarImages();
    renderSidebar();
    window.dispatchEvent(new CustomEvent("refresh-messages"));
    window.dispatchEvent(new CustomEvent("refresh-media-widget"));
  }
  settingsSnapshot = null;
  ui.hide("#options-panel");
}

function renderServerConfigList() {
  const container = document.querySelector("#server-config-list");
  if (!container) return;
  if (!state.tempServers.length) {
    clear(container);
    container.appendChild(el("div", { className: "settings-empty-state" }, [
      el("strong", { text: "No networks configured" }),
      el("span", { text: "Add Libera.Chat or another IRC network to get started." }),
    ]));
    return;
  }

  clear(container);
  state.tempServers.forEach((server, index) => {
    // Network definitions may come from imports or hand-edited config files,
    // so every label is written with textContent instead of template HTML.
    const actions = el("div", { className: "network-config-actions" }, [
      el("button", { className: "btn-text", type: "button", text: "Edit" }),
      el("button", { className: "btn-text danger", type: "button", text: "Remove" }),
    ]);
    actions.children[0].addEventListener("click", () => window.editNetwork(index));
    actions.children[1].addEventListener("click", () => window.removeNetwork(index));

    const autojoinCount = Array.isArray(server.autojoin) ? server.autojoin.length : 0;
    container.appendChild(el("div", { className: "network-config-row" }, [
      el("div", { className: "network-config-icon", text: (server.name || "?").slice(0, 1).toUpperCase() }),
      el("div", { className: "network-config-main" }, [
        el("strong", { text: server.name || "Unnamed network" }),
        el("span", { text: `${server.host || "No host"}:${server.port || "?"} ${server.use_ssl === false ? "Plain" : "TLS"}` }),
      ]),
      el("div", { className: "network-config-meta" }, [
        el("span", { text: autojoinCount ? `${autojoinCount} channels` : "No autojoin" }),
      ]),
      actions,
    ]));
  });
}

export async function saveConfig() {
  setSettingsSaveStatus("Saving settings...", "idle");
  state.config = {
    ...state.config,
    global_nickname: ui.val("#cfg-global-nick"),
    global_alt_nickname: ui.val("#cfg-global-alt-nick"),
    global_realname: ui.val("#cfg-global-realname"),
    profile: {
      ...(state.config.profile || {}),
      avatar_data_url: stagedProfileAvatarDataUrl,
    },
    servers: state.tempServers,
    max_messages: boundedMessageLimit(),
    gpu_accel: document.querySelector("#cfg-gpu-accel").checked,
    rich_previews: document.querySelector("#cfg-rich-previews").checked,
    auto_reconnect: document.querySelector("#cfg-auto-reconnect").checked,
    auto_connect: document.querySelector("#cfg-auto-connect").checked,
    notifications_enabled: document.querySelector("#cfg-notifications").checked,
    notification_rules: {
      mode: ui.val("#cfg-notification-mode") || "all",
      quiet_hours: document.querySelector("#cfg-quiet-hours").checked,
      quiet_start: ui.val("#cfg-quiet-start") || "22:00",
      quiet_end: ui.val("#cfg-quiet-end") || "08:00",
      popup_alerts: document.querySelector("#cfg-popup-alerts").checked,
      muted_buffers: state.notificationRules.mutedBuffers || {},
    },
    display: {
      show_avatars: document.querySelector("#cfg-show-avatars").checked,
      show_system_messages: document.querySelector("#cfg-show-system-messages").checked,
      show_join_part: document.querySelector("#cfg-show-join-part").checked,
      media_shader_visualizer: document.querySelector("#cfg-media-shader-visualizer").checked,
      timestamp_format: ui.val("#cfg-timestamp-format") || "24h",
    },
    multi_network: document.querySelector("#cfg-multi-net").checked,
    theme: document.querySelector(".theme-card.active")?.dataset.theme || state.config.theme || "carbon",
  };
  await saveAppConfig(state.config);
  import('../core/config-applier.js').then(m => m.applyConfigToDom(state.config.theme));
  setSettingsSaveStatus("Settings saved.", "ok");
  closeConfig({ restore: false });
  renderSidebar();
  syncProfileAvatarImages();
  window.dispatchEvent(new CustomEvent("refresh-messages"));
}

function setSettingsSaveStatus(message, tone = "idle") {
  const el = document.querySelector("#settings-save-status");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
}

function performanceMetricLabel(name) {
  const labels = {
    "interaction:composer-input:work": "Composer typing work",
    "interaction:composer-input:frame-ready": "Composer ready for frame",
    "interaction:composer-submit:button-lock": "Send button response",
    "interaction:composer-submit:send-ack": "Send acknowledgement",
    "interaction:buffer-switch:work": "Buffer switch work",
    "interaction:buffer-switch:frame-ready": "Buffer ready for frame",
    "interaction:message-refresh:work": "Message refresh work",
    "frameTask:composer-resize:work": "Composer resize task",
    "frameTask:refresh-messages:work": "Refresh messages task",
    "frameTask:messages-updated:work": "Hub/sidebar refresh task",
  };
  if (labels[name]) return labels[name];
  if (name.startsWith("renderMessages:")) return `Render ${name.replace("renderMessages:", "")}`;
  return name.replace(/[:_-]+/g, " ");
}

function renderPerformanceMetrics() {
  const container = document.querySelector("#performance-metrics");
  if (!container) return;
  const snapshot = getPerformanceSnapshot();
  const rows = Object.entries(snapshot)
    .filter(([name]) => (
      name.startsWith("interaction:")
      || name.startsWith("renderMessages:")
      || name.endsWith(":work")
    ))
    .sort(([, a], [, b]) => (b.max || 0) - (a.max || 0))
    .slice(0, 10);

  clear(container);
  if (!rows.length) {
    container.appendChild(el("div", { className: "settings-empty-state" }, [
      el("strong", { text: "No timing samples yet" }),
      el("span", { text: "Type, send, or switch buffers, then refresh this panel." }),
    ]));
    return;
  }

  rows.forEach(([name, metric]) => {
    const overBudget = Number(metric.max) > INTERACTION_BUDGET_MS && !name.endsWith(":frame-ready");
    // The settings panel is the user-facing perf scoreboard, so keep each row
    // stable and text-only. Details stay in `window.rumblrPerformance.snapshot()`.
    container.appendChild(el("div", { className: `performance-metric-row ${overBudget ? "over-budget" : ""}` }, [
      el("div", {}, [
        el("span", { className: "performance-metric-name", text: performanceMetricLabel(name) }),
        el("div", {
          className: "performance-metric-meta",
          text: `${metric.count} samples - avg ${metric.average}ms - max ${metric.max}ms - misses ${metric.budgetMisses || 0}`,
        }),
      ]),
      el("div", { className: "performance-metric-value", text: `${metric.last}ms` }),
    ]));
  });
}

function boundedMessageLimit() {
  const value = parseInt(ui.val("#cfg-max-messages"), 10);
  return Math.min(50000, Math.max(50, Number.isFinite(value) ? value : 500));
}

function isRuntimeSetting(target) {
  return target?.id && RUNTIME_SETTING_IDS.has(target.id);
}

function setControlDisabled(selector, disabled) {
  const control = document.querySelector(selector);
  if (!control) return;
  control.disabled = disabled;
  control.closest(".settings-field, .settings-toggle")?.classList.toggle("settings-control-disabled", disabled);
}

function syncSettingsControlAvailability() {
  const notificationsEnabled = document.querySelector("#cfg-notifications")?.checked !== false;
  const quietHoursEnabled = notificationsEnabled && document.querySelector("#cfg-quiet-hours")?.checked === true;
  setControlDisabled("#cfg-notification-mode", !notificationsEnabled);
  setControlDisabled("#cfg-popup-alerts", !notificationsEnabled);
  setControlDisabled("#cfg-quiet-hours", !notificationsEnabled);
  setControlDisabled("#cfg-quiet-start", !quietHoursEnabled);
  setControlDisabled("#cfg-quiet-end", !quietHoursEnabled);
}

function settingsHintForControl(control) {
  if (!control?.id) return "Save keeps it. Cancel restores.";
  if (control.id.startsWith("cfg-global")) return "Saved identity is used on the next IRC connection.";
  if (["cfg-auto-reconnect", "cfg-auto-connect", "cfg-multi-net"].includes(control.id)) return "Takes effect after Save on the next connection cycle.";
  if (control.id === "cfg-gpu-accel") return "Save keeps it; restart may be needed for full effect.";
  if (isRuntimeSetting(control)) return "Previews now. Save keeps it. Cancel restores.";
  return "Save keeps it. Cancel restores.";
}

function renderSettingsControlHints() {
  document.querySelectorAll("#options-panel input, #options-panel select, #options-panel textarea").forEach((control) => {
    if (control.type === "file" || control.hidden) return;
    const host = control.closest(".settings-field, .settings-toggle");
    if (!host || host.querySelector(":scope > .settings-control-hint")) return;
    const hint = document.createElement("small");
    hint.className = "settings-control-hint";
    hint.textContent = settingsHintForControl(control);
    host.appendChild(hint);
  });
}

function previewSettingsFromControls() {
  if (!state.config) return;
  syncSettingsControlAvailability();
  const display = {
    show_avatars: document.querySelector("#cfg-show-avatars")?.checked !== false,
    show_system_messages: document.querySelector("#cfg-show-system-messages")?.checked !== false,
    show_join_part: document.querySelector("#cfg-show-join-part")?.checked !== false,
    media_shader_visualizer: document.querySelector("#cfg-media-shader-visualizer")?.checked === true,
    timestamp_format: ui.val("#cfg-timestamp-format") || "24h",
  };
  const notificationRules = {
    mode: ui.val("#cfg-notification-mode") || "all",
    quietHours: document.querySelector("#cfg-quiet-hours")?.checked === true,
    quietStart: ui.val("#cfg-quiet-start") || "22:00",
    quietEnd: ui.val("#cfg-quiet-end") || "08:00",
    popupAlerts: document.querySelector("#cfg-popup-alerts")?.checked !== false,
    mutedBuffers: state.notificationRules?.mutedBuffers || {},
  };
  // Settings should feel immediate, even though Save is still the durability
  // boundary. Preview only UI/runtime-safe fields; identity/networks stay saved.
  state.config = {
    ...state.config,
    profile: {
      ...(state.config.profile || {}),
      avatar_data_url: stagedProfileAvatarDataUrl,
    },
    max_messages: boundedMessageLimit(),
    gpu_accel: document.querySelector("#cfg-gpu-accel")?.checked !== false,
    rich_previews: document.querySelector("#cfg-rich-previews")?.checked !== false,
    notifications_enabled: document.querySelector("#cfg-notifications")?.checked !== false,
    notification_rules: {
      mode: notificationRules.mode,
      quiet_hours: notificationRules.quietHours,
      quiet_start: notificationRules.quietStart,
      quiet_end: notificationRules.quietEnd,
      popup_alerts: notificationRules.popupAlerts,
      muted_buffers: notificationRules.mutedBuffers,
    },
    display,
  };
  state.maxMessages = Number(state.config.max_messages) || state.maxMessages;
  state.notificationRules = notificationRules;
  import('../core/config-applier.js').then(m => m.applyConfigToDom(state.config.theme, { persist: false }));
  syncProfileAvatarImages();
  window.dispatchEvent(new CustomEvent("refresh-messages"));
  window.dispatchEvent(new CustomEvent("refresh-media-widget"));
}


function settingsImpactMessage(target) {
  if (!target?.id) return "Unsaved changes.";
  if (target.id.startsWith("cfg-global")) return "Identity staged. Save and reconnect for IRC servers to use it.";
  if (["cfg-auto-reconnect", "cfg-auto-connect", "cfg-multi-net"].includes(target.id)) return "Startup behavior staged. Save to use it on the next connection cycle.";
  if (isRuntimeSetting(target)) return "Previewing changes. Save to keep them, or Cancel to restore.";
  return "Unsaved changes.";
}

function renderProfileAvatarPreview() {
  const preview = document.querySelector("#cfg-profile-avatar-preview");
  if (!preview) return;
  const nick = ui.val("#cfg-global-nick") || state.config?.global_nickname || "RumblrUser";
  preview.src = stagedProfileAvatarDataUrl || identiconUrl(nick);
}

function stageProfileAvatarFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setSettingsSaveStatus("Choose an image file for your avatar.", "dirty");
    return;
  }
  if (file.size > MAX_PROFILE_AVATAR_BYTES) {
    setSettingsSaveStatus("Avatar image must be 1 MB or smaller.", "dirty");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    stagedProfileAvatarDataUrl = typeof reader.result === "string" ? reader.result : "";
    renderProfileAvatarPreview();
    previewSettingsFromControls();
    setSettingsSaveStatus("Avatar staged. Save to keep it.", "dirty");
  };
  reader.onerror = () => setSettingsSaveStatus("Could not read that avatar image.", "dirty");
  reader.readAsDataURL(file);
}

function renderThemePicker(activeTheme) {
  const container = document.querySelector("#theme-picker");
  if (!container) return;
  clear(container);
  Object.entries(THEMES).forEach(([id, theme]) => {
    const colors = theme.vars;
    const previewAccent = el("span", {
      style: {
        background: colors["--media-accent"] || colors["--primary"],
        boxShadow: `0 0 10px ${colors["--media-accent-glow"] || colors["--primary-glow"]}`,
      },
    });
    const card = el("button", {
      className: `theme-card ${id === activeTheme ? "active" : ""}`,
      dataset: { theme: id },
      type: "button",
    }, [
      el("span", {
        className: "theme-preview",
        style: { background: colors["--bg-app"], borderColor: colors["--border"] },
      }, [
        el("span", { style: { background: colors["--bg-sidebar"] } }),
        el("span", { style: { background: colors["--surface"] } }),
        previewAccent,
      ]),
      el("span", { className: "theme-meta" }, [
        el("strong", { text: theme.name }),
        el("small", { text: theme.mood }),
      ]),
    ]);
    card.addEventListener("click", () => {
      container.querySelectorAll(".theme-card").forEach(el => el.classList.remove("active"));
      card.classList.add("active");
      state.config.theme = card.dataset.theme;
      import('../core/config-applier.js').then(m => m.applyTheme(card.dataset.theme, { persist: false }));
      setSettingsSaveStatus("Theme previewing. Save to keep it, or Cancel to restore.", "dirty");
    });
    container.appendChild(card);
  });
}

export function setupConfigTabs() {
  document.querySelectorAll(".modal-nav-item").forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;
      document.querySelectorAll(".modal-nav-item").forEach(el => el.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(el => {
        el.classList.remove("active");
        el.style.display = 'none';
      });
      item.classList.add("active");
      const pane = document.getElementById(target);
      if (pane) {
        pane.classList.add("active");
        pane.style.display = 'flex';
      }
    });
  });

  ui.on("#btn-add-network", "click", () => window.editNetwork(-1));
  ui.on("#btn-net-save", "click", saveNetwork);
  ui.on("#btn-net-test", "click", testNetwork);
  ui.on("#btn-net-cancel", "click", () => ui.hide("#network-editor-panel"));
  ui.on("#cfg-perf-refresh", "click", renderPerformanceMetrics);
  ui.on("#btn-nickserv-helper", "click", () => window.applyNickServHelper());
  ui.on("#btn-config-cancel", "click", closeConfig);
  ui.on("#btn-profile-avatar-upload", "click", () => document.querySelector("#cfg-profile-avatar-file")?.click());
  ui.on("#btn-profile-avatar-clear", "click", () => {
    stagedProfileAvatarDataUrl = "";
    renderProfileAvatarPreview();
    previewSettingsFromControls();
    setSettingsSaveStatus("Generated avatar staged. Save to keep it.", "dirty");
  });
  document.querySelector("#cfg-profile-avatar-file")?.addEventListener("change", (e) => {
    stageProfileAvatarFile(e.target.files?.[0]);
    e.target.value = "";
  });
  ui.on("#options-panel", "click", (e) => { if (e.target.id === "options-panel") closeConfig(); });
  ui.on("#network-editor-panel", "click", (e) => { if (e.target.id === "network-editor-panel") ui.hide("#network-editor-panel"); });
  document.querySelector("#options-panel")?.addEventListener("input", (e) => {
    if (e.target?.matches("input, select, textarea")) {
      if (e.target.id === "cfg-global-nick") renderProfileAvatarPreview();
      if (isRuntimeSetting(e.target)) {
        previewSettingsFromControls();
        setSettingsSaveStatus(settingsImpactMessage(e.target), "dirty");
      } else {
        setSettingsSaveStatus(settingsImpactMessage(e.target), "dirty");
      }
    }
  });
  document.querySelector("#options-panel")?.addEventListener("change", (e) => {
    if (e.target?.matches("input, select, textarea")) {
      syncSettingsControlAvailability();
      setSettingsSaveStatus(settingsImpactMessage(e.target), "dirty");
      if (isRuntimeSetting(e.target)) previewSettingsFromControls();
    }
  });
}

function renderPresets() {
  const container = document.querySelector("#preset-list");
  if (!container) return;
  clear(container);
  Object.entries(PRESETS).forEach(([id, preset]) => {
    const card = el("button", { className: "preset-card", type: "button" }, [
      el("div", { className: "preset-name", text: preset.name }),
      el("div", { className: "preset-host", text: preset.host }),
    ]);
    card.addEventListener("click", () => window.applyPreset(id));
    container.appendChild(card);
  });
}

window.applyPreset = (id) => {
  const p = PRESETS[id];
  if (!p) return;
  ui.val("#net-name", p.name);
  ui.val("#net-host", p.host);
  ui.val("#net-port", p.port);
  document.querySelector("#net-ssl").checked = p.ssl;
  ui.val("#net-autojoin", (p.autojoin || []).join(", "));
};

function setNetworkEditorStatus(message, tone = "idle") {
  const el = document.querySelector("#net-editor-status");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
}

function validateNetworkForm() {
  const host = ui.val("#net-host").trim();
  const port = parseInt(ui.val("#net-port"), 10);
  const ssl = document.querySelector("#net-ssl").checked;
  if (!ui.val("#net-name").trim()) return "Network name is required.";
  if (!host) return "Server host is required.";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
  if (!ssl && (port === 6697 || port === 7000)) return "That port is commonly TLS-only. Enable SSL/TLS or choose a plain port.";
  return "";
}

async function testNetwork() {
  const error = validateNetworkForm();
  if (error) {
    setNetworkEditorStatus(error, "warn");
    return;
  }
  setNetworkEditorStatus("Testing host, port, and TLS handshake...", "idle");
  try {
    const result = await invoke("test_network_connection", {
      host: ui.val("#net-host").trim(),
      port: parseInt(ui.val("#net-port"), 10),
      useSsl: document.querySelector("#net-ssl").checked,
    });
    setNetworkEditorStatus(result, "ok");
  } catch (e) {
    setNetworkEditorStatus(String(e), "warn");
  }
}

window.applyNickServHelper = () => {
  const password = ui.val("#net-nickserv-password").trim();
  if (!password) {
    setNetworkEditorStatus("Enter a NickServ password first.", "warn");
    return;
  }
  const current = ui.val("#net-perform").split("\n").map(l => l.trim()).filter(Boolean);
  const filtered = current.filter(line => !line.toLowerCase().includes("nickserv identify") && !line.toLowerCase().startsWith("/msg nickserv identify"));
  filtered.unshift(`/msg NickServ IDENTIFY ${password}`);
  ui.val("#net-perform", filtered.join("\n"));
  ui.val("#net-nickserv-password", "");
  setNetworkEditorStatus("NickServ identify command added to Auto-Perform.", "ok");
};

let editingNetIdx = -1;
window.editNetwork = (idx) => {
  editingNetIdx = idx;
  const s = idx === -1 ? { name: "", host: "", port: 6697, use_ssl: true, sasl_password: "", autojoin: [], perform: [] } : state.tempServers[idx];
  ui.show("#network-editor-panel");
  renderPresets();
  ui.val("#net-name", s.name);
  ui.val("#net-host", s.host);
  ui.val("#net-port", s.port);
  document.querySelector("#net-ssl").checked = s.use_ssl ?? s.ssl ?? true;
  ui.val("#net-sasl", s.sasl_password || "");
  ui.val("#net-autojoin", (s.autojoin || []).join(", "));
  ui.val("#net-perform", (s.perform || []).join("\n"));
  ui.val("#net-nick", s.nickname || "");
  ui.val("#net-realname", s.realname || "");
  setNetworkEditorStatus("Test the connection before applying profile changes.", "idle");
};

window.removeNetwork = (idx) => {
  state.tempServers.splice(idx, 1);
  renderServerConfigList();
};

async function saveNetwork() {
  const error = validateNetworkForm();
  if (error) {
    setNetworkEditorStatus(error, "warn");
    return;
  }
  const s = {
    id: editingNetIdx === -1 ? crypto.randomUUID() : state.tempServers[editingNetIdx].id,
    name: ui.val("#net-name"),
    host: ui.val("#net-host"),
    port: parseInt(ui.val("#net-port")),
    use_ssl: document.querySelector("#net-ssl").checked,
    sasl_password: ui.val("#net-sasl"),
    autojoin: ui.val("#net-autojoin").split(",").map(c => c.trim()).filter(c => c),
    perform: ui.val("#net-perform").split("\n").map(l => l.trim()).filter(l => l),
    nickname: ui.val("#net-nick") || null,
    realname: ui.val("#net-realname") || null,
  };
  if (editingNetIdx === -1) state.tempServers.push(s);
  else state.tempServers[editingNetIdx] = s;
  
  ui.hide("#network-editor-panel");
  setSettingsSaveStatus("Network profile staged. Save settings to persist it.", "idle");
  renderServerConfigList();
}
