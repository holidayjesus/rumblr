import { state } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { ui, focusInput } from './ui-engine.js';
import {
  ASCII_LIBRARY,
  BUILTIN_COMMANDS,
  handleCommand,
  handleTabComplete,
  navigateHistory,
  resetCompletion,
} from '../services/irc.js';
import { appendMessage, formatTimestamp, renderMessages } from './messages.js';
import { finishInteraction, finishInteractionOnFrame, scheduleFrameTask, startInteraction } from '../core/performance.js';
import { notifyComposerTyping } from '../services/typing.js';

// Composer owns the hot path for typing: command suggestions, history,
// autocomplete, send failure recovery, and multiline sizing. Keeping it out of
// `main.js` lets app boot stay small and keeps fast-reaction input code in one
// place.
const COMMAND_EXAMPLES = {
  "/join": "/join #rumblr",
  "/msg": "/msg nick hey there",
  "/nick": "/nick NewNick",
  "/topic": "/topic Channel status update",
  "/me": "/me is shipping polish",
  "/whois": "/whois RumblrUser",
  "/query": "/query RumblrUser",
  "/part": "/part #rumblr",
  "/quit": "/quit later all",
  "/away": "/away grabbing coffee",
  "/help": "/help /join",
};

export function resizeComposer(input = document.querySelector("#chat-input")) {
  if (!input) return;
  input.style.height = "auto";
  const maxHeight = 132;
  const nextHeight = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${nextHeight}px`;
  input.classList.toggle("is-expanded", nextHeight > 56);
}

function scheduleComposerResize(input) {
  scheduleFrameTask("composer-resize", () => resizeComposer(input));
}

export function setComposerValue(value) {
  const input = document.querySelector("#chat-input");
  if (!input) return;
  input.value = value;
  resizeComposer(input);
  input.focus();
}

function setComposerSending(isSending) {
  const form = document.querySelector("#chat-form");
  const send = document.querySelector(".send-btn");
  form?.classList.toggle("is-sending", isSending);
  if (send) send.disabled = isSending;
}

function showSendFailure(content, error) {
  appendMessage({
    username: "System",
    content: `Send failed: ${String(error || "Unknown error")}`,
    timestamp: formatTimestamp(new Date()),
    channel: state.activeChannel,
    server_id: state.activeServer,
    msg_type: "system",
  });
  const input = document.querySelector("#chat-input");
  if (input && !input.value.trim()) {
    input.value = content;
    resizeComposer(input);
    input.focus();
  }
}

function commandPool() {
  return [
    ...BUILTIN_COMMANDS,
    ...Object.keys(ASCII_LIBRARY).map((key) => ({ name: `/${key}`, desc: "Action face" })),
    ...Object.keys(state.aliases).map((key) => ({ name: `/${key}`, desc: "Alias" })),
  ];
}

function renderSuggestionRows(container, commands, selectedIdx, onSelect) {
  container.replaceChildren();
  commands.forEach((command, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `cmd-item ${index === selectedIdx ? "active" : ""}`;
    row.dataset.index = String(index);
    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = command.name;
    const desc = document.createElement("span");
    desc.className = "cmd-desc";
    desc.textContent = command.desc;
    row.append(name, desc);
    row.addEventListener("click", () => onSelect(index));
    container.appendChild(row);
  });
}

function renderHint(hintBox, commandName) {
  hintBox.replaceChildren();
  if (!commandName) return;

  const hint = BUILTIN_COMMANDS.find((command) => command.name === commandName);
  const label = document.createElement("span");
  label.className = "cmd-hint-label";
  const usage = document.createElement("span");
  usage.className = "cmd-hint-usage";

  if (hint) {
    label.textContent = "Usage";
    usage.textContent = `${commandName} ${hint.desc}`.trim();
    const example = document.createElement("span");
    example.className = "cmd-hint-example";
    example.textContent = `Example: ${COMMAND_EXAMPLES[commandName] || `${commandName} ...`}`;
    hintBox.append(label, usage, example);
    return;
  }

  label.textContent = "Tip";
  usage.textContent = "Use up/down to pick a command, Enter to apply, or run /help for the full list";
  hintBox.append(label, usage);
}

export function setupComposer({ closePanels, openSwitcher } = {}) {
  const input = document.querySelector("#chat-input");
  const form = document.querySelector("#chat-form");
  const hintBox = document.querySelector("#cmd-usage-hint");
  const charCounter = document.querySelector("#char-counter");
  const suggestions = document.querySelector("#cmd-suggestions");
  if (!input || !form || !suggestions || !hintBox) return;

  let selectedSuggestionIdx = -1;
  let filteredCommands = [];
  let lastHintCommand = "";

  const hideSuggestions = () => {
    suggestions.style.display = "none";
    selectedSuggestionIdx = -1;
  };

  const selectSuggestion = (idx) => {
    if (!filteredCommands[idx]) return;
    setComposerValue(`${filteredCommands[idx].name} `);
    hideSuggestions();
  };

  const updateSuggestions = () => {
    const value = input.value;
    if (!value.startsWith("/") || value.includes(" ")) {
      hideSuggestions();
      return;
    }
    const query = value.toLowerCase();
    filteredCommands = commandPool()
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .slice(0, 10);
    if (!filteredCommands.length) {
      hideSuggestions();
      return;
    }
    renderSuggestionRows(suggestions, filteredCommands, selectedSuggestionIdx, selectSuggestion);
    suggestions.style.display = "block";
  };

  input.onkeydown = (event) => {
    const suggestionsOpen = suggestions.style.display === "block";
    if (suggestionsOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedSuggestionIdx = (selectedSuggestionIdx + 1) % filteredCommands.length;
        updateSuggestions();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedSuggestionIdx = (selectedSuggestionIdx - 1 + filteredCommands.length) % filteredCommands.length;
        updateSuggestions();
        return;
      }
      if (event.key === "Enter" && selectedSuggestionIdx !== -1) {
        event.preventDefault();
        selectSuggestion(selectedSuggestionIdx);
        return;
      }
      if (event.key === "Escape") {
        hideSuggestions();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      handleTabComplete(input);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navigateHistory(1, input);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      navigateHistory(-1, input);
    } else if (event.key === "Escape") {
      closePanels?.();
      if (state.searchQuery) {
        state.searchQuery = "";
        renderMessages(state.activeServer, state.activeChannel);
      }
    } else if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openSwitcher?.();
    } else if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setComposerValue("/search ");
      focusInput();
    } else if ((event.metaKey || event.ctrlKey) && event.key >= "1" && event.key <= "9") {
      event.preventDefault();
      document.querySelectorAll(".sidebar .list-item")[parseInt(event.key, 10) - 1]?.click();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "[") {
      event.preventDefault();
      const items = [...document.querySelectorAll(".sidebar .list-item")];
      const activeIdx = items.findIndex((item) => item.classList.contains("active"));
      if (activeIdx > 0) items[activeIdx - 1].click();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "]") {
      event.preventDefault();
      const items = [...document.querySelectorAll(".sidebar .list-item")];
      const activeIdx = items.findIndex((item) => item.classList.contains("active"));
      if (activeIdx !== -1 && activeIdx < items.length - 1) items[activeIdx + 1].click();
    } else {
      resetCompletion();
    }
  };

  input.oninput = () => {
    const inputMark = startInteraction("composer-input", { channel: state.activeChannel, length: input.value.length });
    const value = input.value;
    try {
      // Text input is the strictest latency path. Height measurement reads layout,
      // so defer it to the frame scheduler and keep the input handler mostly text.
      notifyComposerTyping(value);
      scheduleComposerResize(input);
      updateSuggestions();
      const hintCommand = value.startsWith("/") ? value.split(" ")[0].toLowerCase() : "";
      if (hintCommand !== lastHintCommand) {
        renderHint(hintBox, hintCommand);
        lastHintCommand = hintCommand;
      }
      if (charCounter) {
        charCounter.textContent = value.length > 0 ? `${value.length}/512` : "";
        charCounter.style.opacity = value.length > 400 ? "1" : "0.4";
      }
    } finally {
      finishInteraction(inputMark, "work");
      finishInteractionOnFrame(inputMark);
    }
  };

  input.onblur = () => {
    notifyComposerTyping("");
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const submitMark = startInteraction("composer-submit", { channel: state.activeChannel, command: value.startsWith("/") });
    notifyComposerTyping("");
    setComposerSending(true);
    finishInteraction(submitMark, "button-lock");
    try {
      if (value.startsWith("/")) {
        await handleCommand(value);
      } else {
        await invoke("send_irc_message", {
          serverId: String(state.activeServer),
          channel: state.activeChannel,
          content: value,
        });
        appendMessage({
          username: state.config?.global_nickname || "Me",
          content: value,
          timestamp: formatTimestamp(new Date()),
          channel: state.activeChannel,
          server_id: state.activeServer,
        });
      }
      input.value = "";
      hintBox.textContent = "";
      resizeComposer(input);
      if (charCounter) charCounter.textContent = "";
      finishInteraction(submitMark, "send-ack", { ok: true });
      finishInteractionOnFrame(submitMark);
    } catch (error) {
      showSendFailure(value, error);
      finishInteraction(submitMark, "send-ack", { ok: false });
      finishInteractionOnFrame(submitMark);
    } finally {
      setComposerSending(false);
    }
  };
}
