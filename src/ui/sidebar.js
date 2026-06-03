import { state, norm, parseUser, hierarchy } from '../core/state.js';
import { ui, focusInput, log } from './ui-engine.js';
import { renderMessages, getNickColor, markActiveBufferRead, syncNativeUnreadState } from './messages.js';
import { invoke } from '../core/tauri.js';
import { saveAppConfig } from '../core/config-store.js';
import { sessionStore } from '../core/persistence.js';
import { connectionDetailMessage, setRuntimeNetworkStatus } from '../core/network-state.js';
import { showNickMenu, showBufferMenu } from './context-menu.js';
import { el, svgEl } from './dom.js';
import { avatarUrlForNick } from './avatar.js';

const CHANNEL_WIPE_HOLD_MS = 950;

export function renderSidebar() {
  const channelContainer = document.querySelector("#channel-list");
  const serverDisplay = document.querySelector("#current-server-host");
  
  if (!channelContainer || !state.config?.servers) return;

  // Update Server Display
  if (state.config.servers.length > 0) {
    const activeSrvId = String(state.activeServer);
    const s = state.config.servers.find(srv => String(srv.id) === activeSrvId) || state.config.servers[0];
    if (s) {
      const nameEl = document.querySelector("#current-server-name");
      const hostEl = document.querySelector("#current-server-host");
      const connBtn = document.querySelector("#btn-server-connect");
      const detailEl = document.querySelector("#connection-detail");
      const serverId = String(s.id);

      if (nameEl) nameEl.textContent = s.name || "Unknown Network";
      if (hostEl) hostEl.textContent = `${s.host}:${s.port}`;
      
      if (connBtn) {
        const status = state.netStatus[serverId] || 'offline';
        if (detailEl) {
          detailEl.textContent = connectionDetailMessage(state, serverId, status);
          detailEl.style.display = 'block';
        }
        
        if (status === 'online') {
          setButtonContent(connBtn, "DISCONNECT", connectButtonIcon("disconnect"));
          connBtn.classList.add("online");
          connBtn.onclick = async () => {
            await invoke("disconnect_from_server", { serverId: String(s.id) });
            state.users[s.id] = {};
            updateNetStatus(s.id, 'offline');
          };
        } else if (status === 'connecting' || status === 'retrying') {
          setButtonContent(connBtn, status === 'retrying' ? "CANCEL RETRY" : "CANCEL CONNECT");
          connBtn.classList.remove("online");
          connBtn.onclick = async () => {
            await invoke("disconnect_from_server", { serverId: String(s.id) });
            state.users[s.id] = {};
            state.netDetails[s.id] = { server_id: String(s.id), status: 'offline', message: 'Canceled.', retry_in: null, attempt: null };
            updateNetStatus(s.id, 'offline');
          };
        } else {
          setButtonContent(connBtn, "CONNECT NOW", connectButtonIcon("connect"));
          connBtn.classList.remove("online");
          connBtn.onclick = () => selectServer(s.id);
        }
        if (status === 'failed') {
          setButtonContent(connBtn, "RETRY NOW");
        }
      }
    }
  }

  channelContainer.replaceChildren();

  const activeSrvId = String(state.activeServer);
  const activeServer = state.config.servers.find(srv => String(srv.id) === activeSrvId) || state.config.servers[0];

  if (activeServer) {
    const originalAutojoin = Array.isArray(activeServer.autojoin) ? activeServer.autojoin : [];
    const channelAutojoin = originalAutojoin.filter(b => b.startsWith("#") || b.startsWith("&"));
    if (channelAutojoin.length !== originalAutojoin.length) {
      activeServer.autojoin = channelAutojoin;
      saveAppConfig().catch(() => {});
    }
    const buffers = [...new Set(channelAutojoin)];
    
    buffers.forEach(b => {
      const nB = norm(b);
      const unreadCount = state.unreads[activeServer.id]?.[nB] || 0;
      const isMention = state.unreads[activeServer.id]?.[nB + ':mention'];
      const isMuted = state.notificationRules?.mutedBuffers?.[`${activeServer.id}:${nB}`];
      const isActive = String(state.activeServer) === String(activeServer.id) && norm(state.activeChannel) === nB;
      const userCount = state.users[activeServer.id]?.[nB]?.length || 0;

      const item = document.createElement("div");
      item.className = `list-item ${isActive ? 'active' : ''}`;
      if (unreadCount > 0) item.classList.add("unread");
      if (isMention) item.classList.add("mention");

      const isChannel = b.startsWith("#") || b.startsWith("&");
      // Channel names are saved session/config text. Compose the row from DOM
      // nodes so a hostile buffer name cannot become an attribute or element.
      item.append(channelRowIcon(isChannel), el("span", { className: "item-name", text: b }));
      if (isMuted) item.appendChild(el("span", { className: "muted-indicator", text: "MUTED" }));
      if (userCount > 0) item.appendChild(el("span", { className: "channel-count", text: userCount }));
      if (unreadCount > 0) item.appendChild(el("span", { className: "unread-badge", text: unreadCount }));
      item.onclick = () => {
        if (item.dataset.wipeCompleted === "true") {
          delete item.dataset.wipeCompleted;
          return;
        }
        selectChannel(activeServer.id, b);
      };
      item.oncontextmenu = (event) => {
        event.preventDefault();
        showBufferMenu(event.clientX, event.clientY, activeServer.id, b, {
          onOpen: () => selectChannel(activeServer.id, b),
          onMarkRead: () => markBufferRead(activeServer.id, b),
          isMuted: () => Boolean(state.notificationRules?.mutedBuffers?.[`${activeServer.id}:${nB}`]),
          onMute: () => toggleBufferMute(activeServer.id, b),
          onClear: () => clearBufferScrollback(activeServer.id, b),
          onHide: () => closeBuffer(activeServer.id, b),
          onPart: () => partChannel(activeServer.id, b),
        });
      };
      if (isChannel) attachChannelWipeGesture(item, activeServer.id, b);
      
      if (isChannel) channelContainer.appendChild(item);
    });
  }
}

function setButtonContent(button, label, icon = null) {
  button.replaceChildren();
  if (icon) button.appendChild(icon);
  button.appendChild(document.createTextNode(label));
}

function connectButtonIcon(kind) {
  const children = kind === "disconnect"
    ? [svgEl("path", { d: "M12 2v20M2 12h20" })]
    : [
        svgEl("path", { d: "m5 12 7-7 7 7" }),
        svgEl("path", { d: "M12 19V5" }),
      ];
  return svgEl("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }, children);
}

function channelRowIcon(isChannel) {
  if (!isChannel) {
    return el("div", {
      className: "status-dot-mini",
      style: {
        background: "var(--primary)",
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        marginRight: "11px",
        marginLeft: "3px",
      },
    });
  }
  const icon = svgEl("svg", {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }, [svgEl("path", { d: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" })]);
  icon.style.marginRight = "8px";
  icon.style.opacity = "0.6";
  return icon;
}

export function updateChannelTopicHeader(serverId = state.activeServer, channel = state.activeChannel) {
  const topicEl = document.querySelector("#channel-topic");
  if (!topicEl) return;
  const isChannel = channel?.startsWith("#") || channel?.startsWith("&");
  const topic = state.topics?.[serverId]?.[norm(channel)] || "";
  topicEl.textContent = isChannel ? (topic || "No topic set") : "Direct conversation";
  topicEl.title = topic || "";
  topicEl.classList.toggle("empty", !topic);
}

function attachChannelWipeGesture(item, serverId, channel) {
  let holdTimer = null;
  let raf = null;
  let startedAt = 0;
  let pointerId = null;
  let didComplete = false;

  const reset = () => {
    if (holdTimer) clearTimeout(holdTimer);
    if (raf) cancelAnimationFrame(raf);
    holdTimer = null;
    raf = null;
    startedAt = 0;
    pointerId = null;
    item.classList.remove("wipe-arming", "wipe-complete");
    item.style.removeProperty("--wipe-progress");
  };

  const tick = () => {
    if (!startedAt) return;
    const progress = Math.min(1, (performance.now() - startedAt) / CHANNEL_WIPE_HOLD_MS);
    item.style.setProperty("--wipe-progress", `${progress * 100}%`);
    if (progress < 1) raf = requestAnimationFrame(tick);
  };

  const complete = async () => {
    didComplete = true;
    item.dataset.wipeCompleted = "true";
    item.classList.add("wipe-complete");
    item.style.setProperty("--wipe-progress", "100%");
    await partChannel(serverId, channel);
    reset();
  };

  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    didComplete = false;
    pointerId = event.pointerId;
    startedAt = performance.now();
    item.classList.add("wipe-arming");
    item.style.setProperty("--wipe-progress", "0%");
    item.setPointerCapture?.(pointerId);
    raf = requestAnimationFrame(tick);
    holdTimer = setTimeout(complete, CHANNEL_WIPE_HOLD_MS);
  });

  item.addEventListener("pointerup", () => {
    if (!didComplete) reset();
  });
  item.addEventListener("pointercancel", reset);
  item.addEventListener("pointerleave", () => {
    if (!didComplete) reset();
  });
}

export function selectChannel(serverId, channel) {
  state.activeServer = serverId;
  state.activeChannel = channel;
  const nBuffer = norm(channel);
  if (state.unreads[serverId]) {
    state.unreads[serverId][nBuffer] = 0;
    delete state.unreads[serverId][nBuffer + ':mention'];
  }
  syncNativeUnreadState();
  markActiveBufferRead();

  const isList = channel === '(LIST)';
  const isLogs = channel === '(LOGS)';
  const chanDisp = isList ? "NETWORK DISCOVERY" : (isLogs ? "SYSTEM TELEMETRY" : (channel.startsWith("#") ? channel : `@ ${channel}`));
  
  ui.set("#channel-name", chanDisp);
  ui.set("#top-channel-name", chanDisp);
  ui.set("#right-channel-name", isList ? "DISCOVERY" : (isLogs ? "TELEMETRY" : channel));
  updateChannelTopicHeader(serverId, channel);

  renderMessages(serverId, channel);
  renderSidebar();
  renderUserList();
  focusInput();
  sessionStore.saveRuntimeSession(state);

  // Functional Hardening: Auto-Join on selection if online
  if (channel.startsWith("#") || channel.startsWith("&")) {
    const status = state.netStatus[serverId];
    if (status === 'online') {
      invoke("send_irc_message", { serverId: String(serverId), channel: "system", content: `/join ${channel}` });
    }
  }
}

export function closeBuffer(serverId, channel, options = {}) {
  const { save = true } = options;
  const activeSrvId = String(serverId);
  const srv = state.config.servers.find(s => String(s.id) === activeSrvId);
  if (srv) {
    const nChannel = norm(channel);
    const autojoin = Array.isArray(srv.autojoin) ? srv.autojoin : [];
    srv.autojoin = autojoin.filter(b => norm(b) !== nChannel);
    if (state.messages[activeSrvId]) delete state.messages[activeSrvId][nChannel];
    if (state.unreads[activeSrvId]) {
      delete state.unreads[activeSrvId][nChannel];
      delete state.unreads[activeSrvId][`${nChannel}:mention`];
    }
    syncNativeUnreadState();
    if (state.users[activeSrvId]) delete state.users[activeSrvId][nChannel];

    if (String(state.activeServer) === activeSrvId && norm(state.activeChannel) === nChannel) {
      const nextBuffer = srv.autojoin.find(b => (b.startsWith("#") || b.startsWith("&"))) || srv.autojoin[0] || "system";
      selectChannel(serverId, nextBuffer);
    } else {
      renderSidebar();
    }
    if (save) saveAppConfig().catch(() => {});
  }
}

window.closeBuffer = closeBuffer;

function toggleBufferMute(serverId, channel) {
  if (!state.notificationRules) state.notificationRules = { mutedBuffers: {} };
  if (!state.notificationRules.mutedBuffers) state.notificationRules.mutedBuffers = {};
  const key = `${serverId}:${norm(channel)}`;
  if (state.notificationRules.mutedBuffers[key]) delete state.notificationRules.mutedBuffers[key];
  else state.notificationRules.mutedBuffers[key] = true;
  if (state.config) {
    state.config.notification_rules = {
      ...(state.config.notification_rules || {}),
      muted_buffers: state.notificationRules.mutedBuffers,
    };
    saveAppConfig().catch(() => {});
  }
  renderSidebar();
}

function markBufferRead(serverId, channel) {
  const nBuffer = norm(channel);
  if (!state.unreads[serverId]) state.unreads[serverId] = {};
  state.unreads[serverId][nBuffer] = 0;
  delete state.unreads[serverId][nBuffer + ':mention'];
  syncNativeUnreadState();
  renderSidebar();
}

function clearBufferScrollback(serverId, channel) {
  if (!state.messages[serverId]) state.messages[serverId] = {};
  state.messages[serverId][norm(channel)] = [];
  if (String(state.activeServer) === String(serverId) && norm(state.activeChannel) === norm(channel)) {
    renderMessages(serverId, channel);
  }
}

async function partChannel(serverId, channel) {
  const channelName = channel.startsWith("#") || channel.startsWith("&") ? channel : `#${channel}`;
  if (state.netStatus[serverId] === 'online') {
    await invoke("send_irc_message", { serverId: String(serverId), channel: "system", content: `/part ${channelName}` }).catch(e => log(`Part failed: ${e}`));
  }
  closeBuffer(serverId, channelName);
}

function primaryUserStatus(status = "") {
  if (status.includes("~")) return "~";
  if (status.includes("&")) return "&";
  if (status.includes("@")) return "@";
  if (status.includes("%")) return "%";
  if (status.includes("+")) return "+";
  return "";
}

function userStatusIcon(status = "") {
  const primary = primaryUserStatus(status);
  const labels = {
    "~": "Owner",
    "&": "Admin",
    "@": "Operator",
    "%": "Half operator",
    "+": "Voice",
    "": "Here",
  };
  const roleClass = {
    "~": "owner",
    "&": "admin",
    "@": "operator",
    "%": "halfop",
    "+": "voice",
    "": "here",
  }[primary];
  const iconPaths = {
    "~": ["M5 20h14l-1.4-8.2-4.1 3.4L12 6l-1.5 9.2-4.1-3.4L5 20Z", "M7 22h10"],
    "&": ["M12 3 4 7v6c0 5 3.4 7.6 8 9 4.6-1.4 8-4 8-9V7l-8-4Z", "M12 7v10", "M8 11h8"],
    "@": ["M14.7 3 21 3.4l.4 6.3L9.1 22 3 15.9 14.7 3Z", "m4 20 5-5", "m2.5 13.5 8 8"],
    "%": ["M14 3 5 12l4 4 9-9V3h-4Z", "m4 20 5-5", "m3 11 6 6"],
    "+": ["M12 4v16", "M8 8h5a4 4 0 0 1 0 8H8", "M16 7.5c1.4.9 2.2 2.5 2.2 4.5s-.8 3.6-2.2 4.5"],
  };
  const iconChildren = primary
    ? iconPaths[primary].map((d) => svgEl("path", { d }))
    : [svgEl("circle", { cx: 12, cy: 12, r: 4 })];
  return el("div", {
    className: `member-status-icon role-${roleClass}`,
    title: labels[primary],
    "aria-label": labels[primary],
  }, [
    svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, iconChildren),
  ]);
}

function userRoleGroup(status = "") {
  const primary = primaryUserStatus(status);
  if (primary === "~" || primary === "&") return "staff";
  if (primary === "@" || primary === "%") return "moderators";
  return "members";
}

function memberStatusElement(status = "") {
  return userStatusIcon(status);
}

export function renderRightSidebar(serverId, channel) {
  const container = document.querySelector("#right-sidebar-dynamic-content");
  if (!container) return;
  const isChannel = channel.startsWith("#");
  if (!isChannel && channel !== '(LIST)' && channel !== '(LOGS)') {
    container.replaceChildren();
    const profile = document.createElement("div");
    profile.className = "right-pm-profile";
    const hero = document.createElement("div");
    hero.className = "pm-hero";
    const avatar = document.createElement("div");
    avatar.className = "pm-avatar-large";
    const img = document.createElement("img");
    img.src = avatarUrlForNick(channel, serverId);
    img.alt = "";
    avatar.appendChild(img);
    const meta = document.createElement("div");
    meta.className = "pm-meta";
    const title = document.createElement("h3");
    title.style.color = getNickColor(channel);
    title.textContent = channel;
    const label = document.createElement("span");
    label.textContent = "Private Dialogue";
    meta.append(title, label);
    hero.append(avatar, meta);
    profile.appendChild(hero);
    container.appendChild(profile);
  } else {
    renderUserList();
  }
}

export function renderUserList() {
  const container = document.querySelector("#user-list-content");
  const countEls = ["#right-user-count", "#top-user-count"];
  const isChannel = state.activeChannel.startsWith("#") || state.activeChannel.startsWith("&");
  if (!container || !isChannel) {
    if (container) container.replaceChildren();
    countEls.forEach(id => ui.set(id, id === "#top-user-count" ? "0 users" : "0"));
    return;
  }
  const activeServerId = String(state.activeServer || "");
  const activeBuffer = norm(state.activeChannel);
  const users = state.users[activeServerId]?.[activeBuffer] || [];
  const parsedUsers = users.map(u => parseUser(u));
  const sorted = [...parsedUsers].sort((a, b) => (hierarchy[primaryUserStatus(a.status)] ?? 5) - (hierarchy[primaryUserStatus(b.status)] ?? 5));
  
  const userCount = sorted.length;
  ui.set("#right-user-count", userCount);
  ui.set("#top-user-count", `${userCount} ${userCount === 1 ? "user" : "users"}`);
  const groups = [
    { key: "staff", label: "Staff" },
    { key: "moderators", label: "Channel Moderators" },
    { key: "members", label: "Members" },
  ].map(group => ({
    ...group,
    users: sorted.filter(u => userRoleGroup(u.status) === group.key),
  })).filter(group => group.users.length > 0);

  container.replaceChildren();
  groups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "member-group";
    section.dataset.group = group.key;

    const header = document.createElement("div");
    header.className = "member-group-header";
    const label = document.createElement("span");
    label.textContent = group.label;
    const count = document.createElement("strong");
    count.textContent = group.users.length;
    header.append(label, count);

    const list = document.createElement("div");
    list.className = "member-group-list";
    group.users.forEach((user) => {
      // Nicknames arrive from the IRC network, so the member list uses DOM
      // nodes and listeners instead of interpolating nicks into HTML attrs.
      const row = document.createElement("div");
      row.className = "member-row";
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        window.onNickClick?.(event, user.nick);
      });

      const avatar = document.createElement("div");
      avatar.className = "member-avatar";
      const img = document.createElement("img");
      img.src = avatarUrlForNick(user.nick, activeServerId);
      img.alt = "";
      avatar.appendChild(img);

      const nick = document.createElement("div");
      nick.className = "member-nick";
      nick.style.color = getNickColor(user.nick);
      nick.textContent = user.nick;

      row.append(avatar, nick);
      const statusIcon = memberStatusElement(user.status);
      if (statusIcon) row.appendChild(statusIcon);
      list.appendChild(row);
    });

    section.append(header, list);
    container.appendChild(section);
  });
}

export function setupSidebarResizer() {
  const resizer = document.querySelector("#sidebar-resize-handle");
  const sidebar = document.querySelector(".sidebar");
  if (!resizer || !sidebar) return;
  let isResizing = false;
  resizer.addEventListener('pointerdown', (e) => { isResizing = true; resizer.classList.add('active'); e.preventDefault(); });
  window.addEventListener('pointermove', (e) => { if (isResizing) sidebar.style.width = `${Math.max(180, Math.min(450, e.clientX))}px`; });
  window.addEventListener('pointerup', () => { isResizing = false; resizer.classList.remove('active'); });
}

export async function selectServer(id) {
  const srvId = String(id);
  state.activeServer = srvId;
  sessionStore.setActiveServer(srvId);
  try {
    updateNetStatus(srvId, 'connecting');
    await invoke("connect_to_server", { serverId: srvId });
  } catch (e) { log(`Connection Error: ${e}`); updateNetStatus(srvId, 'offline'); }
}

window.selectServer = selectServer;
window.selectChannel = selectChannel;

export function updateNetStatus(serverId, status, message = "") {
  const sid = setRuntimeNetworkStatus(state, serverId, status, message);
  if (status === 'online' && (state.presence === 'away' || state.presence === 'busy')) {
    const awayText = state.presence === 'busy' ? '/away Busy' : '/away Away';
    invoke("send_irc_message", { serverId: sid, channel: "system", content: awayText }).catch(() => {});
  }
  renderSidebar();
  renderUserList();
  sessionStore.saveRuntimeSession(state);
}
