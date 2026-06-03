import { state } from '../core/state.js';
import { sessionStore } from '../core/persistence.js';
import { attentionItems, isChannelBuffer } from '../core/buffers.js';
import { ui } from './ui-engine.js';
import { syncNativeUnreadState } from './messages.js';
import { clear, el } from './dom.js';

export function markAllAttentionRead() {
  // The Attention Center is only a projection of state.unreads. Clearing that
  // map makes sidebar badges, native badges, and persisted session state agree.
  state.unreads = {};
  sessionStore.saveInboxSnapshot({
    messages: state.messages,
    unreads: state.unreads,
    activeServer: String(state.activeServer || ""),
  });
  sessionStore.saveRuntimeSession(state);
  syncNativeUnreadState();
  syncAttentionButton();
  window.dispatchEvent(new CustomEvent("refresh-sidebar"));
  window.dispatchEvent(new CustomEvent("messages-updated"));
}

export function syncAttentionButton() {
  const badge = document.querySelector("#attention-badge");
  const trigger = document.querySelector("#btn-open-mentions");
  if (!badge || !trigger) return;
  const items = attentionItems(state);
  const count = items.reduce((total, item) => total + (Number(item.count) || 0), 0);
  const hasMention = items.some(item => item.isMention);
  trigger.classList.toggle("has-attention", count > 0);
  trigger.classList.toggle("has-mention", hasMention);
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.style.display = count > 0 ? "grid" : "none";
}

export function renderMentionsCenter({ openConversation, switchBuffer } = {}) {
  const container = document.querySelector("#mentions-results");
  if (!container) return;
  syncAttentionButton();
  const items = attentionItems(state);
  if (!items.length) {
    clear(container);
    container.appendChild(el("div", { className: "mentions-empty" }, [
      el("strong", { text: "Nothing needs attention" }),
      el("span", { text: "Mentions and unread conversations will collect here." }),
    ]));
    return;
  }

  clear(container);
  items.forEach((item) => {
    // Attention rows contain IRC buffer names and message previews. Build them
    // as text nodes so service notices and nicknames cannot become markup.
    const row = el("button", {
      className: `mentions-row ${item.isMention ? "priority" : ""}`,
      type: "button",
    }, [
      el("span", { className: "mentions-kind", text: item.isMention ? "Mention" : "Unread" }),
      el("span", { className: "mentions-title", text: item.buffer }),
      el("span", { className: "mentions-meta", text: `${item.serverName} - ${item.count} unread` }),
      el("span", { className: "mentions-preview", text: item.last?.content || "No preview available" }),
    ]);
    row.addEventListener("click", () => {
      if (isChannelBuffer(item.buffer)) {
        switchBuffer?.(item.serverId, item.buffer);
      } else {
        openConversation?.(item.buffer, item.serverId);
      }
      ui.hide("#mentions-panel");
    });
    container.appendChild(row);
  });
}

export function openMentionsCenter(handlers = {}) {
  ui.show("#mentions-panel", "flex");
  renderMentionsCenter(handlers);
}
