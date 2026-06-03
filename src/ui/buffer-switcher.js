import { state } from '../core/state.js';
import { ui } from './ui-engine.js';
import { BUILTIN_COMMANDS } from '../services/irc.js';

function fuzzyScore(item, query) {
  if (!query) return 1;
  const haystack = String(item.haystack || item.label || '').toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);
  let score = 0;
  let cursor = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return 0;
    score += Math.max(1, 12 - (found - cursor));
    cursor = found + 1;
  }
  return score;
}

function switcherEmpty() {
  const empty = document.createElement("div");
  empty.className = "switcher-empty";
  empty.textContent = "No matches";
  return empty;
}

function switcherResult(item, index, selectedIndex, onRun) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `switcher-result ${index === selectedIndex ? "active" : ""}`;
  row.dataset.index = String(index);

  const kind = document.createElement("span");
  kind.className = "switcher-kind";
  kind.textContent = item.kind;
  const label = document.createElement("span");
  label.className = "switcher-main";
  label.textContent = item.label;
  const meta = document.createElement("span");
  meta.className = "switcher-meta";
  meta.textContent = item.meta || "";
  row.append(kind, label, meta);
  row.addEventListener("click", () => onRun(item));
  return row;
}

export function createSwitcher({
  getServerLabel,
  openMessagesWindow,
  openChannelBrowser,
  openConfig,
  copyShareText,
  clearSearch,
  switchBuffer,
  openMessagesConversation,
  setComposerValue,
}) {
  function itemPool() {
    const items = [];
    const actions = [
      { label: "Open Messages", meta: "Window", kind: "Action", run: () => openMessagesWindow() },
      { label: "Browse Channels", meta: getServerLabel(), kind: "Action", run: () => openChannelBrowser({ refresh: true }) },
      { label: "Open Options", meta: "Settings", kind: "Action", run: () => openConfig() },
      { label: "Copy Channel Summary", meta: state.activeChannel || "Current buffer", kind: "Action", run: () => copyShareText("current") },
      { label: "Copy Messages Summary", meta: "Direct conversations", kind: "Action", run: () => copyShareText("messages") },
      { label: "Clear Search", meta: state.searchQuery ? state.searchQuery : "No active search", kind: "Action", run: clearSearch },
    ];
    items.push(...actions.map((action) => ({ ...action, haystack: `${action.label} ${action.meta} ${action.kind}` })));

    state.config?.servers?.forEach((server) => {
      (server.autojoin || []).forEach((buffer) => items.push({
        label: buffer,
        meta: server.name,
        kind: buffer.startsWith("#") || buffer.startsWith("&") ? "Channel" : "DM",
        haystack: `${buffer} ${server.name}`,
        run: () => switchBuffer(String(server.id), buffer),
      }));
    });

    BUILTIN_COMMANDS.forEach((command) => items.push({
      label: command.name,
      meta: command.desc,
      kind: "Command",
      haystack: `${command.name} ${command.desc}`,
      run: () => setComposerValue(`${command.name} `),
    }));

    Object.entries(state.messages?.[state.activeServer] || {})
      .filter(([key]) => key && !key.startsWith("#") && !key.startsWith("&") && !key.startsWith("("))
      .forEach(([key, messages]) => {
        const last = messages?.[messages.length - 1];
        items.push({
          label: key,
          meta: last?.content || "Direct conversation",
          kind: "Message",
          haystack: `${key} ${last?.content || ""}`,
          run: () => openMessagesConversation(key, state.activeServer),
        });
      });

    return items;
  }

  let selectedIndex = 0;
  let currentMatches = [];

  function renderResults(query = "") {
    const container = document.querySelector("#switcher-results");
    if (!container) return;
    const lowerQuery = query.toLowerCase();
    const matches = itemPool()
      .map((item) => ({ ...item, score: fuzzyScore(item, lowerQuery) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
      .slice(0, 18);
    currentMatches = matches;
    if (selectedIndex >= matches.length) selectedIndex = 0;
    container.replaceChildren();
    if (!matches.length) {
      container.appendChild(switcherEmpty());
      return;
    }
    matches.forEach((item, index) => {
      container.appendChild(switcherResult(item, index, selectedIndex, (selected) => {
        selected.run?.();
        ui.hide("#buffer-switcher");
      }));
    });
  }

  function open() {
    const modal = document.querySelector("#buffer-switcher");
    const input = document.querySelector("#switcher-input");
    if (!modal || !input) return;
    modal.style.display = "flex";
    input.value = "";
    selectedIndex = 0;
    input.focus();
    renderResults("");

    input.oninput = (event) => { selectedIndex = 0; renderResults(event.target.value); };
    input.onkeydown = (event) => {
      if (event.key === "Escape") {
        modal.style.display = "none";
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = currentMatches.length ? (selectedIndex + 1) % currentMatches.length : 0;
        renderResults(input.value);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = currentMatches.length ? (selectedIndex - 1 + currentMatches.length) % currentMatches.length : 0;
        renderResults(input.value);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector(`#switcher-results .switcher-result[data-index="${selectedIndex}"]`)?.click();
        modal.style.display = "none";
      }
    };
  }

  return { open, renderResults };
}
