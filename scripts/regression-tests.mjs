import assert from "node:assert/strict";
import fs from "node:fs";

const storage = new Map();
globalThis.window = {
  requestIdleCallback(callback) {
    callback({ didTimeout: false, timeRemaining: () => 50 });
    return 1;
  },
  cancelIdleCallback() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  innerWidth: 1200,
  innerHeight: 800,
  __RUMBLR_FORCE_INLINE_YOUTUBE__: true,
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
globalThis.document = { querySelector: () => null };
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { state, THEMES } = await import("../src/core/state.js");
const { attentionItems, directConversationBuffers } = await import("../src/core/buffers.js");
const { compactMessageMap, compactUnreadMap, sessionStore } = await import("../src/core/persistence.js");
const { normalizeConfig } = await import("../src/core/config-store.js");
const { isYoutubeUrl, youtubeEmbedInfo } = await import("../src/ui/youtube-popout.js");

assert.equal(youtubeEmbedInfo("https://youtu.be/dQw4w9WgXcQ")?.id, "dQw4w9WgXcQ");
assert.equal(youtubeEmbedInfo("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s")?.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(youtubeEmbedInfo("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.embedUrl.includes("youtube-nocookie.com/embed/dQw4w9WgXcQ"), true);
assert.equal(isYoutubeUrl("https://example.com/watch?v=dQw4w9WgXcQ"), false);

const settingsCss = fs.readFileSync(new URL("../src/styles/settings.css", import.meta.url), "utf8");
const themesCss = fs.readFileSync(new URL("../src/styles/themes.css", import.meta.url), "utf8");
const configApplierJs = fs.readFileSync(new URL("../src/core/config-applier.js", import.meta.url), "utf8");
assert(
  /body\.avatars-hidden \.msg-grouped \{[\s\S]*padding-left: 24px;/.test(settingsCss),
  "Avatar-hidden grouped messages should keep the normal message inset",
);

["toxic", "blackOps", "toxicRed", "nightfall", "stealth", "phosphorGlass"].forEach((themeId) => {
  assert(THEMES[themeId], `${themeId} should be present in the curated theme catalog`);
  assert(themesCss.includes(`body[data-theme="${themeId}"]`), `${themeId} should have final-layer surface styling`);
});
assert(configApplierJs.includes("Object.keys(THEMES)"), "Theme resolver should follow the catalog instead of a stale hard-coded list");

const premiumSurfacesCss = fs.readFileSync(new URL("../src/styles/premium-surfaces.css", import.meta.url), "utf8");
assert(premiumSurfacesCss.includes("Main chat line rhythm"), "Main chat row spacing should stay in the final polish layer");
assert(/body:not\(\.messages-window\) \.msg-text \{[\s\S]*font-size: 16px;/.test(premiumSurfacesCss), "Main chat text should keep the larger readable size");
assert(/body\.avatars-hidden:not\(\.messages-window\) \.user-msg-block,[\s\S]*padding-left: 18px;/.test(premiumSurfacesCss), "Avatar-hidden rows should keep a visible left inset");

const appHtml = fs.readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const mainJs = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const bootJs = fs.readFileSync(new URL("../src/core/boot.js", import.meta.url), "utf8");
const channelBrowserJs = fs.readFileSync(new URL("../src/ui/channel-browser.js", import.meta.url), "utf8");
const dccJs = fs.readFileSync(new URL("../src/ui/dcc.js", import.meta.url), "utf8");
const dccRs = fs.readFileSync(new URL("../src-tauri/src/dcc.rs", import.meta.url), "utf8");
const textRs = fs.readFileSync(new URL("../src-tauri/src/text.rs", import.meta.url), "utf8");
const messagesWindowJs = fs.readFileSync(new URL("../src/ui/messages-window.js", import.meta.url), "utf8");
const mediaCss = fs.readFileSync(new URL("../src/styles/media.css", import.meta.url), "utf8");
assert(appHtml.includes("https://buymeacoffee.com/holidayjesus"), "About panel should include the support link");
assert(appHtml.includes("Buy me a coffee"), "About panel should keep the support link obvious");
assert(appHtml.includes("Rumblr is a polished IRC client for Mac OS with a modern twist."), "About panel should use the requested minimal product sentence");
assert(appHtml.includes("Read README.md for features and how to use Rumblr."), "About panel should point users to README.md");
assert(appHtml.includes("performance-metrics"), "System settings should expose measured interaction timing");
assert(!appHtml.includes("about-license-note"), "About panel should not show the old license note");
assert(!appHtml.includes("about-simple-list"), "About panel should not show the old three-column detail strip");
assert(!appHtml.includes("OPEN SOURCE LICENSES"), "About panel should stay concise instead of showing the old license grid");
assert(!mainJs.includes("#about-support-link\", \"click"), "About support links should be left to native anchor/open handling");
assert(mainJs.includes("window.rumblrPerformance"), "Main window should expose a local performance snapshot helper");
assert(appHtml.includes("id=\"dcc-panel\""), "DCC/XDCC request sheet should be present in the shell");
assert(appHtml.includes("id=\"dcc-offer-panel\""), "Incoming DCC transfer sheet should be present in the shell");
assert(dccJs.includes("accept_dcc_offer"), "DCC accept should call the Rust transfer backend");
assert(dccJs.includes("cancel_dcc_transfer"), "DCC transfers should be cancellable from the UI");
assert(dccRs.includes("Classic DCC SEND expects"), "DCC backend should keep the legacy byte ACK behavior documented");
assert(/\.about-modal-wrap \{[\s\S]*height: auto !important;/.test(mediaCss), "About modal should fit its simplified content");
assert(!bootJs.includes("channel-browser-open"), "Incoming LIST traffic should not reopen the channel browser");
assert(channelBrowserJs.includes("!state.isListing &&"), "Channel browser should not start duplicate /LIST scans while one is running");
assert(bootJs.includes("irc-list-error"), "LIST server errors should reach the channel browser");
assert(channelBrowserJs.includes("LIST_REQUEST_DEBOUNCE_MS"), "Channel browser should debounce repeated LIST requests");
assert(channelBrowserJs.includes("state.channelListError"), "Channel browser should render explicit LIST errors");
assert(textRs.includes("skip_optional_mirc_background"), "IRC display cleanup should consume mIRC color parameters, not just control bytes");
assert(messagesWindowJs.includes("captureMessagesHubFocus"), "Messages Hub refreshes should preserve focused input state");
assert(messagesWindowJs.includes("messageDrafts"), "Messages Hub thread drafts should survive incoming-message rerenders");
assert(messagesWindowJs.includes("preserveThread"), "Messages Hub search filtering should not switch the active thread");
assert(!messagesWindowJs.includes("search.value = \"\";"), "Messages Hub refreshes should not clear the search field");

class TestNode {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.eventListeners = {};
    this.className = "";
    this._textContent = "";
    this.scrollTop = 0;
    this.clientHeight = 720;
    this._scrollHeight = 0;
    this.classList = {
      contains: (name) => String(this.className || "").split(/\s+/).includes(name),
      add: (...names) => {
        const current = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.className = [...current].join(" ");
      },
      remove: (...names) => {
        const remove = new Set(names);
        this.className = String(this.className || "").split(/\s+/).filter((name) => !remove.has(name)).join(" ");
      },
      toggle: (name) => {
        if (this.classList.contains(name)) {
          this.classList.remove(name);
          return false;
        }
        this.classList.add(name);
        return true;
      },
    };
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    this._scrollHeight = Math.max(this._scrollHeight, this.children.length * 76);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }

  addEventListener(type, handler) {
    this.eventListeners[type] = handler;
  }

  get childNodes() {
    return this.children;
  }

  get lastElementChild() {
    return [...this.children].reverse().find((child) => child.tag !== "#text") || null;
  }

  get scrollHeight() {
    return Math.max(this._scrollHeight, this.children.length * 76);
  }

  set scrollHeight(value) {
    this._scrollHeight = Number(value) || 0;
  }
}

function createTestDocument(nodes = {}) {
  return {
    body: new TestNode("body"),
    querySelector: (selector) => nodes[selector] || null,
    createElement: (tag) => new TestNode(tag),
    createElementNS: (_ns, tag) => new TestNode(tag),
    createDocumentFragment: () => new TestNode("#fragment"),
    createTextNode: (text) => {
      const node = new TestNode("#text");
      node.textContent = text;
      return node;
    },
    addEventListener() {},
  };
}

function countClass(root, className) {
  const own = String(root.className || "").split(/\s+/).includes(className) ? 1 : 0;
  return own + root.children.reduce((sum, child) => sum + countClass(child, className), 0);
}

function findClass(root, className) {
  if (String(root.className || "").split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const match = findClass(child, className);
    if (match) return match;
  }
  return null;
}

function findTag(root, tag) {
  if (root.tag === tag) return root;
  for (const child of root.children || []) {
    const match = findTag(child, tag);
    if (match) return match;
  }
  return null;
}

function resetState() {
  state.config = {
    servers: [{ id: "libera", name: "Libera.Chat", autojoin: ["#rumblr"] }],
  };
  state.activeServer = "libera";
  state.activeChannel = "#rumblr";
  state.messages = {};
  state.typing = {};
  state.unreads = {};
  state.netStatus = {};
  state.netDetails = {};
}

function message(channel, username, content, receivedAt) {
  return { channel, username, content, received_at: receivedAt, server_id: "libera" };
}

resetState();
state.messages = {
  libera: {
    NickServ: [
      message("NickServ", "NickServ", "You are now logged in", "2026-05-09T01:00:00Z"),
    ],
    TestNick: [
      message("TestNick", "TestNick", "hey", "2026-05-09T01:01:00Z"),
    ],
  },
};
state.unreads = { libera: { nickserv: 1, "nickserv:mention": true } };

const conversations = directConversationBuffers(state, "libera");
assert.equal(conversations[0].name, "NickServ");
assert.equal(conversations[0].unread, 1);
assert.equal(conversations[0].last.content, "You are now logged in");

const oversizedSnapshot = {
  libera: {
    "#rumblr": Array.from({ length: 5 }, (_, index) =>
      message("#rumblr", "alice", `persist ${index}`, `2026-05-09T01:0${index}:00Z`)
    ),
  },
};
assert.deepEqual(
  compactMessageMap(oversizedSnapshot, 2).libera["#rumblr"].map((row) => row.content),
  ["persist 3", "persist 4"],
  "Persistence compaction should keep the newest useful scrollback without saving the whole world",
);
assert.deepEqual(
  compactUnreadMap({ libera: { "#rumblr": 0, "#rumblr:mention": true, nickserv: 2, "nickserv:mention": true } }),
  { libera: { nickserv: 2, "nickserv:mention": true } },
);

const attention = attentionItems(state);
assert.equal(attention[0].buffer, "nickserv");
assert.equal(attention[0].isMention, true);

resetState();
state.config.servers[0].autojoin = ["#rumblr", "NickServ", "TestNick", "&ops"];
state.netStatus = { libera: "online" };
state.unreads = { libera: { "#rumblr": 2 } };
sessionStore.saveRuntimeSession(state);
sessionStore.flush();

const saved = JSON.parse(localStorage.getItem(sessionStore.keys.sessionState));
assert.deepEqual(saved.joinedBuffers.libera, ["#rumblr", "&ops"]);
assert.equal(saved.activeServer, "libera");

sessionStore.saveMessageSnapshot({
  libera: {
    "#rumblr": Array.from({ length: 1605 }, (_, index) =>
      message("#rumblr", "alice", `snap ${index}`, "2026-05-09T01:00:00Z")
    ),
  },
});
sessionStore.flush();
const compactedSnapshot = JSON.parse(localStorage.getItem(sessionStore.keys.messageSnapshot));
assert.equal(compactedSnapshot.libera["#rumblr"].length, 1500, "messageSnapshot should be compacted lazily at flush time");
assert.equal(compactedSnapshot.libera["#rumblr"][0].content, "snap 105");

sessionStore.setMessagesOpenRequest({ serverId: "libera", buffer: "NickServ", requestedAt: Date.now() });
const freshRequest = sessionStore.consumeMessagesOpenRequest();
assert.equal(freshRequest.buffer, "NickServ");
assert.deepEqual(sessionStore.getMessagesOpenRequest(), {});

sessionStore.setMessagesOpenRequest({ serverId: "libera", buffer: "ChanServ", requestedAt: Date.now() - 60000 });
assert.deepEqual(sessionStore.consumeMessagesOpenRequest(), {});

const userList = new TestNode("div");
const rightCount = new TestNode("span");
const topCount = new TestNode("span");
globalThis.document = createTestDocument({
  "#user-list-content": userList,
  "#right-user-count": rightCount,
  "#top-user-count": topCount,
});
globalThis.window.onNickClick = () => {};

const { renderUserList } = await import("../src/ui/sidebar.js");
resetState();
state.users = { libera: { "#rumblr": ["TestNick"] } };
assert.doesNotThrow(() => renderUserList());
assert.equal(rightCount.textContent, "1");
assert.equal(topCount.textContent, "1 user");
assert.equal(countClass(userList, "member-row"), 1);

const { appendMessage, renderMessages, virtualMessageSlice, MESSAGE_VIRTUALIZATION_THRESHOLD } = await import("../src/ui/messages.js");
const { appendFormattedContent } = await import("../src/ui/message-content.js");
const { clearTypingUser, handleTypingUpdate, isTypingTarget, typingLabelForUsers, typingSummaryForBuffer, typingUsersForBuffer } = await import("../src/services/typing.js");

resetState();
state.notificationRules = { ...state.notificationRules, mode: "off", popupAlerts: false };
globalThis.document = createTestDocument();
appendMessage(message("NickServ", "NickServ", "You are now logged in", "2026-05-09T01:02:00Z"));
assert.equal(state.messages.libera.nickserv.length, 1);
assert.equal(state.unreads.libera.nickserv, 1);
assert.equal(directConversationBuffers(state, "libera")[0].name, "NickServ");

handleTypingUpdate({ server_id: "libera", buffer: "#rumblr", username: "alice", typing_state: "active" });
assert.deepEqual(typingUsersForBuffer("libera", "#rumblr"), ["alice"]);
assert.equal(typingLabelForUsers(["alice", "bob"]), "alice and bob are typing");
assert.deepEqual(typingSummaryForBuffer("libera", "#rumblr"), { tone: "active", users: ["alice"], label: "alice is typing" });
handleTypingUpdate({ server_id: "libera", buffer: "#rumblr", username: "alice", typing_state: "paused" });
assert.deepEqual(typingSummaryForBuffer("libera", "#rumblr"), { tone: "paused", users: ["alice"], label: "alice paused typing" });
assert.equal(isTypingTarget("(LOGS)"), false);
clearTypingUser("libera", "#rumblr", "alice");
assert.deepEqual(typingUsersForBuffer("libera", "#rumblr"), []);

const slice = virtualMessageSlice(5000, 0, 720, true);
assert(slice.start > 4800);
assert(slice.end <= 5000);
assert(slice.end - slice.start <= 16);

const scroller = new TestNode("div");
scroller.clientHeight = 720;
globalThis.document = createTestDocument({ "#chat-scroller": scroller });
resetState();
state.signalFilter = false;
state.config.display = { show_system_messages: true };
state.messages = {
  libera: {
    "#rumblr": Array.from({ length: MESSAGE_VIRTUALIZATION_THRESHOLD + 400 }, (_, index) =>
      message("#rumblr", index % 2 ? "alice" : "bob", `message ${index}`, `2026-05-09T01:${String(index % 60).padStart(2, "0")}:00Z`)
    ),
  },
};
assert.doesNotThrow(() => renderMessages("libera", "#rumblr"));
const renderedRows = countClass(scroller, "user-msg-block") + countClass(scroller, "system-msg");
assert(renderedRows > 0);
assert(renderedRows < 20);

const normalizedConfig = normalizeConfig({
  max_messages: 1,
  notification_rules: { mode: "sirens", popup_alerts: false },
  display: { timestamp_format: "planetary" },
});
assert.equal(normalizedConfig.max_messages, 50);
assert.equal(normalizedConfig.notification_rules.mode, "dms");
assert.equal(normalizedConfig.notification_rules.popup_alerts, false);
assert.equal(normalizedConfig.display.timestamp_format, "24h");

const contentRoot = new TestNode("div");
globalThis.document = createTestDocument();
state.config = { rich_previews: false };
appendFormattedContent(contentRoot, "look https://example.com/photo.png");
assert.equal(countClass(contentRoot, "img-preview"), 0);

const previewRoot = new TestNode("div");
state.config = { rich_previews: true };
appendFormattedContent(previewRoot, "look https://example.com/photo.png");
assert.equal(countClass(previewRoot, "img-preview"), 1);

const youtubeRoot = new TestNode("div");
globalThis.document = createTestDocument();
appendFormattedContent(youtubeRoot, "watch https://www.youtube.com/watch?v=dQw4w9WgXcQ");
const youtubeAnchor = findClass(youtubeRoot, "youtube-link");
const youtubeChip = findClass(youtubeRoot, "youtube-popout-chip");
assert(youtubeAnchor, "YouTube links should receive popout link styling");
assert(youtubeChip, "YouTube links should get an explicit popout action");
assert.equal(youtubeAnchor.textContent, "youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(youtubeChip.textContent, "▶");
let prevented = false;
youtubeAnchor.eventListeners.click({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: () => { prevented = true; },
  stopPropagation() {},
});
const popout = findClass(globalThis.document.body, "youtube-popout");
assert(prevented, "YouTube click should be intercepted before external navigation");
assert(popout?.classList.contains("active"), "YouTube click should show the floating player");
assert.equal(findTag(popout, "iframe")?.src.includes("youtube-nocookie.com/embed/dQw4w9WgXcQ"), true);

console.log("Regression tests passed: persistence compaction, NickServ routing, unread routing, message request handoff, nicklist rendering, direct inbox routing, YouTube popout parsing, virtualized rendering, settings normalization, rich preview toggle.");
