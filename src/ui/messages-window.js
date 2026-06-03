import { state, norm } from '../core/state.js';
import { getCurrentWindow, invoke } from '../core/tauri.js';
import { sessionStore } from '../core/persistence.js';
import { canonicalServiceBufferName, directConversationBuffers, isServiceBuffer, messagesForBuffer, serverLabel } from '../core/buffers.js';
import { ui } from './ui-engine.js';
import { appendMessage, formatTimestamp } from './messages.js';
import { appendFormattedContent } from './message-content.js';
import { avatarUrlForNick, selfAvatarUrl } from './avatar.js';
import { notifyBufferTyping, sendTypingStateForBuffer, typingSummaryForBuffer } from '../services/typing.js';

let activeMessagesConversation = null;
let hasHydratedMessagesWindowState = false;
let isComposingNewMessage = false;
const messageDrafts = new Map();
const newMessageDraft = { target: "", content: "" };
let messagesComposeListenerBound = false;
let currentMessagesHubContext = null;

function messageDraftKey(serverId, bufferName) {
  return `${String(serverId || "")}:${norm(canonicalServiceBufferName(bufferName || ""))}`;
}

function rememberMessageDraft(serverId, bufferName, value) {
  const key = messageDraftKey(serverId, bufferName);
  if (value) messageDrafts.set(key, value);
  else messageDrafts.delete(key);
}

function readMessageDraft(serverId, bufferName) {
  return messageDrafts.get(messageDraftKey(serverId, bufferName)) || "";
}

function clearMessageDraft(serverId, bufferName) {
  messageDrafts.delete(messageDraftKey(serverId, bufferName));
}

function textInputSnapshot(input, extra = {}) {
  return {
    ...extra,
    value: input?.value || "",
    selectionStart: input?.selectionStart ?? null,
    selectionEnd: input?.selectionEnd ?? null,
  };
}

function captureMessagesHubFocus() {
  const active = document.activeElement;
  if (!active?.matches) return null;
  if (active.matches("#messages-search")) return textInputSnapshot(active, { kind: "search" });
  if (active.matches("#messages-new-target")) return textInputSnapshot(active, { kind: "new-target" });
  if (active.matches(".messages-thread-input")) {
    const compose = active.closest?.(".messages-thread-compose");
    return textInputSnapshot(active, {
      kind: isComposingNewMessage ? "new-input" : "thread-input",
      buffer: compose?.dataset?.buffer || activeMessagesConversation || "",
    });
  }
  return null;
}

function restoreInputSnapshot(input, snapshot) {
  if (!input || !snapshot) return;
  input.value = snapshot.value || "";
  input.focus({ preventScroll: true });
  if (
    snapshot.selectionStart !== null &&
    snapshot.selectionEnd !== null &&
    typeof input.setSelectionRange === "function"
  ) {
    input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function restoreMessagesHubFocus(snapshot) {
  if (!snapshot) return;
  setTimeout(() => {
    if (snapshot.kind === "search") restoreInputSnapshot(document.querySelector("#messages-search"), snapshot);
    if (snapshot.kind === "new-target") restoreInputSnapshot(document.querySelector("#messages-new-target"), snapshot);
    if (snapshot.kind === "new-input" || snapshot.kind === "thread-input") {
      restoreInputSnapshot(document.querySelector(".messages-thread-input"), snapshot);
    }
  }, 0);
}

function hasDirectConversation(serverId) {
  return Boolean(serverId && directConversationBuffers(state, serverId).length > 0);
}

function resolveMessagesHubServer(requestedServer = "") {
  // A clicked popup/attention item should win, but stale open requests are now
  // consumed before this runs. After that, prefer the active network only when
  // it actually has inbox content; otherwise jump to the server that does.
  if (requestedServer) return String(requestedServer);
  const active = String(state.activeServer || "");
  if (hasDirectConversation(active)) return active;
  const unreadServer = Object.keys(state.unreads || {}).find(hasDirectConversation);
  if (unreadServer) return unreadServer;
  const messageServer = Object.keys(state.messages || {}).find(hasDirectConversation);
  if (messageServer) return messageServer;
  return active || String(state.config?.servers?.[0]?.id || "");
}

function messageIdentity(message) {
  if (message?.id && !String(message.id).startsWith("service-recovered-")) return `id:${message.id}`;
  return [
    norm(message?.channel || ""),
    norm(message?.username || ""),
    String(message?.content || ""),
    String(message?.received_at || message?.timestamp || ""),
  ].join("|");
}

function cleanMessageList(messages = []) {
  const seen = new Set();
  return (messages || [])
    // Older builds generated placeholder service rows. The hub now displays
    // only real IRC/local messages, so those recovered placeholders are dropped.
    .filter((message) => message?.recovered !== true)
    .filter((message) => {
      const key = messageIdentity(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.received_at || a.timestamp || "").localeCompare(String(b.received_at || b.timestamp || "")));
}

function mergeNestedMap(current = {}, incoming = {}) {
  const merged = { ...(current || {}) };
  Object.entries(incoming || {}).forEach(([serverId, buffers]) => {
    merged[serverId] = { ...(merged[serverId] || {}) };
    Object.entries(buffers || {}).forEach(([bufferName, messages]) => {
      const canonicalBuffer = canonicalServiceBufferName(bufferName);
      const existingKey = Object.keys(merged[serverId]).find((key) => norm(key) === norm(canonicalBuffer));
      const targetKey = existingKey || canonicalBuffer;
      merged[serverId][targetKey] = cleanMessageList([
        ...(merged[serverId][targetKey] || []),
        ...(messages || []),
      ]);
    });
  });
  return merged;
}

function mergeUnreadMap(current = {}, incoming = {}) {
  const merged = { ...(current || {}) };
  Object.entries(incoming || {}).forEach(([serverId, buffers]) => {
    merged[serverId] = { ...(merged[serverId] || {}) };
    Object.entries(buffers || {}).forEach(([bufferName, value]) => {
      const normalized = norm(bufferName.replace(/:mention$/, ""));
      const suffix = bufferName.endsWith(":mention") ? ":mention" : "";
      const existingKey = Object.keys(merged[serverId]).find((key) => norm(key.replace(/:mention$/, "")) === normalized && key.endsWith(":mention") === bufferName.endsWith(":mention"));
      const targetKey = existingKey || `${normalized}${suffix}`;
      merged[serverId][targetKey] = suffix ? Boolean(value) : Math.max(Number(merged[serverId][targetKey]) || 0, Number(value) || 0);
    });
  });
  return merged;
}

function cleanPersistedMessages() {
  let changed = false;
  Object.entries(state.messages || {}).forEach(([serverId, buffers]) => {
    Object.entries(buffers || {}).forEach(([bufferName, messages]) => {
      const cleaned = cleanMessageList(messages || []);
      if (cleaned.length !== (messages || []).length) changed = true;
      state.messages[serverId][bufferName] = cleaned;
    });
  });
  if (changed) {
    sessionStore.saveMessageSnapshot(state.messages);
    sessionStore.saveInboxSnapshot({
      messages: state.messages,
      unreads: state.unreads,
      activeServer: String(state.activeServer || ""),
    });
  }
}

export function applyMessagesHubSnapshot(snapshot = {}) {
  try {
    // The standalone Messages window can miss in-memory messages that arrived
    // before it opened. Merge snapshots idempotently so live sync and storage
    // restore can both run without duplicating NickServ/ChanServ rows.
    if (snapshot.messages && typeof snapshot.messages === "object") {
      state.messages = mergeNestedMap(state.messages, snapshot.messages);
    }
    if (snapshot.unreads && typeof snapshot.unreads === "object") {
      state.unreads = mergeUnreadMap(state.unreads, snapshot.unreads);
    }
    if (!state.activeServer && snapshot.activeServer) {
      state.activeServer = String(snapshot.activeServer);
    }
    cleanPersistedMessages();
    hasHydratedMessagesWindowState = true;
  } catch (_) { }
}

export function hydrateMessagesWindowState({ force = false } = {}) {
  if (hasHydratedMessagesWindowState && !force) {
    cleanPersistedMessages();
    return;
  }
  try {
    const snapshot = sessionStore.getMessageSnapshot();
    if (snapshot && typeof snapshot === "object") applyMessagesHubSnapshot({ messages: snapshot });
    const inboxSnapshot = sessionStore.getInboxSnapshot();
    if (inboxSnapshot && typeof inboxSnapshot === "object") applyMessagesHubSnapshot(inboxSnapshot);
    cleanPersistedMessages();
    hasHydratedMessagesWindowState = true;
  } catch (_) { }
}

export function syncMessengerPresence() {
  const select = document.querySelector("#messages-presence-select");
  const dot = document.querySelector(".messages-profile-presence");
  const status = state.presence || sessionStore.getPresence("online");
  if (select) select.value = status;
  if (dot) dot.dataset.status = status;
}

function updateMessagesWindowTitle(title = "Messages", subtitle = "Direct IRC conversations") {
  const main = document.querySelector("#messages-title-main");
  const sub = document.querySelector("#messages-title-sub");
  if (main) main.textContent = title;
  if (sub) sub.textContent = subtitle;
  document.title = title === "Messages" ? "Rumblr Messages" : `${title} - Rumblr Messages`;
  try {
    const win = getCurrentWindow();
    if (typeof win?.setTitle === "function") win.setTitle(document.title);
  } catch (_) { }
}

function nickServIdentifyPayload(bufferName, content) {
  if (norm(bufferName) !== "nickserv") return null;
  const match = content.match(/^\/(?:id|identify)\s+(.+)$/i);
  return match ? `IDENTIFY ${match[1].trim()}` : null;
}

function appendNickServIdentifyStatus(serverId) {
  appendMessage({
    username: "System",
    content: "Identification request sent to NickServ. Waiting for confirmation...",
    timestamp: formatTimestamp(new Date()),
    channel: "NickServ",
    server_id: serverId,
    msg_type: "system"
  });
}

function appendMessagesSendFailure(serverId, bufferName, error) {
  appendMessage({
    username: "System",
    content: `Send failed: ${String(error || "Unknown error")}`,
    timestamp: formatTimestamp(new Date()),
    channel: bufferName,
    server_id: serverId,
    msg_type: "system"
  });
}

function sendIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
  body.setAttribute("d", "m22 2-7 20-4-9-9-4Z");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", "M22 2 11 13");
  svg.append(body, line);
  return svg;
}

function plusIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "path");
  vertical.setAttribute("d", "M12 5v14");
  const horizontal = document.createElementNS("http://www.w3.org/2000/svg", "path");
  horizontal.setAttribute("d", "M5 12h14");
  svg.append(vertical, horizontal);
  return svg;
}

function renderMessagesEmpty(container, { rich = false } = {}) {
  container.replaceChildren();
  const empty = document.createElement("div");
  empty.className = `messages-thread-empty ${rich ? "messages-thread-empty-rich" : ""}`;
  const title = document.createElement(rich ? "strong" : "div");
  title.textContent = rich ? "Your message hub is quiet." : "No messages yet";
  empty.appendChild(title);
  if (rich) {
    const subtitle = document.createElement("span");
    subtitle.textContent = "Direct IRC conversations will appear here.";
    empty.appendChild(subtitle);
  }
  container.appendChild(empty);
}

function renderConversationEmpty(list) {
  list.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "messages-empty";
  const title = document.createElement("strong");
  title.textContent = "No conversations";
  const subtitle = document.createElement("span");
  subtitle.textContent = "Start one with the plus button.";
  empty.append(title, subtitle);
  list.appendChild(empty);
}

function createThreadHeader({ title, subtitle, avatarSeed, serverId, compose = false }) {
  const header = document.createElement("div");
  header.className = "messages-thread-header";
  const titleWrap = document.createElement("div");
  titleWrap.className = "messages-thread-title";
  const visual = compose ? document.createElement("div") : document.createElement("img");
  if (compose) {
    visual.className = "messages-compose-avatar";
    visual.appendChild(plusIcon());
  } else {
    visual.src = avatarUrlForNick(avatarSeed || title, serverId);
    visual.alt = "";
  }
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("span");
  small.textContent = subtitle;
  copy.append(strong, small);
  titleWrap.append(visual, copy);
  header.appendChild(titleWrap);
  return header;
}

function createMessageLine(message) {
  const line = document.createElement("div");
  line.className = "messages-thread-line";
  if (message.username === (state.config?.global_nickname || "Me")) line.classList.add("mine");

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const nick = document.createElement("strong");
  nick.textContent = message.username || "System";
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = formatTimestamp(message.received_at || message.timestamp);
  meta.append(nick, time);

  const bubble = document.createElement("div");
  bubble.className = "bubble-text";
  appendFormattedContent(bubble, message.content || "");
  line.append(meta, bubble);
  return line;
}

function createTypingLine(serverId, bufferName) {
  const { label, tone } = typingSummaryForBuffer(serverId, bufferName);
  if (!label) return null;
  const line = document.createElement("div");
  line.className = "messages-thread-typing";
  line.dataset.typingIndicator = "true";
  line.dataset.typingTone = tone;
  line.setAttribute("role", "status");
  line.setAttribute("aria-live", "polite");
  line.setAttribute("aria-label", label);
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) dots.appendChild(document.createElement("span"));
  const text = document.createElement("span");
  text.className = "typing-label";
  text.textContent = label;
  line.append(dots, text);
  return line;
}

// The standalone hub keeps search and composer focus stable by refreshing only
// the typing affordance, not the whole conversation list/thread.
function refreshThreadTypingLine(thread, serverId, bufferName) {
  const bodyEl = thread?.querySelector?.(".messages-thread-body");
  if (!bodyEl) return;
  const stayPinned = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
  const existing = bodyEl.querySelector?.('[data-typing-indicator="true"]');
  if (existing && typeof existing.remove === "function") existing.remove();
  else if (existing?.parentNode) existing.parentNode.removeChild(existing);
  const typingLine = createTypingLine(serverId, bufferName);
  if (typingLine) bodyEl.appendChild(typingLine);
  if (stayPinned) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function createComposeForm({ bufferName = "", placeholder = "", value = "" } = {}) {
  const form = document.createElement("form");
  form.className = "messages-thread-compose";
  form.dataset.buffer = bufferName;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "messages-thread-input";
  input.placeholder = placeholder;
  input.maxLength = 512;
  input.value = bufferName ? readMessageDraft(state.activeServer, bufferName) : value;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "messages-thread-send";
  button.setAttribute("aria-label", "Send message");
  button.appendChild(sendIcon());
  form.append(input, button);
  return form;
}

export async function openMessagesConversation(bufferName, serverId = state.activeServer) {
  bufferName = canonicalServiceBufferName(bufferName);
  sessionStore.saveInboxSnapshot({
    messages: state.messages,
    unreads: state.unreads,
    activeServer: String(serverId || state.activeServer || ""),
  });
  const request = {
    buffer: bufferName,
    serverId: String(serverId || state.activeServer || ""),
    requestedAt: Date.now(),
  };
  sessionStore.setMessagesOpenRequest(request);
  sessionStore.flush();
  activeMessagesConversation = bufferName;
  if (request.serverId) state.activeServer = request.serverId;
  if (document.body.classList.contains("messages-window")) {
    openMessagesPanel();
    return;
  }
  await invoke("open_messages_window").catch(() => openMessagesPanel());
}

function renderThread(thread, list, activeSrv, label, bufferName) {
  bufferName = canonicalServiceBufferName(bufferName);
  const rows = messagesForBuffer(state, activeSrv, bufferName);
  activeMessagesConversation = bufferName;
  isComposingNewMessage = false;
  if (state.unreads?.[activeSrv]) {
    state.unreads[activeSrv][norm(bufferName)] = 0;
    delete state.unreads[activeSrv][`${norm(bufferName)}:mention`];
    sessionStore.saveInboxSnapshot({
      messages: state.messages,
      unreads: state.unreads,
      activeServer: String(activeSrv || state.activeServer || ""),
    });
    sessionStore.saveRuntimeSession(state);
    window.dispatchEvent(new CustomEvent("refresh-sidebar"));
  }
  updateMessagesWindowTitle(bufferName, `${label} - ${rows.length} ${rows.length === 1 ? "message" : "messages"}`);
  const header = createThreadHeader({
    title: bufferName,
    subtitle: `${label} - ${rows.length} ${rows.length === 1 ? "message" : "messages"}`,
    avatarSeed: bufferName,
    serverId: activeSrv,
  });
  const bodyEl = document.createElement("div");
  bodyEl.className = "messages-thread-body";
  if (rows.length) rows.forEach((message) => bodyEl.appendChild(createMessageLine(message)));
  else renderMessagesEmpty(bodyEl);
  const typingLine = createTypingLine(activeSrv, bufferName);
  if (typingLine) bodyEl.appendChild(typingLine);
  const compose = createComposeForm({
    bufferName,
    placeholder: `Message ${bufferName}...`,
  });
  thread.replaceChildren(header, bodyEl, compose);
  const inputEl = compose.querySelector(".messages-thread-input");
  inputEl.value = readMessageDraft(activeSrv, bufferName);
  inputEl.addEventListener("input", () => {
    rememberMessageDraft(activeSrv, bufferName, inputEl.value);
    notifyBufferTyping(activeSrv, bufferName, inputEl.value);
  });
  inputEl.addEventListener("blur", () => sendTypingStateForBuffer(activeSrv, bufferName, "done", { force: true }));
  compose?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = inputEl.value.trim();
    if (!content) return;
    sendTypingStateForBuffer(activeSrv, bufferName, "done", { force: true });
    if (isServiceBuffer(bufferName) && !content.startsWith("/")) {
      appendMessage({
        username: "System",
        content: `Use /msg ${bufferName} HELP for a service command.`,
        timestamp: formatTimestamp(new Date()),
        channel: bufferName,
        server_id: activeSrv,
        msg_type: "system"
      });
      inputEl.value = "";
      clearMessageDraft(activeSrv, bufferName);
      renderThread(thread, list, activeSrv, label, bufferName);
      thread.querySelector(".messages-thread-input")?.focus();
      return;
    }
    const identifyPayload = nickServIdentifyPayload(bufferName, content);
    try {
      if (identifyPayload) {
        await invoke("send_irc_message", { serverId: String(activeSrv), channel: bufferName, content: identifyPayload });
        appendNickServIdentifyStatus(activeSrv);
        inputEl.value = "";
        clearMessageDraft(activeSrv, bufferName);
        renderThread(thread, list, activeSrv, label, bufferName);
        thread.querySelector(".messages-thread-input")?.focus();
        return;
      }
      await invoke("send_irc_message", { serverId: String(activeSrv), channel: bufferName, content });
      const myNick = state.config?.global_nickname || "Me";
      appendMessage({ username: myNick, content, timestamp: formatTimestamp(new Date()), channel: bufferName, server_id: activeSrv });
      inputEl.value = "";
      clearMessageDraft(activeSrv, bufferName);
      renderThread(thread, list, activeSrv, label, bufferName);
      thread.querySelector(".messages-thread-input")?.focus();
      if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    } catch (error) {
      appendMessagesSendFailure(activeSrv, bufferName, error);
      rememberMessageDraft(activeSrv, bufferName, inputEl.value);
      inputEl.focus();
    }
  });
  if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function renderNewMessage(thread, list, activeSrv, label, { focusTarget = true } = {}) {
  activeMessagesConversation = null;
  isComposingNewMessage = true;
  updateMessagesWindowTitle("New Message", label);
  list.querySelectorAll(".messages-row").forEach((r) => r.classList.remove("active"));
  const header = createThreadHeader({ title: "New Message", subtitle: label, compose: true });
  const body = document.createElement("div");
  body.className = "messages-new-body";
  const targetLabel = document.createElement("label");
  targetLabel.htmlFor = "messages-new-target";
  targetLabel.textContent = "To";
  const target = document.createElement("input");
  target.id = "messages-new-target";
  target.type = "text";
  target.placeholder = "NickServ, ChanServ, nickname...";
  target.autocomplete = "off";
  target.value = newMessageDraft.target;
  body.append(targetLabel, target);
  const compose = createComposeForm({ placeholder: "Write a message...", value: newMessageDraft.content });
  thread.replaceChildren(header, body, compose);
  const inputEl = compose.querySelector(".messages-thread-input");
  target.addEventListener("input", () => { newMessageDraft.target = target.value; });
  inputEl?.addEventListener("input", () => { newMessageDraft.content = inputEl.value; });
  if (focusTarget) setTimeout(() => target?.focus(), 0);
  compose.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bufferName = target?.value.trim();
    const content = inputEl?.value.trim();
    if (!bufferName || !content) {
      (bufferName ? inputEl : target)?.focus();
      return;
    }
    const identifyPayload = nickServIdentifyPayload(bufferName, content);
    try {
      if (identifyPayload) {
        await invoke("send_irc_message", { serverId: String(activeSrv), channel: bufferName, content: identifyPayload });
        appendNickServIdentifyStatus(activeSrv);
      } else {
        await invoke("send_irc_message", { serverId: String(activeSrv), channel: bufferName, content });
        const myNick = state.config?.global_nickname || "Me";
        appendMessage({ username: myNick, content, timestamp: formatTimestamp(new Date()), channel: bufferName, server_id: activeSrv });
      }
      isComposingNewMessage = false;
      newMessageDraft.target = "";
      newMessageDraft.content = "";
      activeMessagesConversation = bufferName;
      openMessagesPanel();
    } catch (error) {
      appendMessagesSendFailure(activeSrv, bufferName, error);
      inputEl?.focus();
    }
  });
}

function renderList(list, thread, buffers, activeSrv, label, requestedBuffer, { preserveThread = false } = {}) {
  if (buffers.length === 0) {
    renderConversationEmpty(list);
    return;
  }
  const previousScrollTop = list.scrollTop;
  list.replaceChildren();
  buffers.forEach((buffer) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "messages-row";
    if (activeMessagesConversation && norm(buffer.name) === norm(activeMessagesConversation)) {
      row.classList.add("active");
    }
    row.dataset.buffer = buffer.name;

    const avatar = document.createElement("div");
    avatar.className = "messages-avatar";
    const img = document.createElement("img");
    img.src = avatarUrlForNick(buffer.name, activeSrv);
    img.alt = "";
    avatar.appendChild(img);

    const main = document.createElement("div");
    main.className = "messages-main";
    const top = document.createElement("div");
    top.className = "messages-row-top";
    const name = document.createElement("div");
    name.className = "messages-name";
    name.textContent = buffer.name;
    const time = document.createElement("div");
    time.className = "messages-time";
    time.textContent = formatTimestamp(buffer.last?.received_at || buffer.last?.timestamp);
    top.append(name, time);
    const preview = document.createElement("div");
    preview.className = "messages-preview";
    preview.textContent = String(buffer.last?.content || "No messages yet").slice(0, 90);
    main.append(top, preview);

    const meta = document.createElement("div");
    meta.className = "messages-meta";
    if (buffer.unread > 0) {
      const unread = document.createElement("span");
      unread.className = "messages-unread";
      unread.textContent = buffer.unread;
      meta.appendChild(unread);
    }

    row.append(avatar, main, meta);
    row.addEventListener("click", () => {
      const buffer = row.getAttribute("data-buffer");
      if (!buffer) return;
      list.querySelectorAll(".messages-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
      renderThread(thread, list, activeSrv, label, buffer);
    });
    list.appendChild(row);
  });
  if (preserveThread) {
    list.scrollTop = previousScrollTop;
    return;
  }
  if (requestedBuffer) activeMessagesConversation = requestedBuffer;
  const selected = activeMessagesConversation && list.querySelector(`.messages-row[data-buffer="${CSS.escape(activeMessagesConversation)}"]`);
  if (selected) selected.click();
  else list.querySelector(".messages-row")?.click();
  list.scrollTop = previousScrollTop;
}

export function openMessagesPanel() {
  hydrateMessagesWindowState();
  ui.hide("#channel-browser-panel");
  const panel = document.querySelector("#messages-panel");
  const list = document.querySelector("#messages-list");
  const thread = document.querySelector("#messages-thread");
  if (!panel || !list || !thread) return;
  const wasVisible = panel.style.display === "flex";
  const focusSnapshot = wasVisible ? captureMessagesHubFocus() : null;
  const keepNewComposer = wasVisible && isComposingNewMessage;

  const pendingRequest = sessionStore.consumeMessagesOpenRequest();
  const requestedServer = pendingRequest?.serverId ? String(pendingRequest.serverId) : "";
  const requestedBuffer = pendingRequest?.buffer || "";
  const activeSrv = resolveMessagesHubServer(requestedServer);
  if (activeSrv) state.activeServer = activeSrv;
  const label = serverLabel(state, activeSrv) || "Offline";
  const myNick = state.config?.global_nickname || state.config?.servers?.[0]?.nickname || "RumblrUser";
  const profileName = document.querySelector(".messages-profile-name");
  const profileAvatar = document.querySelector(".messages-profile-avatar img");
  if (profileName) profileName.textContent = myNick;
  if (profileAvatar) profileAvatar.src = selfAvatarUrl(activeSrv);
  syncMessengerPresence();

  const buffers = directConversationBuffers(state, activeSrv);
  const search = document.querySelector("#messages-search");
  const searchValue = wasVisible ? (search?.value || "") : "";
  const query = searchValue.trim().toLowerCase();
  const filteredBuffers = !query ? buffers : buffers.filter((b) =>
    b.name.toLowerCase().includes(query) || (b.last?.content || "").toLowerCase().includes(query)
  );

  currentMessagesHubContext = { thread, list, activeSrv, label };
  if (!messagesComposeListenerBound) {
    window.addEventListener("messages-compose", () => {
      if (!currentMessagesHubContext) return;
      const { thread, list, activeSrv, label } = currentMessagesHubContext;
      renderNewMessage(thread, list, activeSrv, label);
    });
    messagesComposeListenerBound = true;
  }

  if (buffers.length === 0) {
    renderConversationEmpty(list);
    if (keepNewComposer) renderNewMessage(thread, list, activeSrv, label, { focusTarget: false });
    else {
      renderMessagesEmpty(thread, { rich: true });
      updateMessagesWindowTitle("Messages", label);
    }
  } else {
    renderList(list, thread, filteredBuffers, activeSrv, label, requestedBuffer || activeMessagesConversation, {
      preserveThread: keepNewComposer || focusSnapshot?.kind === "search",
    });
    if (keepNewComposer) renderNewMessage(thread, list, activeSrv, label, { focusTarget: false });
  }

  if (search) {
    search.value = searchValue;
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      const filtered = !q ? buffers : buffers.filter((b) =>
        b.name.toLowerCase().includes(q) || (b.last?.content || "").toLowerCase().includes(q)
      );
      renderList(list, thread, filtered, activeSrv, label, activeMessagesConversation, { preserveThread: true });
    };
  }
  panel.style.display = "flex";
  if (focusSnapshot) restoreMessagesHubFocus(focusSnapshot);
  else if (!wasVisible && !requestedBuffer && !activeMessagesConversation) setTimeout(() => search?.focus(), 0);
}

window.addEventListener("typing-state-changed", (event) => {
  const detail = event.detail || {};
  if (!activeMessagesConversation) return;
  if (
    String(detail.serverId || "") === String(state.activeServer || "") &&
    norm(detail.buffer) === norm(activeMessagesConversation)
  ) {
    refreshThreadTypingLine(document.querySelector("#messages-thread"), state.activeServer, activeMessagesConversation);
  }
});
