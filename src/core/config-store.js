import { state } from './state.js';
import { invoke } from './tauri.js';

const DEFAULT_SERVERS = [
  { id: 'libera', name: 'Libera.Chat', host: 'irc.libera.chat', port: 6697, use_ssl: true, autojoin: ["#rumblr"] },
  { id: 'snoonet', name: 'Snoonet', host: 'irc.snoonet.org', port: 6667, use_ssl: false, autojoin: ["#snoonet"] },
  { id: 'efnet', name: 'EFNet', host: 'irc.efnet.org', port: 6667, use_ssl: false, autojoin: ["#efnet"] },
];

const NOTIFICATION_MODES = new Set(["all", "mentions", "dms", "off"]);
const TIMESTAMP_FORMATS = new Set(["24h", "seconds24", "12h", "hidden"]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function stableServerId(server, index) {
  return String(server.id || server.name || server.host || `network-${index + 1}`);
}

function normalizeServer(server, index) {
  const next = { ...server };
  next.id = stableServerId(next, index);
  next.name = next.name || next.host || next.id;
  next.host = next.host || "";
  next.use_ssl = next.use_ssl ?? next.ssl ?? true;
  next.port = Number(next.port) || (next.use_ssl === false ? 6667 : 6697);
  next.autojoin = Array.isArray(next.autojoin) ? next.autojoin : [];

  if (next.id === "libera" && next.host === "irc.libera.chat" && next.port === 6667 && next.use_ssl === false) {
    // Older dev builds downgraded Libera to plaintext 6667. Normalize that
    // saved shape back to Libera's stable TLS endpoint before it reaches Rust.
    next.port = 6697;
    next.use_ssl = true;
  }

  delete next.ssl;
  return next;
}

function normalizeDisplay(config) {
  const display = config.display || {};
  config.display = {
    show_avatars: display.show_avatars !== false,
    show_system_messages: display.show_system_messages !== false,
    show_join_part: display.show_join_part !== false,
    media_shader_visualizer: display.media_shader_visualizer === true,
    timestamp_format: TIMESTAMP_FORMATS.has(display.timestamp_format) ? display.timestamp_format : "24h",
  };
}

function normalizeNotificationRules(config) {
  const rules = config.notification_rules || {};
  const mode = NOTIFICATION_MODES.has(rules.mode) ? rules.mode : "dms";
  config.notification_rules = {
    mode,
    quiet_hours: rules.quiet_hours ?? rules.quietHours ?? state.notificationRules.quietHours,
    quiet_start: rules.quiet_start || rules.quietStart || state.notificationRules.quietStart,
    quiet_end: rules.quiet_end || rules.quietEnd || state.notificationRules.quietEnd,
    popup_alerts: rules.popup_alerts ?? rules.popupAlerts ?? state.notificationRules.popupAlerts,
    muted_buffers: rules.muted_buffers || rules.mutedBuffers || {},
  };
}

function normalizeProfile(config) {
  const profile = config.profile || {};
  config.profile = {
    avatar_data_url: typeof profile.avatar_data_url === "string" ? profile.avatar_data_url : "",
  };
}

export function normalizeConfig(rawConfig = {}) {
  const config = { ...rawConfig };
  config.global_nickname = config.global_nickname || "RumblrUser";
  config.global_alt_nickname = config.global_alt_nickname || `${config.global_nickname}_`;
  // Settings can be imported or hand-edited. Clamp here before the UI and Rust
  // backend see them so every control starts from a meaningful value.
  config.max_messages = clamp(Number(config.max_messages) || 500, 50, 50000);
  config.servers = (Array.isArray(config.servers) && config.servers.length ? config.servers : DEFAULT_SERVERS).map(normalizeServer);
  normalizeDisplay(config);
  normalizeNotificationRules(config);
  normalizeProfile(config);
  return config;
}

export function applyConfigToState(config) {
  state.config = config;
  state.maxMessages = Number(config.max_messages) || state.maxMessages;
  state.signalFilter = config.display?.show_join_part === false;
  state.notificationRules = {
    mode: config.notification_rules.mode,
    quietHours: config.notification_rules.quiet_hours,
    quietStart: config.notification_rules.quiet_start,
    quietEnd: config.notification_rules.quiet_end,
    popupAlerts: config.notification_rules.popup_alerts,
    mutedBuffers: config.notification_rules.muted_buffers,
  };
}

export async function saveAppConfig(config = state.config) {
  const normalized = normalizeConfig(config);
  applyConfigToState(normalized);
  await invoke("save_config", { config: normalized });
  return normalized;
}

export async function loadAppConfig() {
  const loaded = await invoke("load_config");
  const normalized = normalizeConfig(loaded);
  applyConfigToState(normalized);
  if (JSON.stringify(loaded) !== JSON.stringify(normalized)) {
    await saveAppConfig(normalized);
  }
  return normalized;
}
