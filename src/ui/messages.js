import { state, norm } from '../core/state.js';
import { ui } from './ui-engine.js';
import { showMessageMenu, showNickMenu } from './context-menu.js';
import { emit, invoke } from '../core/tauri.js';
import { sessionStore } from '../core/persistence.js';
import { canonicalServiceBufferName, isDirectBuffer, isServiceBuffer } from '../core/buffers.js';
import { showMessagePopup } from './message-popup.js';
import { appendFormattedContent, formattedContentElement } from './message-content.js';
import { measureTask, scheduleFrameTask } from '../core/performance.js';
import { avatarUrlForNick, isSelfNick as isConfiguredSelfNick } from './avatar.js';
import { typingSummaryForBuffer } from '../services/typing.js';

export const getNickColor = (nick) => {
  let hash = 0; const cleanNick = (nick || "").replace(/^[@+&%~]+/, "");
  for (let i = 0; i < cleanNick.length; i++) hash = cleanNick.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash % 360)}, 70%, 75%)`;
};

export function formatTimestamp(value = new Date()) {
  const format = state.config?.display?.timestamp_format || "24h";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const fallback = String(value || "");
    return fallback.split(":").slice(0, 2).join(":");
  }
  if (format === "hidden") return "";
  if (format === "seconds24") return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (format === "12h") return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

const makeDateSeparator = (dateLabel) => {
  const el = document.createElement('div');
  el.className = 'date-separator';
  const pill = document.createElement("div");
  pill.className = "date-pill";
  pill.textContent = dateLabel;
  el.appendChild(pill);
  return el;
};

const bufferKey = (serverId, channel) => `${serverId}:${norm(channel)}`;
const INITIAL_MESSAGE_RENDER_LIMIT = 260;
const MESSAGE_RENDER_INCREMENT = 260;
export const MESSAGE_VIRTUALIZATION_THRESHOLD = 1200;
const VIRTUAL_ROW_ESTIMATE_PX = 96;
const VIRTUAL_ROW_MIN_PX = 44;
const VIRTUAL_ROW_MAX_PX = 132;
// Keep the virtual window intentionally lean: enough overscan for smooth wheel
// motion, but small enough that huge channels still switch buffers inside one
// interaction frame on normal hardware.
const VIRTUAL_OVERSCAN_ROWS = 1;
const VIRTUAL_MIN_VISIBLE_ROWS = 10;

function isSelfNick(serverId, username) {
  return isConfiguredSelfNick(serverId, username);
}

function canonicalizeBuffer(serverId, channel) {
  const displayName = isServiceBuffer(channel) ? canonicalServiceBufferName(channel) : channel;
  const nBuffer = norm(displayName);
  if (!state.messages[serverId]) state.messages[serverId] = {};
  for (const key of Object.keys(state.messages[serverId])) {
    if (key !== nBuffer && norm(key) === nBuffer) {
      state.messages[serverId][nBuffer] = [
        ...(state.messages[serverId][nBuffer] || []),
        ...(state.messages[serverId][key] || []),
      ];
      delete state.messages[serverId][key];
    }
  }
  return nBuffer;
}

const getDateLabel = (msg) => {
  const date = msg.received_at ? new Date(msg.received_at) : new Date();
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

let _audioCtx = null;
function playMentionSound() {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain); gain.connect(_audioCtx.destination);
    osc.type = 'sine'; osc.frequency.setValueAtTime(880, _audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, _audioCtx.currentTime + 0.5);
    osc.start(); osc.stop(_audioCtx.currentTime + 0.5);
  } catch (e) { }
}

function isQuietHoursActive() {
  const rules = state.notificationRules || {};
  if (!rules.quietHours) return false;
  const [startH, startM] = (rules.quietStart || "22:00").split(":").map(Number);
  const [endH, endM] = (rules.quietEnd || "08:00").split(":").map(Number);
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

function shouldNotify(msg, isMention, isDm) {
  const rules = state.notificationRules || {};
  if (state.presence === "busy" || isQuietHoursActive()) return false;
  if (rules.mutedBuffers?.[bufferKey(msg.server_id, msg.channel)]) return false;
  if (rules.mode === "off") return false;
  if (rules.mode === "mentions") return isMention;
  if (rules.mode === "dms") return isDm || isMention;
  return true;
}

function shouldShowMessagePopup(msg, bufferName, isMention, isDm) {
  // Server/status buffers are technically direct-shaped, but popups are for
  // human-service attention: DMs, service messages, and explicit mentions.
  if (String(bufferName || "").startsWith("*")) return false;
  return shouldNotify(msg, isMention, isDm);
}

function syncInboxWindows(serverId, bufferName) {
  if (document.body.classList.contains("messages-window")) return;
  // The standalone Messages window also listens for backend IRC events, but a
  // focused one-buffer patch makes DMs/services visible immediately even when
  // the storage snapshot write is deferred for interaction latency.
  emit("inbox-sync", {
    messages: {
      [serverId]: {
        [bufferName]: state.messages?.[serverId]?.[bufferName] || [],
      },
    },
    unreads: {
      [serverId]: state.unreads?.[serverId] || {},
    },
    activeServer: String(state.activeServer || serverId || ""),
  }).catch(() => {});
}

export function syncNativeUnreadState() {
  // Native badge updates cross the JS/Rust boundary. Coalesce them to the next
  // frame so message bursts do not add bridge work to the current interaction.
  scheduleFrameTask("native-unread-state", () => {
    let count = 0;
    let hasMention = false;
    Object.values(state.unreads || {}).forEach((buffers) => {
      Object.entries(buffers || {}).forEach(([key, value]) => {
        if (key.endsWith(":mention")) {
          hasMention = hasMention || Boolean(value);
        } else if (typeof value === "number" && value > 0) {
          count += value;
        }
      });
    });
    invoke("set_native_unread_state", { count, hasMention }).catch(() => {});
  });
}

export function appendMessage(msg) {
  const serverId = msg.server_id || state.activeServer;
  const nBuffer = canonicalizeBuffer(serverId, msg.channel);
  if (!serverId || !nBuffer) return;
  if (!msg.received_at) msg.received_at = new Date().toISOString();
  if (!msg.id) msg.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (!state.messages[serverId]) state.messages[serverId] = {};
  if (!state.messages[serverId][nBuffer]) state.messages[serverId][nBuffer] = [];

  const list = state.messages[serverId][nBuffer];
  const isSelf = isSelfNick(serverId, msg.username);
  const isDirect = isDirectBuffer(nBuffer);
  const isService = isServiceBuffer(nBuffer) || isServiceBuffer(msg.username);
  const recentDuplicate = isSelf && [...list].reverse().slice(0, 8).some(existing =>
    isSelfNick(serverId, existing.username) &&
    norm(existing.content) === norm(msg.content) &&
    Math.abs(new Date(msg.received_at).getTime() - new Date(existing.received_at || 0).getTime()) < 8000
  );
  if (recentDuplicate) {
    window.dispatchEvent(new CustomEvent("messages-updated", { detail: msg }));
    return;
  }

  list.push(msg);
  state.msgCount++;

  if (list.length > state.maxMessages) list.shift();

  // Handle Unreads & Mentions
  const isActive = serverId.toString() === state.activeServer?.toString() && nBuffer === norm(state.activeChannel);
  if (!isActive && !isSelf && (msg.username !== 'System' || isDirect || isService)) {
    if (!state.unreads[serverId]) state.unreads[serverId] = {};
    state.unreads[serverId][nBuffer] = (state.unreads[serverId][nBuffer] || 0) + 1;

    const myNick = (state.config?.global_nickname || "").toLowerCase();
    const isMention = myNick && msg.content.toLowerCase().includes(myNick);
    const isDm = isDirect || isService;
    if (isMention) {
      state.unreads[serverId][nBuffer + ':mention'] = true;
      if (shouldNotify(msg, true, isDm)) playMentionSound();
    }
    if (!isMention && shouldNotify(msg, false, isDm)) playMentionSound();
    if (shouldShowMessagePopup(msg, nBuffer, isMention, isDm)) {
      showMessagePopup(msg, { isMention, isDm });
    }
    syncNativeUnreadState();
    window.dispatchEvent(new CustomEvent("refresh-sidebar"));
  }

  if (isActive) {
    if (!state.searchQuery || msg.content.toLowerCase().includes(state.searchQuery)) {
      scheduleSingleMessage(msg);
    }
  }

  sessionStore.saveMessageSnapshot(state.messages);
  sessionStore.saveInboxSnapshot({
    messages: state.messages,
    unreads: state.unreads,
    activeServer: String(state.activeServer || serverId || ""),
  });
  sessionStore.saveRuntimeSession(state);
  syncNativeUnreadState();
  if (isDirect || isService) syncInboxWindows(serverId, nBuffer);
  window.dispatchEvent(new CustomEvent("messages-updated", { detail: msg }));
}

function buildMessageRow(msg, grouped) {
  const row = document.createElement("div");
  const myNick = (state.config?.global_nickname || "Me");
  const isMe = msg.username === myNick;
  const isSystem = msg.username === 'System' || msg.username === 'Status' || msg.username === 'Topic' || msg.username === '❔ Help';
  const isMention = !isMe && myNick.toLowerCase() && msg.content.toLowerCase().includes(myNick.toLowerCase());

  if (isSystem) {
    row.className = "system-msg";
    const pill = document.createElement("div");
    pill.className = "system-msg-pill";
    pill.textContent = msg.username;
    row.append(pill, formattedContentElement("msg-text", msg.content, { searchQuery: state.searchQuery }));
    attachMessageMenu(row, msg);
    return row;
  }

  row.className = "user-msg-block";
  if (grouped) row.classList.add("msg-grouped");
  if (isMention) row.classList.add("msg-mention");

  const color = getNickColor(msg.username);
  const avatarUrl = avatarUrlForNick(msg.username || "", msg.server_id);

  if (grouped) {
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.style.visibility = "hidden";
    const body = document.createElement("div");
    body.className = "msg-content-body";
    body.appendChild(formattedContentElement("msg-text", msg.content, { searchQuery: state.searchQuery }));
    row.append(avatar, body);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = "Avatar";
    avatar.appendChild(img);

    const body = document.createElement("div");
    body.className = "msg-content-body";
    const header = document.createElement("div");
    header.className = "msg-header";
    const nick = document.createElement("span");
    nick.className = "msg-nick";
    nick.style.color = color;
    nick.textContent = msg.username;
    nick.addEventListener("click", (event) => window.onNickClick(event, msg.username));
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTimestamp(msg.received_at || msg.timestamp);
    header.append(nick, time);
    body.append(header, formattedContentElement("msg-text", msg.content, { searchQuery: state.searchQuery }));
    row.append(avatar, body);
  }
  attachMessageMenu(row, msg);
  return row;
}

function isJoinPartLikeSystemMessage(msg) {
  const content = String(msg.content || "");
  if (msg.msg_type === 'join' || msg.msg_type === 'part' || msg.msg_type === 'quit') return true;
  if (msg.msg_type !== 'system' && msg.username !== 'System' && msg.username !== 'Mode') return false;
  return /\sjoined\s[#&]\S+$/i.test(content)
    || /\sleft(?:\s|$|\()/i.test(content)
    || /\swas kicked by\s/i.test(content)
    || /\sset mode\s/i.test(content);
}

function shouldRenderMessage(msg) {
  if (state.config?.display?.show_system_messages === false && (msg.msg_type === 'system' || msg.username === 'System' || msg.username === 'Status' || msg.username === 'Topic')) return false;
  if (state.signalFilter && isJoinPartLikeSystemMessage(msg)) return false;
  return true;
}

function attachMessageMenu(row, msg) {
  row.oncontextmenu = (event) => {
    event.preventDefault();
    showMessageMenu(event.clientX, event.clientY, msg, {
      onReply: (nick) => {
        const input = document.querySelector("#chat-input");
        if (input && nick && nick !== "System") {
          input.value = `${nick}: ${input.value}`;
          input.focus();
        }
      }
    });
  };
}

function messageRenderWindow(serverId, channel, allMessages) {
  const key = bufferKey(serverId, channel);
  const searching = Boolean(state.searchQuery);
  if (searching || allMessages.length <= INITIAL_MESSAGE_RENDER_LIMIT) {
    return { key, messages: allMessages, hiddenCount: 0, offset: 0 };
  }
  const limit = Math.max(
    INITIAL_MESSAGE_RENDER_LIMIT,
    Number(state.messageRenderLimits[key]) || INITIAL_MESSAGE_RENDER_LIMIT,
  );
  const offset = Math.max(0, allMessages.length - limit);
  return {
    key,
    messages: allMessages.slice(offset),
    hiddenCount: offset,
    offset,
  };
}

function makeLoadOlderButton(hiddenCount, key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-history-more";
  button.textContent = `Load ${Math.min(MESSAGE_RENDER_INCREMENT, hiddenCount)} older messages (${hiddenCount} kept)`;
  button.addEventListener("click", () => {
    // Huge channels should not render thousands of rows on first paint. The
    // user can page older history in deliberately without taxing interaction.
    state.messageRenderLimits[key] = (Number(state.messageRenderLimits[key]) || INITIAL_MESSAGE_RENDER_LIMIT) + MESSAGE_RENDER_INCREMENT;
    renderMessages(state.activeServer, state.activeChannel);
  });
  return button;
}

function makeTypingIndicator(serverId, channel) {
  const { label, tone } = typingSummaryForBuffer(serverId, channel);
  if (!label) return null;
  const row = document.createElement("div");
  row.className = "typing-indicator";
  row.dataset.typingIndicator = "true";
  row.dataset.typingTone = tone;
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  row.setAttribute("aria-label", label);
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    dots.appendChild(document.createElement("span"));
  }
  const text = document.createElement("span");
  text.className = "typing-label";
  text.textContent = label;
  row.append(dots, text);
  return row;
}

function appendTypingIndicator(fragment, serverId, channel) {
  const indicator = makeTypingIndicator(serverId, channel);
  if (indicator) fragment.appendChild(indicator);
}

function removeTypingIndicator(container) {
  const existing = container?.querySelector?.('[data-typing-indicator="true"]');
  if (!existing) return;
  if (typeof existing.remove === "function") existing.remove();
  else if (existing.parentNode) existing.parentNode.removeChild(existing);
}

function isNearBottom(container, threshold = 140) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

// Typing events can arrive every few seconds, so patch only this transient row
// instead of repainting a full buffer and disturbing scroll/focus.
function refreshTypingIndicator(container, serverId, channel) {
  if (!container || channel === "(LIST)" || channel === "(LOGS)") return;
  const stayPinned = isNearBottom(container);
  removeTypingIndicator(container);
  const indicator = makeTypingIndicator(serverId, channel);
  if (indicator) container.appendChild(indicator);
  if (stayPinned) container.scrollTop = container.scrollHeight;
}

function virtualRowEstimate(container) {
  const measured = Number(container?.dataset?.virtualRowEstimate);
  if (!Number.isFinite(measured) || measured <= 0) return VIRTUAL_ROW_ESTIMATE_PX;
  return Math.min(VIRTUAL_ROW_MAX_PX, Math.max(VIRTUAL_ROW_MIN_PX, measured));
}

export function virtualMessageSlice(total, scrollTop = 0, clientHeight = 0, nearBottom = false, rowEstimate = VIRTUAL_ROW_ESTIMATE_PX) {
  const visibleRows = Math.max(
    VIRTUAL_MIN_VISIBLE_ROWS,
    Math.ceil((Number(clientHeight) || 720) / rowEstimate) + (VIRTUAL_OVERSCAN_ROWS * 2),
  );
  const start = nearBottom
    ? Math.max(0, total - visibleRows)
    : Math.max(0, Math.floor((Number(scrollTop) || 0) / rowEstimate) - VIRTUAL_OVERSCAN_ROWS);
  const end = Math.min(total, start + visibleRows);
  return {
    start,
    end,
    topPad: start * rowEstimate,
    bottomPad: Math.max(0, total - end) * rowEstimate,
  };
}

function makeVirtualSpacer(height) {
  const spacer = document.createElement("div");
  spacer.className = "message-virtual-spacer";
  spacer.style.height = `${Math.max(0, Math.round(height))}px`;
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
}

function bindVirtualMessageScroller(container) {
  if (container.dataset.virtualScrollBound === "true") return;
  container.dataset.virtualScrollBound = "true";
  container.addEventListener("scroll", () => {
    if (container.dataset.virtualMode !== "true" || container.dataset.virtualSuppressScroll === "true") return;
    scheduleFrameTask(`virtual-message-scroll:${container.dataset.virtualKey || ""}`, () => {
      renderMessages(state.activeServer, state.activeChannel);
    });
  }, { passive: true });
}

function renderVirtualMessages(serverId, channel, container, allMsgs) {
  const key = bufferKey(serverId, channel);
  const previousScrollTop = container.scrollTop;
  const sameVirtualBuffer = container.dataset.virtualMode === "true" && container.dataset.virtualKey === key;
  const nearBottom = !sameVirtualBuffer || (container.scrollHeight - container.scrollTop - container.clientHeight < 180);
  const rowEstimate = virtualRowEstimate(container);
  const slice = virtualMessageSlice(allMsgs.length, previousScrollTop, container.clientHeight, nearBottom, rowEstimate);
  const fragment = document.createDocumentFragment();

  if (slice.topPad > 0) fragment.appendChild(makeVirtualSpacer(slice.topPad));

  let lastNick = slice.start > 0 ? allMsgs[slice.start - 1]?.username : null;
  let lastDate = slice.start > 0 && allMsgs[slice.start - 1] ? getDateLabel(allMsgs[slice.start - 1]) : "";
  const readKey = bufferKey(serverId, channel);
  const lastRead = state.lastReadIndex[readKey] ?? allMsgs.length;
  let unreadInserted = slice.start > lastRead;

  for (let index = slice.start; index < slice.end; index += 1) {
    const msg = allMsgs[index];
    if (!msg || !shouldRenderMessage(msg)) continue;
    const dateLabel = getDateLabel(msg);
    if (dateLabel !== lastDate) {
      fragment.appendChild(makeDateSeparator(dateLabel));
      lastDate = dateLabel;
      lastNick = null;
    }
    if (!unreadInserted && index >= lastRead && allMsgs.length > lastRead) {
      const marker = document.createElement("div");
      marker.className = "unread-separator";
      const markerLabel = document.createElement("span");
      markerLabel.textContent = "Unread messages";
      marker.appendChild(markerLabel);
      fragment.appendChild(marker);
      unreadInserted = true;
      lastNick = null;
    }
    const isGrouped = lastNick === msg.username && !msg.msg_type;
    const row = buildMessageRow(msg, isGrouped);
    row.dataset.nick = msg.username;
    fragment.appendChild(row);
    lastNick = msg.username;
  }

  if (slice.bottomPad > 0) fragment.appendChild(makeVirtualSpacer(slice.bottomPad));
  appendTypingIndicator(fragment, serverId, channel);

  const renderedRows = fragment.querySelectorAll?.(".user-msg-block, .system-msg, .date-separator, .unread-separator").length || 0;

  container.dataset.virtualMode = "true";
  container.dataset.virtualKey = key;
  container.dataset.virtualSuppressScroll = "true";
  container.replaceChildren(fragment);
  if (renderedRows > 0) {
    const rows = Array.from(container.querySelectorAll(".user-msg-block, .system-msg, .date-separator, .unread-separator"));
    const rowHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) / renderedRows;
    if (Number.isFinite(rowHeight) && rowHeight > 0) container.dataset.virtualRowEstimate = String(Math.round(rowHeight));
  }
  bindVirtualMessageScroller(container);
  container.scrollTop = nearBottom ? container.scrollHeight : previousScrollTop;
  requestAnimationFrame(() => {
    delete container.dataset.virtualSuppressScroll;
  });
  markActiveBufferRead();
}

const pendingActiveMessages = [];

function scheduleSingleMessage(msg) {
  pendingActiveMessages.push(msg);
  scheduleFrameTask("active-message-render", flushPendingActiveMessages);
}

function flushPendingActiveMessages() {
  const container = document.querySelector("#chat-scroller");
  if (!container) return;
  if (container.dataset.virtualMode === "true") {
    pendingActiveMessages.length = 0;
    renderMessages(state.activeServer, state.activeChannel);
    return;
  }
  const stayPinned = isNearBottom(container, 160);
  removeTypingIndicator(container);
  const fragment = document.createDocumentFragment();
  while (pendingActiveMessages.length) {
    const msg = pendingActiveMessages.shift();
    if (String(msg.server_id || "") !== String(state.activeServer || "") || norm(msg.channel) !== norm(state.activeChannel)) {
      continue;
    }
    if (!shouldRenderMessage(msg)) continue;
    const lastRow = fragment.lastElementChild || container.lastElementChild;
    const isGrouped = lastRow && lastRow.dataset.nick === msg.username && !msg.msg_type;
    const row = buildMessageRow(msg, isGrouped);
    row.dataset.nick = msg.username;
    fragment.appendChild(row);
  }
  if (!fragment.childNodes.length) {
    refreshTypingIndicator(container, state.activeServer, state.activeChannel);
    return;
  }
  container.appendChild(fragment);
  refreshTypingIndicator(container, state.activeServer, state.activeChannel);
  if (stayPinned) container.scrollTop = container.scrollHeight;
}

export function markActiveBufferRead() {
  const key = bufferKey(state.activeServer, state.activeChannel);
  const list = state.messages[state.activeServer]?.[norm(state.activeChannel)] || [];
  state.lastReadIndex[key] = list.length;
}

export function renderChannelList() {
  const container = document.querySelector("#chat-scroller");
  if (!container) return;

  const results = state.channelListResults || [];
  const isLoading = state.isListing;
  container.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "channel-discovery-view";
  const title = document.createElement("h2");
  title.className = "channel-discovery-title";
  const titleText = document.createElement("span");
  titleText.textContent = "CHANNEL DISCOVERY";
  title.appendChild(titleText);
  if (isLoading) {
    const scanning = document.createElement("span");
    scanning.className = "glitch-text channel-discovery-status";
    scanning.textContent = "SCANNING...";
    title.appendChild(scanning);
  }

  const stats = document.createElement("div");
  stats.className = "channel-discovery-stats";
  const count = document.createElement("span");
  count.textContent = `${results.length} CHANNELS IDENTIFIED`;
  const status = document.createElement("span");
  status.textContent = isLoading ? "RECEIVING PACKETS..." : "SCAN COMPLETE";
  stats.append(count, status);

  const rows = document.createElement("div");
  rows.className = "channel-discovery-rows";
  results.forEach((channel) => {
    const row = document.createElement("div");
    row.className = "m3-row channel-discovery-row";
    const info = document.createElement("div");
    info.className = "m3-row-info";
    const label = document.createElement("div");
    label.className = "m3-row-label";
    label.appendChild(document.createTextNode(channel.name || ""));
    const users = document.createElement("span");
    users.className = "channel-discovery-users";
    users.textContent = ` (${channel.users || 0} users)`;
    label.appendChild(users);
    const topic = document.createElement("div");
    topic.className = "m3-row-desc channel-discovery-topic";
    appendFormattedContent(topic, channel.topic || "No topic set");
    info.append(label, topic);
    const join = document.createElement("button");
    join.type = "button";
    join.className = "tactical-btn channel-discovery-join";
    join.textContent = "JOIN";
    join.addEventListener("click", () => window.onJoinChannel(channel.name));
    row.append(info, join);
    rows.appendChild(row);
  });
  shell.append(title, stats, rows);
  container.appendChild(shell);
}

export function renderTelemetry() {
  const container = document.querySelector("#chat-scroller");
  if (!container) return;

  container.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "telemetry-view";
  const title = document.createElement("h2");
  title.className = "telemetry-title";
  title.textContent = "SYSTEM TELEMETRY";
  const subtitle = document.createElement("div");
  subtitle.className = "telemetry-subtitle";
  subtitle.textContent = "RAW PROTOCOL LOGS AND DIAGNOSTIC EVENTS";
  const scroller = document.createElement("div");
  scroller.id = "telemetry-log-scroller";
  scroller.className = "telemetry-log-scroller";
  state.telemetryLogs.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "telemetry-row";
    const timestamp = document.createElement("span");
    timestamp.className = "telemetry-time";
    timestamp.textContent = `[${entry.timestamp}]`;
    const content = document.createElement("span");
    content.className = "telemetry-content";
    content.textContent = entry.content;
    row.append(timestamp, content);
    scroller.appendChild(row);
  });
  shell.append(title, subtitle, scroller);
  container.appendChild(shell);
  container.scrollTop = container.scrollHeight;
}

window.addEventListener("refresh-telemetry", () => {
  if (state.activeChannel === '(LOGS)') renderTelemetry();
});

export function renderMessages(serverId, channel) {
  return measureTask(`renderMessages:${channel}`, () => {
  if (channel === '(LIST)') {
    renderChannelList();
    return;
  }
  if (channel === '(LOGS)') {
    renderTelemetry();
    return;
  }
  const nBuffer = norm(channel);
  const container = document.querySelector("#chat-scroller");
  if (!container) return;
  const fragment = document.createDocumentFragment();
  const allMsgs = state.messages[serverId]?.[nBuffer] || [];
  const renderableMsgs = state.searchQuery ? allMsgs : allMsgs.filter(shouldRenderMessage);
  if (!state.searchQuery && renderableMsgs.length > MESSAGE_VIRTUALIZATION_THRESHOLD) {
    renderVirtualMessages(serverId, channel, container, renderableMsgs);
    return;
  }
  container.dataset.virtualMode = "false";
  container.dataset.virtualKey = "";
  const renderWindow = messageRenderWindow(serverId, channel, allMsgs);
  if (renderWindow.hiddenCount > 0) {
    fragment.appendChild(makeLoadOlderButton(renderWindow.hiddenCount, renderWindow.key));
  }
  let lastNick = null;
  let lastDate = "";
  const readKey = bufferKey(serverId, channel);
  const lastRead = state.lastReadIndex[readKey] ?? allMsgs.length;
  let unreadInserted = false;
  renderWindow.messages.forEach((msg, visibleIndex) => {
    const index = renderWindow.offset + visibleIndex;
    if (state.searchQuery && !msg.content.toLowerCase().includes(state.searchQuery)) return;
    if (!shouldRenderMessage(msg)) return;
    const dateLabel = getDateLabel(msg);
    if (dateLabel !== lastDate) {
      fragment.appendChild(makeDateSeparator(dateLabel));
      lastDate = dateLabel;
      lastNick = null;
    }
    if (!unreadInserted && index >= lastRead && allMsgs.length > lastRead) {
      const marker = document.createElement("div");
      marker.className = "unread-separator";
      const markerLabel = document.createElement("span");
      markerLabel.textContent = "Unread messages";
      marker.appendChild(markerLabel);
      fragment.appendChild(marker);
      unreadInserted = true;
      lastNick = null;
    }
    const isGrouped = lastNick === msg.username && !msg.msg_type;
    const row = buildMessageRow(msg, isGrouped);
    row.dataset.nick = msg.username;
    fragment.appendChild(row);
    lastNick = msg.username;
  });
  appendTypingIndicator(fragment, serverId, channel);
  container.replaceChildren(fragment);
  container.scrollTop = container.scrollHeight;
  markActiveBufferRead();
  });
}

window.onJoinChannel = (chan) => {
  import('../services/irc.js').then(m => m.handleCommand(`/join ${chan}`));
};

window.onNickClick = (e, nick) => {
  e.preventDefault();
  showNickMenu(e.clientX, e.clientY, nick, e, {
    onPm: (n) => window.selectChannel ? window.selectChannel(state.activeServer, n) : null
  });
};

window.addEventListener("typing-state-changed", (event) => {
  const detail = event.detail || {};
  if (
    String(detail.serverId || "") !== String(state.activeServer || "") ||
    norm(detail.buffer) !== norm(state.activeChannel)
  ) {
    return;
  }
  scheduleFrameTask("typing-indicator-refresh", () => {
    const container = document.querySelector("#chat-scroller");
    if (container?.dataset?.virtualMode === "true") {
      renderMessages(state.activeServer, state.activeChannel);
      return;
    }
    refreshTypingIndicator(container, state.activeServer, state.activeChannel);
  });
});
