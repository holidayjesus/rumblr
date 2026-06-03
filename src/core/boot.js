import { state, discoverBuffer, norm, parseUser } from './state.js';
import { ui, log, startMetricsPulse } from '../ui/ui-engine.js';
import { invoke, listen } from './tauri.js';
import { loadAppConfig } from './config-store.js';
import { sessionStore } from './persistence.js';
import { recordNetworkTraffic, shouldReconcileLiveTraffic } from './network-state.js';
import { appendMessage, renderMessages, formatTimestamp } from '../ui/messages.js';
import { renderSidebar, selectChannel, selectServer, renderUserList, updateNetStatus, closeBuffer, updateChannelTopicHeader } from '../ui/sidebar.js';
import { updateMediaWidget } from '../services/media.js';
import { clearTypingUser, handleTypingUpdate } from '../services/typing.js';
import { scheduleFrameTask } from './performance.js';
import { handleDccTransferProgress, showDccOffer } from '../ui/dcc.js';

function isCurrentNick(serverId, nick) {
  if (!nick || !state.config?.servers) return false;
  const currentNick = state.currentNicks?.[serverId];
  if (currentNick) return norm(nick) === norm(currentNick);
  const server = state.config.servers.find(s => String(s.id) === String(serverId));
  const configuredNick = server?.nickname || state.config.global_nickname;
  return norm(nick) === norm(configuredNick);
}

function isChannelBuffer(name) {
  return Boolean(name && (name.startsWith("#") || name.startsWith("&")));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getMainFallbackChannel(serverId) {
  const server = state.config?.servers?.find(s => String(s.id) === String(serverId));
  return server?.autojoin?.find(isChannelBuffer) || "#rumblr";
}

function restoreMessageHistoryFromSession() {
  const messages = sessionStore.getMessageSnapshot();
  const inbox = sessionStore.getInboxSnapshot();
  // Message snapshots are local-only app state. Restore them before selecting
  // the active buffer so the first render can show the saved scrollback.
  if (isRecord(messages) && Object.keys(messages).length) {
    state.messages = messages;
  }
  if (isRecord(inbox.unreads) && Object.keys(inbox.unreads).length) {
    state.unreads = inbox.unreads;
  }
}

function mergeChannelBuffers(...bufferLists) {
  const seen = new Set();
  const merged = [];
  bufferLists.flat().forEach((buffer) => {
    if (!isChannelBuffer(buffer)) return;
    const key = norm(buffer);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(buffer);
  });
  return merged;
}

function restoreJoinedBuffersFromSession(servers, savedSession) {
  const joinedBuffers = isRecord(savedSession.joinedBuffers) ? savedSession.joinedBuffers : {};
  servers.forEach((server) => {
    const savedBuffers = Array.isArray(joinedBuffers[String(server.id)]) ? joinedBuffers[String(server.id)] : [];
    const savedActive = String(server.id) === String(savedSession.activeServer) && isChannelBuffer(savedSession.activeChannel)
      ? [savedSession.activeChannel]
      : [];
    server.autojoin = mergeChannelBuffers(server.autojoin || [], savedBuffers, savedActive);
  });
}

function initialChannelForServer(server, savedSession) {
  const savedChannel = savedSession.activeChannel || "";
  if (!savedChannel) return server.autojoin?.[0] || "#general";
  if (!isChannelBuffer(savedChannel)) return savedChannel;
  const hasChannel = (server.autojoin || []).some((buffer) => norm(buffer) === norm(savedChannel));
  return hasChannel ? savedChannel : (server.autojoin?.[0] || "#general");
}

function ensureUserList(serverId, channel) {
  const nChan = norm(channel);
  if (!state.users[serverId]) state.users[serverId] = {};
  if (!state.users[serverId][nChan]) state.users[serverId][nChan] = [];
  return state.users[serverId][nChan];
}

function userNick(raw) {
  return norm(parseUser(raw).nick);
}

function normalizeUserList(list) {
  const seen = new Map();
  for (const raw of list || []) {
    const key = userNick(raw);
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || parseUser(raw).status.length > parseUser(existing).status.length) {
      seen.set(key, raw);
    }
  }
  return [...seen.values()];
}

function addUserToChannel(serverId, channel, username) {
  const list = ensureUserList(serverId, channel);
  const key = userNick(username);
  if (!key) return;
  const idx = list.findIndex(u => userNick(u) === key);
  if (idx === -1) list.push(username);
  else list[idx] = username;
  state.users[serverId][norm(channel)] = normalizeUserList(list);
}

function removeUserFromChannel(serverId, channel, username) {
  const nChan = norm(channel);
  if (!state.users[serverId]?.[nChan]) return;
  const key = userNick(username);
  state.users[serverId][nChan] = normalizeUserList(state.users[serverId][nChan].filter(u => userNick(u) !== key));
}

function removeUserFromServer(serverId, username) {
  Object.keys(state.users[serverId] || {}).forEach(c => {
    state.users[serverId][c] = normalizeUserList(state.users[serverId][c].filter(u => userNick(u) !== userNick(username)));
  });
}

function renameUserOnServer(serverId, oldNick, newNick) {
  Object.keys(state.users[serverId] || {}).forEach(c => {
    state.users[serverId][c] = normalizeUserList(state.users[serverId][c].map(raw => {
      const parsed = parseUser(raw);
      return userNick(raw) === userNick(oldNick) ? `${parsed.status || ""}${newNick}` : raw;
    }));
  });
}

function refreshUserSurfaces(serverId, channel = "") {
  if (server_idMatches(serverId)) {
    window.dispatchEvent(new CustomEvent("refresh-sidebar"));
    if (!channel || norm(channel) === norm(state.activeChannel)) {
      window.dispatchEvent(new CustomEvent("refresh-user-list"));
    }
  }
}

function server_idMatches(serverId) {
  return serverId?.toString() === state.activeServer?.toString();
}

function markServerLive(serverId) {
  const sid = String(serverId || "");
  const shouldRepairChrome = shouldReconcileLiveTraffic(state, sid);
  recordNetworkTraffic(state, sid);
  // Live IRC traffic repairs stale offline/retrying UI, but normal messages do
  // not rerender the sidebar on every line. That keeps busy channels fast while
  // still fixing the disconnected-but-receiving race immediately.
  if (shouldRepairChrome) {
    updateNetStatus(sid, "online", "Connected; receiving IRC traffic.");
  }
}

function getCurrentNick(serverId) {
  const server = state.config?.servers?.find(s => String(s.id) === String(serverId));
  return state.currentNicks?.[serverId] || server?.nickname || state.config?.global_nickname || "";
}

function formatDuration(ms) {
  const totalMinutes = Math.max(1, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function awayMessage() {
  const since = state.awaySince ? formatDuration(Date.now() - state.awaySince) : "a moment";
  return `I am currently away (${since}).`;
}

function canSendAwayReply(key) {
  const cooldownMs = 10 * 60 * 1000;
  const lastSent = state.awayReplyCooldowns[key] || 0;
  if (Date.now() - lastSent < cooldownMs) return false;
  state.awayReplyCooldowns[key] = Date.now();
  return true;
}

async function sendAwayReply(msg) {
  if (state.presence !== "away" || !msg?.server_id || !msg?.username) return;
  if (msg.username === "System" || msg.username === "Me" || isCurrentNick(msg.server_id, msg.username)) return;

  const myNick = getCurrentNick(msg.server_id);
  if (!myNick) return;

  const isChannel = msg.channel?.startsWith("#") || msg.channel?.startsWith("&");
  const isDirectMessage = msg.channel && !isChannel && !msg.channel.startsWith("(");
  const content = msg.content || "";

  if (isChannel) {
    if (!content.toLowerCase().includes(myNick.toLowerCase())) return;
    const key = `${msg.server_id}:${norm(msg.channel)}:${norm(msg.username)}:mention`;
    if (!canSendAwayReply(key)) return;
    await invoke("send_irc_message", {
      serverId: String(msg.server_id),
      channel: "system",
      content: `/notice ${msg.username} ${awayMessage()}`
    });
  } else if (isDirectMessage) {
    const key = `${msg.server_id}:${norm(msg.username)}:dm`;
    if (!canSendAwayReply(key)) return;
    await invoke("send_irc_message", {
      serverId: String(msg.server_id),
      channel: msg.username,
      content: awayMessage()
    });
  }
}

async function setPresence(status) {
  const next = ["online", "away", "busy"].includes(status) ? status : "online";
  state.presence = next;
  state.awaySince = next === "away" ? Date.now() : null;
  if (next !== "away") state.awayReplyCooldowns = {};
  sessionStore.setPresence(next);
  window.dispatchEvent(new CustomEvent("presence-updated", { detail: next }));

  document.querySelector("#presence-select")?.replaceChildren(
    ...["online", "away", "busy"].map(value => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value[0].toUpperCase() + value.slice(1);
      option.selected = value === next;
      return option;
    })
  );

  const indicator = document.querySelector(".status-indicator");
  if (indicator) indicator.className = `status-indicator ${next}`;

  await invoke("set_presence_status", { status: next }).catch(() => {});

  const awayText = next === "online" ? "/away" : `/away ${next === "busy" ? "Busy" : "Away"}`;
  for (const server of state.config?.servers || []) {
    if (state.netStatus[server.id] === "online") {
      invoke("send_irc_message", { serverId: String(server.id), channel: "system", content: awayText }).catch(() => {});
    }
  }
}

export async function boot() {
  window.state = state; // Dev/debug access and legacy command helpers.
  log("Initializing IRC Engine...");
  state.sessionStartTime = Date.now();
  try {
    state.config = await loadAppConfig();
    console.log("[BOOT] Config loaded:", state.config);
    restoreMessageHistoryFromSession();

    import('./config-applier.js').then(m => m.applyConfigToDom());

    for (const u of state.listeners) if (typeof u === 'function') u();
    state.listeners = [];

    state.listeners.push(await listen("debug-log", (e) => {
      log(e.payload);
      state.telemetryLogs.push({ timestamp: formatTimestamp(new Date()), content: e.payload });
      if (state.telemetryLogs.length > 500) state.telemetryLogs.shift();
      window.dispatchEvent(new CustomEvent("refresh-telemetry"));
    }));

    state.listeners.push(await listen("network-status", (e) => {
      const detail = e.payload;
      state.netDetails[detail.server_id] = {
        ...(state.netDetails[detail.server_id] || {}),
        ...detail,
        updated_at: Date.now(),
      };
      updateNetStatus(detail.server_id, detail.status);
      sessionStore.saveRuntimeSession(state);
    }));

    state.listeners.push(await listen("dcc-offer", (e) => {
      showDccOffer(e.payload);
    }));

    state.listeners.push(await listen("dcc-transfer-progress", (e) => {
      handleDccTransferProgress(e.payload);
    }));

    state.listeners.push(await listen("irc-message", (e) => {
      const msg = e.payload;
      markServerLive(msg.server_id);
      clearTypingUser(msg.server_id, msg.channel, msg.username);
      if (isChannelBuffer(msg.channel)) {
        discoverBuffer(msg.server_id, msg.channel);
      } else if (
        !document.body.classList.contains("messages-window") &&
        String(msg.server_id) === String(state.activeServer) &&
        norm(msg.channel) === norm(state.activeChannel)
      ) {
        selectChannel(msg.server_id, getMainFallbackChannel(msg.server_id));
      }
      state.totalMessagesProcessed++;
      sendAwayReply(msg);
      appendMessage(msg);
      sessionStore.saveMessageSnapshot(state.messages);
    }));

    state.listeners.push(await listen("typing-update", (e) => {
      handleTypingUpdate(e.payload);
    }));

    state.listeners.push(await listen("user-event", (e) => {
      const { server_id, channel, username, event_type, new_nick } = e.payload;
      markServerLive(server_id);
      const nChan = norm(channel);

      if (event_type === "TOPIC") {
        if (!state.topics[server_id]) state.topics[server_id] = {};
        state.topics[server_id][nChan] = new_nick;
        if (server_id.toString() === state.activeServer?.toString() && nChan === norm(state.activeChannel)) {
          updateChannelTopicHeader(server_id, channel);
        }
        appendMessage({ username: 'Topic', content: `New topic: ${new_nick}`, timestamp: formatTimestamp(new Date()), channel, server_id, msg_type: 'system' });
      } else if (event_type === "JOIN") {
        if (isCurrentNick(server_id, username)) state.currentNicks[server_id] = username;
        discoverBuffer(server_id, channel);
        addUserToChannel(server_id, channel, username);
        refreshUserSurfaces(server_id, channel);
      } else if (event_type === "PART") {
        removeUserFromChannel(server_id, channel, username);
        if (isCurrentNick(server_id, username)) {
          closeBuffer(server_id, channel);
          return;
        }
        refreshUserSurfaces(server_id, channel);
      } else if (event_type === "QUIT") {
        removeUserFromServer(server_id, username);
        refreshUserSurfaces(server_id);
      } else if (event_type === "NICK") {
        if (isCurrentNick(server_id, username)) state.currentNicks[server_id] = new_nick;
        renameUserOnServer(server_id, username, new_nick);
        refreshUserSurfaces(server_id);
      }
    }));

    state.listeners.push(await listen("irc-list-start", () => {
      // LIST replies can arrive long after the user closes the browser. Keep the
      // cache fresh, but never reopen the panel from network traffic.
      state.channelListResults = [];
      state.isListing = true;
      state.channelListError = "";
      state.channelListStatusMessage = "Receiving channel list...";
      window.dispatchEvent(new CustomEvent("refresh-list-view"));
    }));

    state.listeners.push(await listen("irc-list-item", (e) => {
      if (!state.isListing) {
        state.channelListResults = [];
        state.isListing = true;
      }
      state.channelListError = "";
      state.channelListStatusMessage = "Receiving channel list...";
      state.channelListResults.push(e.payload);
      if (state.channelListResults.length % 50 === 0) {
        window.dispatchEvent(new CustomEvent("refresh-list-view"));
      }
    }));

    state.listeners.push(await listen("irc-list-end", () => {
      state.isListing = false;
      state.channelListStatusMessage = state.channelListResults.length
        ? ""
        : "The network ended LIST without returning any visible channels.";
      state.channelListResults.sort((a, b) => (parseInt(b.users) || 0) - (parseInt(a.users) || 0));
      window.dispatchEvent(new CustomEvent("refresh-list-view"));
    }));

    state.listeners.push(await listen("irc-list-error", (e) => {
      state.isListing = false;
      state.channelListError = e.payload?.message || "The network could not complete LIST.";
      state.channelListStatusMessage = state.channelListError;
      window.dispatchEvent(new CustomEvent("refresh-list-view"));
    }));

    state.listeners.push(await listen("user-list-item", (e) => {
      const { server_id, channel, users } = e.payload;
      const key = `${server_id}:${norm(channel)}`;
      if (!state.pendingUserList[key]) state.pendingUserList[key] = [];
      state.pendingUserList[key].push(...users);
    }));

    state.listeners.push(await listen("user-list-end", (e) => {
      const { server_id, channel } = e.payload;
      const key = `${server_id}:${norm(channel)}`;
      if (!state.users[server_id]) state.users[server_id] = {};
      state.users[server_id][norm(channel)] = normalizeUserList(state.pendingUserList[key] || []);
      delete state.pendingUserList[key];
      refreshUserSurfaces(server_id, channel);
    }));

    state.listeners.push(await listen("open-about", () => {
      ui.show("#about-modal");
    }));

    state.listeners.push(await listen("open-options", () => {
      import('../ui/modals.js').then(m => m.openConfig());
    }));

    window.addEventListener("refresh-sidebar", () => {
      scheduleFrameTask("refresh-sidebar", () => {
        renderSidebar();
        renderUserList();
      });
    });
    window.addEventListener("refresh-messages", () => {
      scheduleFrameTask("boot-refresh-messages", () => renderMessages(state.activeServer, state.activeChannel));
    });
    window.addEventListener("buffers-changed", () => {
      sessionStore.saveRuntimeSession(state);
    });

    renderSidebar();
    startMetricsPulse();
    document.querySelector("#presence-select")?.addEventListener("change", (e) => setPresence(e.target.value));
    window.setRumblrPresence = setPresence;
    setPresence(sessionStore.getPresence(state.presence));

    // Startup Network Selection
    if (state.config.servers?.length > 0) {
      const servers = state.config.servers;
      const savedSession = sessionStore.getSessionState();
      restoreJoinedBuffersFromSession(servers, savedSession);
      
      servers.forEach(s => {
        if (!state.netStatus[s.id]) updateNetStatus(s.id, 'offline');
      });

      const savedServer = servers.find(s => String(s.id) === String(savedSession.activeServer));
      const firstSrv = savedServer || servers[0];
      const initialChannel = initialChannelForServer(firstSrv, savedSession);
      state.activeServer = String(firstSrv.id);
      if (savedSession.unreads && typeof savedSession.unreads === "object") state.unreads = savedSession.unreads;
      if (savedSession.netDetails && typeof savedSession.netDetails === "object") state.netDetails = savedSession.netDetails;
      selectChannel(firstSrv.id, initialChannel);

      if (state.config.auto_connect === true) {
        log(`[BOOT] Workstation preparing network layer...`);
        selectServer(servers[0].id).then(() => {
           log(`[BOOT] Handshake initiated for ${servers[0].name}.`);
        });
        
        if (state.config.multi_network) {
          for (let i = 1; i < servers.length; i++) {
            const s = servers[i];
            invoke("connect_to_server", { serverId: String(s.id) });
          }
        }
      }
      sessionStore.saveRuntimeSession(state);
    }

    appendMessage({ username: 'System', content: 'RUMBLR IRC INITIALIZED. READY FOR COMMUNICATION.', timestamp: formatTimestamp(new Date()), channel: 'system', server_id: 'global' });
    log("Rumblr Ready.");

    if (window.mediaInterval) clearInterval(window.mediaInterval);
    window.mediaInterval = setInterval(updateMediaWidget, 10000);
  } catch (e) {
    log(`Boot Failure: ${e}`);
  }
}
