import { state, norm } from '../core/state.js';
import { invoke } from '../core/tauri.js';

const ACTIVE_REPEAT_MS = 4500;
const PAUSED_AFTER_MS = 3200;
const ACTIVE_EXPIRES_MS = 9000;
const PAUSED_EXPIRES_MS = 5500;

let pauseTimer = null;
let lastOutbound = { key: "", serverId: "", buffer: "", typingState: "done", sentAt: 0 };
const expiryTimers = new Map();

function typingKey(serverId, buffer) {
  return `${serverId}:${norm(buffer)}`;
}

export function isTypingTarget(buffer) {
  const target = String(buffer || "").trim();
  if (!target || target === "system" || target.startsWith("(") || target.startsWith("*")) return false;
  return !/[\s\r\n\0:,]/.test(target);
}

function refreshTyping(serverId, buffer) {
  window.dispatchEvent(new CustomEvent("typing-state-changed", {
    detail: { serverId: String(serverId || ""), buffer: String(buffer || "") },
  }));
}

function clearExpiryTimer(key, username) {
  const timerKey = `${key}:${norm(username)}`;
  const timer = expiryTimers.get(timerKey);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(timerKey);
}

function scheduleExpiry(serverId, buffer, username, timeoutMs) {
  const key = typingKey(serverId, buffer);
  clearExpiryTimer(key, username);
  const timerKey = `${key}:${norm(username)}`;
  expiryTimers.set(timerKey, setTimeout(() => {
    clearTypingUser(serverId, buffer, username);
  }, timeoutMs));
}

export function clearTypingUser(serverId, buffer, username) {
  const key = norm(buffer);
  const userKey = norm(username);
  if (!state.typing?.[serverId]?.[key]?.[userKey]) return;
  delete state.typing[serverId][key][userKey];
  clearExpiryTimer(typingKey(serverId, buffer), username);
  refreshTyping(serverId, buffer);
}

export function handleTypingUpdate(update = {}) {
  const serverId = String(update.server_id || update.serverId || "");
  const buffer = String(update.buffer || "");
  const username = String(update.username || "");
  const typingState = String(update.typing_state || update.typingState || "").toLowerCase();
  if (!serverId || !isTypingTarget(buffer) || !username) return;
  if (typingState === "done") {
    clearTypingUser(serverId, buffer, username);
    return;
  }
  if (typingState !== "active" && typingState !== "paused") return;

  const bufferKey = norm(buffer);
  const userKey = norm(username);
  if (!state.typing[serverId]) state.typing[serverId] = {};
  if (!state.typing[serverId][bufferKey]) state.typing[serverId][bufferKey] = {};
  state.typing[serverId][bufferKey][userKey] = {
    username,
    typingState,
    expiresAt: Date.now() + (typingState === "active" ? ACTIVE_EXPIRES_MS : PAUSED_EXPIRES_MS),
  };
  scheduleExpiry(serverId, buffer, username, typingState === "active" ? ACTIVE_EXPIRES_MS : PAUSED_EXPIRES_MS);
  refreshTyping(serverId, buffer);
}

// Renderers consume a pruned, sorted view so expired indicators never leak
// into chat panes and active typists always outrank paused ones.
export function typingEntriesForBuffer(serverId, buffer) {
  const bucket = state.typing?.[serverId]?.[norm(buffer)] || {};
  const now = Date.now();
  return Object.entries(bucket)
    .filter(([userKey, entry]) => {
      const alive = entry?.expiresAt > now;
      if (!alive) {
        delete bucket[userKey];
        clearExpiryTimer(typingKey(serverId, buffer), entry?.username || userKey);
      }
      return alive;
    })
    .map(([, entry]) => ({
      username: entry.username,
      typingState: entry.typingState === "paused" ? "paused" : "active",
    }))
    .filter((entry) => entry.username)
    .sort((a, b) => {
      if (a.typingState !== b.typingState) return a.typingState === "active" ? -1 : 1;
      return a.username.localeCompare(b.username);
    })
    .slice(0, 5);
}

export function typingUsersForBuffer(serverId, buffer) {
  return typingEntriesForBuffer(serverId, buffer).map((entry) => entry.username);
}

export function typingLabelForUsers(users = [], activity = "typing") {
  const singleVerb = activity === "paused" ? "paused typing" : `is ${activity}`;
  const pluralVerb = activity === "paused" ? "paused typing" : `are ${activity}`;
  if (users.length === 1) return `${users[0]} ${singleVerb}`;
  if (users.length === 2) return `${users[0]} and ${users[1]} ${pluralVerb}`;
  if (users.length > 2) return `${users[0]}, ${users[1]}, and ${users.length - 2} others ${pluralVerb}`;
  return "";
}

export function typingSummaryForBuffer(serverId, buffer) {
  const entries = typingEntriesForBuffer(serverId, buffer);
  const active = entries.filter((entry) => entry.typingState === "active");
  const paused = entries.filter((entry) => entry.typingState === "paused");
  const selected = active.length ? active : paused;
  const tone = active.length ? "active" : "paused";
  const users = selected.map((entry) => entry.username);
  return {
    tone,
    users,
    label: typingLabelForUsers(users, tone === "paused" ? "paused" : "typing"),
  };
}

export function sendTypingStateForBuffer(serverId, buffer, typingState, { force = false } = {}) {
  if (!serverId || !isTypingTarget(buffer)) return;
  const key = typingKey(serverId, buffer);
  const now = Date.now();
  if (!force && lastOutbound.key === key && lastOutbound.typingState === typingState && now - lastOutbound.sentAt < ACTIVE_REPEAT_MS) {
    return;
  }
  lastOutbound = { key, serverId: String(serverId), buffer: String(buffer), typingState, sentAt: now };
  invoke("send_irc_typing_state", {
    serverId: String(serverId),
    channel: String(buffer),
    typingState,
  }).catch(() => {});
}

export function notifyBufferTyping(serverId, buffer, value) {
  if (pauseTimer) clearTimeout(pauseTimer);

  const targetKey = typingKey(serverId, buffer);
  if (lastOutbound.key && lastOutbound.key !== targetKey && lastOutbound.typingState !== "done") {
    sendTypingStateForBuffer(lastOutbound.serverId, lastOutbound.buffer, "done", { force: true });
  }

  const text = String(value || "");
  const isCommand = text.trimStart().startsWith("/");
  if (!text.trim() || isCommand || !isTypingTarget(buffer)) {
    if (lastOutbound.key === targetKey && lastOutbound.typingState !== "done") {
      sendTypingStateForBuffer(serverId, buffer, "done", { force: true });
    }
    return;
  }

  sendTypingStateForBuffer(serverId, buffer, "active");
  pauseTimer = setTimeout(() => {
    if (lastOutbound.key === targetKey && lastOutbound.typingState === "active") {
      sendTypingStateForBuffer(serverId, buffer, "paused", { force: true });
    }
  }, PAUSED_AFTER_MS);
}

export function notifyComposerTyping(value) {
  notifyBufferTyping(state.activeServer, state.activeChannel, value);
}
