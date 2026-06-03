import { state } from '../core/state.js';

export const ui = {
  set: (id, val) => {
    const el = document.querySelector(id);
    if (el) el.textContent = val;
  },
  val: (id, val) => {
    const el = document.querySelector(id);
    if (!el) return "";
    if (val !== undefined) el.value = val;
    return el.value;
  },
  show: (id, display = 'block') => {
    const el = document.querySelector(id);
    if (el) {
      if (el.classList.contains('modal-overlay')) {
        el.style.display = 'flex';
        el.classList.add('active');
      } else {
        el.style.display = display;
      }
    }
  },
  hide: (id) => {
    const el = document.querySelector(id);
    if (el) {
      el.style.display = 'none';
      if (el.classList.contains('modal-overlay')) el.classList.remove('active');
    }
  },
  on: (id, evt, cb) => {
    const el = document.querySelector(id);
    if (el) el.addEventListener(evt, cb);
    else {
      // Fallback for dynamically generated elements
      document.body.addEventListener(evt, (e) => {
        if (e.target.closest(id)) cb(e);
      });
    }
  }
};

export const log = (msg) => {
  const container = document.querySelector("#debug-log-view");
  if (!container) return;
  const line = document.createElement("div");
  line.style.borderLeft = "1px solid var(--primary)";
  line.style.paddingLeft = "8px";
  line.style.marginBottom = "4px";
  line.style.opacity = "0.7";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  container.prepend(line);
  if (container.children.length > 50) container.lastChild.remove();
};

export const setupGlobalErrorHandler = () => {
  window.addEventListener("error", (e) => log(`RUNTIME ERROR: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => log(`PROMISE REJECTION: ${e.reason}`));
};

export const startMetricsPulse = () => {
  setInterval(() => {
    try {
      const lag = Math.floor(Math.random() * 15) + 15;
      ui.set("#mtr-lag", `${lag}ms`);
      ui.set("#mtr-mps", state.mps.toFixed(1));
      ui.set("#mtr-tx", `${(Math.random() * 5).toFixed(1)}k`);
      state.mps = state.msgCount / 2;
      state.msgCount = 0;
    } catch (e) { }
  }, 2000);
};

export function focusInput() {
  const el = document.querySelector("#chat-input");
  if (el) el.focus();
}

export function notify(msg, duration = 3000) {
  const toast = document.createElement("div");
  toast.className = "toast-notification";
  toast.textContent = msg.toUpperCase();
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("active"), 10);
  setTimeout(() => {
    toast.classList.remove("active");
    setTimeout(() => toast.remove(), 500);
  }, duration);
}
