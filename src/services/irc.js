import { state, norm, parseUser, discoverBuffer } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { log } from '../ui/ui-engine.js';
import { appendMessage, formatTimestamp } from '../ui/messages.js';
import { selectChannel } from '../ui/sidebar.js';
import { canonicalServiceBufferName, isServiceBuffer } from '../core/buffers.js';

export const ASCII_LIBRARY = {
  cat: "(=^·^=)",
  dog: "(ᵔᴥᵔ)",
  heart: "(づ￣ ³￣)づ",
  bear: "ʕ•ᴥ•ʔ",
  shades: "(⌐■_■)",
  monocle: "(°ರೃ)",
  disapproval: "ಠ_ಠ",
  happy: "(•‿•)",
  sad: "(︶︹︶)",
  angry: "(◣_◢)",
  surprised: "(⊙_⊙)",
  wink: "(^_-)",
  shrug: "¯\\_(ツ)_/¯",
  lenny: "( ͡° ͜ʖ ͡°)",
  cry: "(╥﹏╥)",
  kiss: "(づ￣ ³￣)づ",
  love: "(｡♥‿♥｡)",
  scared: "(✖﹏✖)",
  dead: "(×_×)",
  sleepy: "(◡‿◡✿)",
  strong: "ᕙ(⇀‸↼‶)ᕗ",
  dance: "└|∵|┐",
  celebrate: "\\(^o^)/",
  yell: "(ノಠ益ಠ)ノ",
  tableflip: "(╯°□°）╯︵ ┻━┻",
  unflip: "┬─┬ ノ( ゜-゜ノ)",
  thinking: "(゜-゜)",
  blush: "(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)",
  sweat: "(;´Д`)",
  nervous: "(・_・;)",
  whatever: "┐(‘～`;)┌",
  victory: "(^_^)v",
  fight: "(ง'̀-'́)ง",
  money: "[̲̅$̲̅(̲̅5̲̅)̲̅$̲̅]",
  sniper: "︻╦̵̵͇̿̿̿̿╤──",
  magic: "(∩^o^)⊃━☆゜.*",
  music: "♫ ♪ ♫"
};

export const BUILTIN_COMMANDS = [
  { name: "/join", desc: "<#channel> [key]" },
  { name: "/part", desc: "[#channel] [reason]" },
  { name: "/msg", desc: "<nick> <message>" },
  { name: "/nick", desc: "<new_nick>" },
  { name: "/topic", desc: "[text]" },
  { name: "/whois", desc: "<nick>" },
  { name: "/list", desc: "List channels" },
  { name: "/raw", desc: "<command>" },
  { name: "/clear", desc: "Clear buffer" },
  { name: "/search", desc: "<query>" },
  { name: "/alias", desc: "<name> <replacement>" },
  { name: "/unalias", desc: "<name>" },
  { name: "/quiet", desc: "Toggle signal filter" },
  { name: "/id", desc: "<password>" },
  { name: "/me", desc: "<action>" },
  { name: "/shrug", desc: "[text] ¯\\_(ツ)_/¯" },
  { name: "/flip", desc: "[text] (╯°□°）╯︵ ┻━┻" },
  { name: "/unflip", desc: "[text] ┬─┬ ノ( ゜-゜ノ)" },
  { name: "/wink", desc: "[text] (^_-)" },
  { name: "/lenny", desc: "[text] ( ͡° ͜ʖ ͡°)" },
  { name: "/hug", desc: "<nick>" },
  { name: "/slap", desc: "<nick>" },
  { name: "/mock", desc: "<text>" },
  { name: "/clap", desc: "<text>" },
  { name: "/rainbow", desc: "<text>" },
  { name: "/dice", desc: "[sides]" },
  { name: "/ball", desc: "<question>" },
  { name: "/np", desc: "Share media" },
  { name: "/whoami", desc: "Identity check" }
];

function serviceSafeOutgoing(target, content) {
  if (!isServiceBuffer(target)) return content;
  if (/^identify\s+/i.test(content.trim())) {
    return "Identification request sent. Waiting for service confirmation...";
  }
  return content;
}

export async function handleCommand(raw) {
  const parts = raw.split(" ").filter(p => p);
  if (parts.length === 0) return;
  const cmd = parts[0].toLowerCase();
  const cmdName = cmd.slice(1);
  
  // Alias Resolution
  if (cmd.startsWith("/") && state.aliases[cmdName]) {
    const aliasVal = state.aliases[cmdName];
    const args = parts.slice(1).join(" ");
    let expanded = aliasVal.replace("$args", args);
    parts.slice(1).forEach((arg, i) => { expanded = expanded.replace(`$${i+1}`, arg); });
    return handleCommand(expanded);
  }

  // ASCII Library Actions
  if (cmd.startsWith("/") && ASCII_LIBRARY[cmdName]) {
    const art = ASCII_LIBRARY[cmdName];
    const text = parts.slice(1).join(" ");
    return handleCommand(`/me ${text} ${art}`.trim());
  }
  
  try {
    if (cmd === "/id") {
      const password = parts[1];
      if (password) {
        await invoke("send_irc_message", { serverId: state.activeServer, channel: "NickServ", content: `IDENTIFY ${password}` });
        appendMessage({ username: "System", content: "Identification request sent. Waiting for NickServ confirmation...", timestamp: formatTimestamp(new Date()), channel: "NickServ", server_id: state.activeServer, msg_type: 'system' });
      }
    } else if (cmd === "/shrug") {
      const msg = parts.slice(1).join(" ") + " " + ASCII_LIBRARY.shrug;
      handleCommand(`/me ${msg.trim()}`);
    } else if (cmd === "/flip") {
      const msg = parts.slice(1).join(" ") + " " + ASCII_LIBRARY.tableflip;
      handleCommand(`/me ${msg.trim()}`);
    } else if (cmd === "/unflip") {
      const msg = parts.slice(1).join(" ") + " " + ASCII_LIBRARY.unflip;
      handleCommand(`/me ${msg.trim()}`);
    } else if (cmd === "/wink") {
      const msg = parts.slice(1).join(" ") + " " + ASCII_LIBRARY.wink;
      handleCommand(`/me ${msg.trim()}`);
    } else if (cmd === "/lenny") {
      const msg = parts.slice(1).join(" ") + " " + ASCII_LIBRARY.lenny;
      handleCommand(`/me ${msg.trim()}`);
    } else if (cmd === "/hug") {
      const target = parts[1] || "someone";
      handleCommand(`/me gives ${target} a tactical workstation hug (づ｡◕‿‿◕｡)づ`);
    } else if (cmd === "/slap") {
      const target = parts[1] || "someone";
      handleCommand(`/me slaps ${target} around a bit with a large trout`);
    } else if (cmd === "/mock") {
      const text = parts.slice(1).join(" ");
      const mocked = text.split("").map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join("");
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: nick, content: mocked, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
      await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content: mocked });
    } else if (cmd === "/clap") {
      const text = parts.slice(1).join(" ");
      const clapped = text.split(" ").join(" 👏 ") + " 👏";
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: nick, content: clapped, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
      await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content: clapped });
    } else if (cmd === "/rainbow") {
      const text = parts.slice(1).join(" ");
      const colors = ['04', '07', '08', '09', '03', '11', '12', '06'];
      let colored = "";
      text.split("").forEach((char, i) => { colored += `\x03${colors[i % colors.length]}${char}`; });
      const final = colored + "\x03";
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: nick, content: final, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
      await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content: final });
    } else if (cmd === "/dice") {
      const sides = parseInt(parts[1]) || 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      const content = `[DICE] ROLLED A D${sides}: ${roll}`;
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: nick, content, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
      await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content });
    } else if (cmd === "/ball") {
      const responses = ["It is certain.", "It is decidedly so.", "Without a doubt.", "Yes definitely.", "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful."];
      const res = responses[Math.floor(Math.random() * responses.length)];
      const content = `[8-BALL] ${res}`;
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: nick, content, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
      await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content });
    } else if (cmd === "/np") {
      import('./media.js').then(m => m.shareMedia());
    } else if (cmd === "/whoami") {
      const srv = state.config?.servers?.find(s => s.id === state.activeServer);
      const nick = srv?.nickname || "Me";
      appendMessage({ username: "System", content: `IDENTITY: ${nick} on ${srv?.host || 'Unknown'}`, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer, msg_type: 'system' });
    } else if (cmd === "/me") {
      const content = parts.slice(1).join(" ");
      if (content) {
        const myNick = state.config?.global_nickname || "Me";
        appendMessage({ username: `* ${myNick}`, content, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer, msg_type: 'action' });
        await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content: `\x01ACTION ${content}\x01` });
      }
    } else if (cmd === "/alias") {
      const name = parts[1];
      const replacement = parts.slice(2).join(" ");
      if (name && replacement) {
        state.aliases[name.replace("/", "")] = replacement;
        appendMessage({ username: "System", content: `ALIAS CONFIGURED: ${name} -> ${replacement}`, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer, msg_type: 'system' });
      }
    } else if (cmd === "/unalias") {
      const name = parts[1];
      if (name) {
        delete state.aliases[name.replace("/", "")];
        appendMessage({ username: "System", content: `ALIAS REMOVED: ${name}`, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer, msg_type: 'system' });
      }
    } else if (cmd === "/clear") {
      if (!state.messages[state.activeServer]) state.messages[state.activeServer] = {};
      state.messages[state.activeServer][norm(state.activeChannel)] = [];
      window.dispatchEvent(new CustomEvent("refresh-messages"));
    } else if (cmd === "/quiet") {
      state.signalFilter = !state.signalFilter;
      appendMessage({ username: "System", content: `SIGNAL FILTER: ${state.signalFilter ? "ON" : "OFF"}`, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer, msg_type: 'system' });
      window.dispatchEvent(new CustomEvent("refresh-messages"));
    } else if (cmd === "/search") {
      state.searchQuery = parts.slice(1).join(" ").toLowerCase();
      window.dispatchEvent(new CustomEvent("refresh-messages"));
    } else if (cmd === "/join") {
      if (parts[1]) {
        const chan = parts[1].startsWith("#") ? parts[1] : `#${parts[1]}`;
        await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: `/join ${chan}` });
        discoverBuffer(state.activeServer, chan);
        selectChannel(state.activeServer, chan);
      }
    } else if (cmd === "/part" || cmd === "/leave") {
      const rawChan = parts[1] || state.activeChannel;
      const chan = (rawChan.startsWith("#") || rawChan.startsWith("&")) ? rawChan : `#${rawChan}`;
      await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: `/part ${chan}` });
      if (window.closeBuffer) window.closeBuffer(state.activeServer, chan);
    } else if (cmd === "/msg") {
      const target = parts[1];
      const content = parts.slice(2).join(" ");
      if (target && content) {
        await invoke("send_irc_message", { serverId: state.activeServer, channel: target, content });
        const bufferName = isServiceBuffer(target) ? canonicalServiceBufferName(target) : target;
        appendMessage({ username: "Me", content: serviceSafeOutgoing(target, content), timestamp: formatTimestamp(new Date()), channel: bufferName, server_id: state.activeServer });
      }
    } else if (cmd === "/nick") {
      if (parts[1]) await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: `/nick ${parts[1]}` });
    } else if (cmd === "/topic") {
      const text = parts.slice(1).join(" ");
      await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: `/topic ${state.activeChannel} :${text}` });
    } else if (cmd === "/whois") {
      if (parts[1]) await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: `/whois ${parts[1]}` });
    } else if (cmd === "/list") {
      await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content: "/list" });
    } else if (cmd === "/raw") {
      const content = parts.slice(1).join(" ");
      if (content) await invoke("send_irc_message", { serverId: state.activeServer, channel: "system", content });
    } else if (cmd === "/help") {
      const now = formatTimestamp(new Date());
      appendMessage({
        username: "Help",
        content: "COMMAND REFERENCE",
        timestamp: now,
        channel: state.activeChannel,
        server_id: state.activeServer,
        msg_type: 'system'
      });
      appendMessage({
        username: "Help",
        content: "Type /<command> then press Tab for completion. Use ↑↓ in suggestions and Enter to apply.",
        timestamp: now,
        channel: state.activeChannel,
        server_id: state.activeServer,
        msg_type: 'system'
      });
      BUILTIN_COMMANDS.forEach(c => {
        appendMessage({ 
          username: "Help", 
          content: `• ${c.name.padEnd(10, " ")} ${c.desc}`, 
          timestamp: now, 
          channel: state.activeChannel, 
          server_id: state.activeServer, 
          msg_type: 'system' 
        });
      });
      appendMessage({ 
        username: "Help", 
        content: `FACES: ${Object.keys(ASCII_LIBRARY).join(", ")}`, 
        timestamp: now, 
        channel: state.activeChannel, 
        server_id: state.activeServer, 
        msg_type: 'system' 
      });
    } else {
      log(`[DEBUG] Sending raw message to ${state.activeServer}: ${raw}`);
      await invoke("send_irc_message", { serverId: String(state.activeServer), channel: state.activeChannel, content: raw });
    }
  } catch (e) { 
    log(`Command Failed: ${e}`);
    console.error("[IRC] Send error:", e);
  }
}

let completionState = { matches: [], index: 0, original: "" };
export function handleTabComplete(input) {
  const val = input.value;
  const cursor = input.selectionStart;
  const words = val.slice(0, cursor).split(" ");
  const lastWord = words[words.length - 1];
  const replaceToken = (match) => {
    const start = cursor - lastWord.length;
    input.value = val.slice(0, start) + match + val.slice(cursor);
    const nextCursor = start + match.length;
    input.setSelectionRange(nextCursor, nextCursor);
  };

  if (completionState.matches.length > 0) {
    completionState.index = (completionState.index + 1) % completionState.matches.length;
    replaceToken(completionState.matches[completionState.index]);
    return;
  }

  if (!lastWord) return;
  const commandMatches = lastWord.startsWith("/")
    ? BUILTIN_COMMANDS.map(c => c.name).filter(c => c.startsWith(lastWord.toLowerCase())).map(c => `${c} `)
    : [];
  const channelMatches = lastWord.startsWith("#") || lastWord.startsWith("&")
    ? Object.keys(state.messages[state.activeServer] || {})
      .filter(name => name.startsWith("#") || name.startsWith("&"))
      .filter(name => name.toLowerCase().startsWith(lastWord.toLowerCase()))
    : [];
  const users = (state.users[state.activeServer]?.[norm(state.activeChannel)] || []).map(u => parseUser(u).nick);
  const matches = users.filter(u => u.toLowerCase().startsWith(lastWord.toLowerCase()));
  const allMatches = [...commandMatches, ...channelMatches, ...matches];

  if (allMatches.length > 0) {
    completionState = { matches: allMatches, index: 0, original: lastWord };
    replaceToken(allMatches[0]);
  }
}

export function resetCompletion() {
  completionState = { matches: [], index: 0, original: "" };
}

export function navigateHistory(dir, input) {
  if (state.history.length === 0) return;
  if (state.historyIndex === -1) state.tempInput = input.value;
  state.historyIndex += dir;
  if (state.historyIndex < -1) state.historyIndex = -1;
  if (state.historyIndex >= state.history.length) state.historyIndex = state.history.length - 1;
  input.value = state.historyIndex === -1 ? state.tempInput : state.history[state.history.length - 1 - state.historyIndex];
}
