import { cancelIdle, requestIdle } from './performance.js';

const KEYS = {
  activeServer: "rumblr_active_server",
  inboxSnapshot: "rumblr_inbox_snapshot",
  messageSnapshot: "rumblr_message_snapshot",
  messagesOpenRequest: "rumblr_messages_open_request",
  onboardingComplete: "rumblr_onboarding_complete",
  presence: "rumblr_presence",
  sessionState: "rumblr_session_state_v1",
  theme: "rumblr_theme",
  youtubePopoutLayout: "rumblr_youtube_popout_layout",
};

function readJson(key, fallback = {}) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

export const SNAPSHOT_MESSAGES_PER_BUFFER = 1500;
export const INBOX_MESSAGES_PER_BUFFER = 400;

export function compactMessageMap(messages = {}, limit = SNAPSHOT_MESSAGES_PER_BUFFER) {
  const cap = Math.max(1, Number(limit) || SNAPSHOT_MESSAGES_PER_BUFFER);
  return Object.fromEntries(Object.entries(messages || {}).map(([serverId, buffers]) => [
    serverId,
    Object.fromEntries(Object.entries(buffers || {}).map(([bufferName, rows]) => [
      bufferName,
      Array.isArray(rows) ? rows.slice(-cap) : [],
    ])),
  ]));
}

export function compactUnreadMap(unreads = {}) {
  const compact = {};
  Object.entries(unreads || {}).forEach(([serverId, buffers]) => {
    const nextBuffers = {};
    Object.entries(buffers || {}).forEach(([bufferName, value]) => {
      if (bufferName.endsWith(":mention")) return;
      if (typeof value === "number" && value > 0) {
        nextBuffers[bufferName] = value;
        if (buffers[`${bufferName}:mention`]) nextBuffers[`${bufferName}:mention`] = true;
      }
    });
    if (Object.keys(nextBuffers).length) compact[serverId] = nextBuffers;
  });
  return compact;
}

function resolveDeferredValue(value) {
  return typeof value === "function" ? value() : value;
}

const deferredWrites = new Map();
let deferredHandle = null;

function writeJsonDeferred(key, value) {
  deferredWrites.set(key, value);
  if (!deferredHandle) {
    // Message/session snapshots can be large. Queue them outside input and
    // message handlers so typing, buffer switching, and popups can paint first.
    deferredHandle = requestIdle(flushDeferredWrites, 900);
  }
  return true;
}

function flushDeferredWrites() {
  deferredHandle = null;
  const writes = [...deferredWrites.entries()];
  deferredWrites.clear();
  writes.forEach(([key, value]) => writeJson(key, resolveDeferredValue(value)));
}

export const sessionStore = {
  keys: KEYS,

  setActiveServer(serverId) {
    if (serverId) localStorage.setItem(KEYS.activeServer, String(serverId));
  },

  isOnboardingComplete() {
    return localStorage.getItem(KEYS.onboardingComplete) === "true";
  },

  setOnboardingComplete(done = true) {
    localStorage.setItem(KEYS.onboardingComplete, done ? "true" : "false");
  },

  getPresence(fallback = "online") {
    return localStorage.getItem(KEYS.presence) || fallback;
  },

  setPresence(status) {
    localStorage.setItem(KEYS.presence, status || "online");
  },

  getTheme(fallback = "") {
    return localStorage.getItem(KEYS.theme) || fallback;
  },

  setTheme(themeId) {
    if (themeId) localStorage.setItem(KEYS.theme, themeId);
  },

  getYoutubePopoutLayout() {
    return readJson(KEYS.youtubePopoutLayout, {});
  },

  setYoutubePopoutLayout(layout = {}) {
    return writeJson(KEYS.youtubePopoutLayout, layout);
  },

  flush() {
    if (deferredHandle) {
      cancelIdle(deferredHandle);
      deferredHandle = null;
    }
    flushDeferredWrites();
  },

  getSessionState() {
    return readJson(KEYS.sessionState, {});
  },

  saveSessionState({
    activeServer = "",
    activeChannel = "",
    openNetworks = [],
    joinedBuffers = {},
    unreads = {},
    netDetails = {},
    windowLayout = {},
  } = {}) {
    // This is deliberately a compact UI/session snapshot, not scrollback
    // storage. Messages still use their dedicated snapshots so restore logic
    // can evolve independently from connection/window state.
    return writeJsonDeferred(KEYS.sessionState, {
      activeServer,
      activeChannel,
      openNetworks,
      joinedBuffers,
      unreads: compactUnreadMap(unreads),
      netDetails,
      windowLayout,
      savedAt: Date.now(),
    });
  },

  saveRuntimeSession(state) {
    const servers = state.config?.servers || [];
    return this.saveSessionState({
      activeServer: String(state.activeServer || ""),
      activeChannel: state.activeChannel || "",
      openNetworks: Object.entries(state.netStatus || {})
        .filter(([, status]) => status === "online" || status === "connecting" || status === "retrying")
        .map(([serverId]) => String(serverId)),
      // The sidebar only restores real channel buffers. Service/DM buffers
      // live in the Messages Hub snapshots and should not become autojoin rows.
      joinedBuffers: Object.fromEntries(servers.map((server) => [
        String(server.id),
        (server.autojoin || []).filter((buffer) => typeof buffer === "string" && (buffer.startsWith("#") || buffer.startsWith("&"))),
      ])),
      unreads: state.unreads || {},
      netDetails: state.netDetails || {},
      windowLayout: {
        sidebarWidth: document.querySelector(".sidebar")?.style.width || "",
      },
    });
  },

  getMessageSnapshot() {
    return readJson(KEYS.messageSnapshot, {});
  },

  saveMessageSnapshot(messages) {
    // Keep restore useful without letting huge channel scrollback turn idle
    // persistence into a multi-frame JSON stringify spike. Full chat history
    // still belongs in server logs, not localStorage session snapshots.
    return writeJsonDeferred(KEYS.messageSnapshot, () => compactMessageMap(messages || {}, SNAPSHOT_MESSAGES_PER_BUFFER));
  },

  getInboxSnapshot() {
    return readJson(KEYS.inboxSnapshot, {});
  },

  saveInboxSnapshot({ messages = {}, unreads = {}, activeServer = "" } = {}) {
    return writeJsonDeferred(KEYS.inboxSnapshot, () => ({
      messages: compactMessageMap(messages || {}, INBOX_MESSAGES_PER_BUFFER),
      unreads: compactUnreadMap(unreads),
      activeServer,
      savedAt: Date.now(),
    }));
  },

  getMessagesOpenRequest() {
    return readJson(KEYS.messagesOpenRequest, {});
  },

  setMessagesOpenRequest(request) {
    return writeJson(KEYS.messagesOpenRequest, request || {});
  },

  consumeMessagesOpenRequest({ maxAgeMs = 15000 } = {}) {
    const request = this.getMessagesOpenRequest();
    localStorage.removeItem(KEYS.messagesOpenRequest);
    const requestedAt = Number(request?.requestedAt) || 0;
    if (!requestedAt || Date.now() - requestedAt > maxAgeMs) return {};
    return request;
  },

  isPresenceStorageEvent(event) {
    return event?.key === KEYS.presence && Boolean(event.newValue);
  },

  isThemeStorageEvent(event) {
    return event?.key === KEYS.theme && Boolean(event.newValue);
  },

  isMessagesOpenRequestEvent(event) {
    return event?.key === KEYS.messagesOpenRequest && Boolean(event.newValue);
  },

  isInboxSnapshotEvent(event) {
    return event?.key === KEYS.inboxSnapshot && Boolean(event.newValue);
  },

  isMessageSnapshotEvent(event) {
    return event?.key === KEYS.messageSnapshot && Boolean(event.newValue);
  },

  isSessionStateEvent(event) {
    return event?.key === KEYS.sessionState && Boolean(event.newValue);
  },
};
