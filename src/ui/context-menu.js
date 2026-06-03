import { state } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { el } from './dom.js';
import { openDccPanel } from './dcc.js';

let activeMenu = null;
let openedWithKey = false;

function showContextMenu(x, y, children, width = 180, height = 220) {
  closeContextMenu();

  const menu = el('div', { className: 'ctx-menu' }, children);

  let left = x;
  let top = y;
  if (left + width > window.innerWidth) left -= width;
  if (top + height > window.innerHeight) top -= height;

  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  document.body.appendChild(menu);
  activeMenu = menu;

  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    window.addEventListener('keyup', handleKeyUp);
  }, 0);

  return menu;
}

function ctxItem(id, label, options = {}) {
  return el("div", { id, className: `ctx-item ${options.danger ? "danger" : ""}`.trim(), text: label });
}

function ctxLabel(label) {
  return el("div", { className: "ctx-label", text: label });
}

function ctxSeparator() {
  return el("div", { className: "ctx-separator" });
}

function bindMenuItem(menu, selector, action) {
  menu.querySelector(selector)?.addEventListener("click", () => {
    action?.();
    closeContextMenu();
  });
}

export function showNickMenu(x, y, nick, event = null, handlers = {}) {
  closeContextMenu();
  
  openedWithKey = event ? (event.ctrlKey || event.metaKey) : false;

  const menu = showContextMenu(x, y, [
    ctxItem("ctx-pm", "Open PM"),
    ctxItem("ctx-whois", "WHOIS"),
    ctxItem("ctx-dcc", "DCC / XDCC"),
    ctxItem("ctx-mention", "@ Mention"),
    ctxSeparator(),
    ctxItem("ctx-ignore", "Ignore User"),
  ], 180, 220);

  // Context menus carry raw IRC nicknames in callbacks, so labels are static
  // text nodes and the network value never passes through menu markup.
  bindMenuItem(menu, '#ctx-pm', () => handlers.onPm?.(nick));
  bindMenuItem(menu, '#ctx-whois', () => invoke('send_irc_message', { serverId: state.activeServer, channel: 'system', content: `/whois ${nick}` }));
  bindMenuItem(menu, '#ctx-dcc', () => openDccPanel(nick));
  bindMenuItem(menu, '#ctx-mention', () => { 
    const input = document.querySelector("#chat-input");
    if (input) {
      input.value = `${nick}: ${input.value}`;
      input.focus();
    }
  });
}

export function showBufferMenu(x, y, serverId, bufferName, handlers = {}) {
  closeContextMenu();

  const isChannel = bufferName.startsWith("#") || bufferName.startsWith("&");
  const title = isChannel ? "Channel" : "Direct Message";
  const children = [
    ctxLabel(title),
    ctxItem("ctx-open", "Open"),
    ctxItem("ctx-mark-read", "Mark Read"),
    ctxItem("ctx-mute", handlers.isMuted?.() ? "Unmute Buffer" : "Mute Buffer"),
    ctxItem("ctx-copy", "Copy Name"),
    ctxSeparator(),
    ctxItem("ctx-clear", "Clear Scrollback"),
  ];
  if (isChannel) children.push(ctxItem("ctx-part", "Part Channel", { danger: true }));
  children.push(ctxItem("ctx-hide", isChannel ? "Hide Buffer" : "Close DM", { danger: true }));
  const menu = showContextMenu(x, y, children, 200, isChannel ? 270 : 235);

  bindMenuItem(menu, '#ctx-open', () => handlers.onOpen?.());
  bindMenuItem(menu, '#ctx-mark-read', () => handlers.onMarkRead?.());
  bindMenuItem(menu, '#ctx-mute', () => handlers.onMute?.());
  bindMenuItem(menu, '#ctx-copy', () => {
    navigator.clipboard?.writeText(bufferName).catch(() => {});
  });
  bindMenuItem(menu, '#ctx-clear', () => handlers.onClear?.());
  bindMenuItem(menu, '#ctx-hide', () => handlers.onHide?.());
  bindMenuItem(menu, '#ctx-part', () => handlers.onPart?.());
}

export function showMessageMenu(x, y, msg, handlers = {}) {
  const menu = showContextMenu(x, y, [
    ctxLabel("Message"),
    ctxItem("ctx-copy-message", "Copy Text"),
    ctxItem("ctx-copy-line", "Copy Transcript Line"),
    ctxItem("ctx-copy-link", "Copy Local Link"),
    ctxSeparator(),
    ctxItem("ctx-reply", "Reply to Nick"),
  ], 210, 220);

  bindMenuItem(menu, '#ctx-copy-message', () => {
    navigator.clipboard?.writeText(msg.content || "").catch(() => {});
  });
  bindMenuItem(menu, '#ctx-copy-line', () => {
    const line = `[${msg.timestamp || ""}] <${msg.username || "system"}> ${msg.content || ""}`;
    navigator.clipboard?.writeText(line).catch(() => {});
  });
  bindMenuItem(menu, '#ctx-copy-link', () => {
    const link = `rumblr://${encodeURIComponent(msg.server_id || "")}/${encodeURIComponent(msg.channel || "")}/${encodeURIComponent(msg.id || "")}`;
    navigator.clipboard?.writeText(link).catch(() => {});
  });
  bindMenuItem(menu, '#ctx-reply', () => {
    handlers.onReply?.(msg.username);
  });
}

export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('click', handleClickOutside);
    window.removeEventListener('keyup', handleKeyUp);
  }
}

export const closeNickMenu = closeContextMenu;

function handleClickOutside(e) {
  if (activeMenu && !activeMenu.contains(e.target)) {
    closeNickMenu();
  }
}

function handleKeyUp(e) {
  if (openedWithKey && (e.key === 'Control' || e.key === 'Meta')) {
    closeNickMenu();
  }
}
