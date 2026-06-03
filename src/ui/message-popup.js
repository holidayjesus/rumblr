import { state } from '../core/state.js';
import { serverLabel } from '../core/buffers.js';
import { el } from './dom.js';

let dismissTimer = null;

function popupEnabled() {
  return state.config?.notifications_enabled !== false && state.notificationRules?.popupAlerts !== false;
}

export function showMessagePopup(msg, { isMention = false, isDm = false } = {}) {
  if (!popupEnabled() || (!isMention && !isDm)) return;

  let container = document.querySelector("#message-popup-stack");
  if (!container) {
    container = document.createElement("div");
    container.id = "message-popup-stack";
    document.body.appendChild(container);
  }

  const title = msg.username || msg.channel || "Message";
  const network = serverLabel(state, msg.server_id);
  const buffer = msg.channel || "";
  const content = String(msg.content || "").slice(0, 160);
  const toast = document.createElement("button");
  toast.type = "button";
  toast.className = `message-popup ${isMention ? "is-mention" : ""}`;
  // Popups render IRC text as nodes instead of interpolated markup because a
  // direct message can contain arbitrary service or user-provided content.
  toast.append(
    el("span", { className: "message-popup-kicker", text: isMention ? "Mention" : "Message" }),
    el("strong", { text: title }),
    el("span", { className: "message-popup-meta", text: `${network}${buffer ? ` - ${buffer}` : ""}` }),
    el("span", { className: "message-popup-body", text: content }),
  );

  // Popups are intentionally click-to-open instead of auto-stealing focus.
  toast.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("message-popup-open", {
      detail: { serverId: msg.server_id, buffer },
    }));
    toast.remove();
  });

  container.replaceChildren(toast);
  clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => toast.remove(), 6200);
}
