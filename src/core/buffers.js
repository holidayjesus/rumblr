import { norm } from './state.js';

export function escapeHTML(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isChannelBuffer(name) {
  return Boolean(name && (name.startsWith("#") || name.startsWith("&")));
}

export function isUtilityBuffer(name) {
  return Boolean(name && name.startsWith("("));
}

export function isDirectBuffer(name) {
  return Boolean(name && !isChannelBuffer(name) && !isUtilityBuffer(name));
}

export function isServiceBuffer(name) {
  return /^(nickserv|chanserv|memoserv|operserv|hostserv|alis|global)$/i.test(String(name || ""));
}

export function canonicalServiceBufferName(name) {
  const key = norm(name);
  const names = {
    nickserv: "NickServ",
    chanserv: "ChanServ",
    memoserv: "MemoServ",
    operserv: "OperServ",
    hostserv: "HostServ",
    alis: "ALIS",
    global: "Global",
  };
  return names[key] || name;
}

export function serverLabel(state, serverId) {
  const id = String(serverId || state.activeServer || state.config?.servers?.[0]?.id || "");
  const server = state.config?.servers?.find(s => String(s.id) === id);
  return server?.name || id || "No network selected";
}

export function messagesForBuffer(state, serverId, bufferName) {
  return Object.entries(state.messages?.[serverId] || {})
    .filter(([key]) => norm(key) === norm(bufferName))
    .flatMap(([, messages]) => messages || [])
    .sort((a, b) => String(a.received_at || "").localeCompare(String(b.received_at || "")));
}

export function directConversationBuffers(state, serverId) {
  const activeServer = state.config?.servers?.find(s => String(s.id) === String(serverId));
  Object.keys(state.unreads?.[serverId] || {}).forEach((key) => {
    if (key.endsWith(":mention")) return;
    if (isDirectBuffer(key) && messagesForBuffer(state, serverId, key).length === 0) {
      delete state.unreads[serverId][key];
      delete state.unreads[serverId][`${key}:mention`];
    }
  });

  const msgBuffers = Object.keys(state.messages?.[serverId] || {})
    .filter((name) => isDirectBuffer(name) && messagesForBuffer(state, serverId, name).length > 0);
  const configBuffers = [...new Set(activeServer?.autojoin || [])]
    .filter((name) => isDirectBuffer(name) && messagesForBuffer(state, serverId, name).length > 0);
  const serviceBuffers = Object.keys(state.messages?.[serverId] || {})
    .filter((name) => isServiceBuffer(name) && messagesForBuffer(state, serverId, name).length > 0);
  const unreadBuffers = Object.entries(state.unreads?.[serverId] || {})
    .filter(([key, count]) => {
      if (key.endsWith(":mention") || Number(count) <= 0 || !isDirectBuffer(key)) return false;
      return messagesForBuffer(state, serverId, key).length > 0;
    })
    .map(([key]) => key);
  const bufferMap = new Map();

  [...serviceBuffers, ...configBuffers, ...msgBuffers, ...unreadBuffers].forEach((name) => {
    const key = norm(name);
    const existing = bufferMap.get(key);
    const displayName = isServiceBuffer(name) ? canonicalServiceBufferName(name) : name;
    const messages = messagesForBuffer(state, serverId, displayName);
    const unread = state.unreads?.[serverId]?.[key] || 0;
    bufferMap.set(key, {
      name: existing?.name || displayName,
      unread,
      last: messages[messages.length - 1],
      messages,
    });
  });

  return [...bufferMap.values()].sort((a, b) =>
    (b.unread - a.unread) || ((b.last?.received_at || "").localeCompare(a.last?.received_at || ""))
  );
}

export function attentionItems(state) {
  const items = [];
  Object.entries(state.unreads || {}).forEach(([serverId, buffers]) => {
    const name = serverLabel(state, serverId);
    Object.entries(buffers || {}).forEach(([buffer, count]) => {
      if (buffer.endsWith(":mention") || !count) return;
      const messages = messagesForBuffer(state, serverId, buffer);
      items.push({
        serverId,
        serverName: name,
        buffer,
        count,
        isMention: Boolean(buffers[`${buffer}:mention`]),
        last: messages[messages.length - 1],
      });
    });
  });
  return items.sort((a, b) => Number(b.isMention) - Number(a.isMention) || (b.count - a.count));
}
