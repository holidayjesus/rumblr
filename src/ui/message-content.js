import { MIRC_COLORS, state } from '../core/state.js';
import { handleYoutubeLinkClick, isYoutubeUrl, openYoutubePopout } from './youtube-popout.js';

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

function safeHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

function isPreviewableImage(url) {
  return /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i.test(url);
}

function displayUrlLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/$/, '');
    const query = url.searchParams.get('v') ? `?v=${url.searchParams.get('v')}` : '';
    return `${url.hostname.replace(/^www\./, '')}${path}${query}`;
  } catch (_) {
    return rawUrl;
  }
}

function appendHighlightedText(parent, text, searchQuery = "") {
  if (!searchQuery) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const q = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(q, "gi");
  let index = 0;
  for (const match of text.matchAll(re)) {
    if (match.index > index) parent.appendChild(document.createTextNode(text.slice(index, match.index)));
    const mark = document.createElement("mark");
    mark.className = "search-hl";
    mark.textContent = match[0];
    parent.appendChild(mark);
    index = match.index + match[0].length;
  }
  if (index < text.length) parent.appendChild(document.createTextNode(text.slice(index)));
}

function appendLinkPreview(parent, url) {
  const preview = document.createElement("div");
  preview.className = "img-preview";
  preview.addEventListener("click", () => preview.classList.toggle("expanded"));

  const img = document.createElement("img");
  img.src = url;
  img.loading = "lazy";
  img.alt = "image";
  img.addEventListener("error", () => {
    preview.style.display = "none";
  });
  preview.appendChild(img);
  parent.appendChild(preview);
}

function appendLinkedText(parent, text, searchQuery = "") {
  let cursor = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > cursor) appendHighlightedText(parent, text.slice(cursor, match.index), searchQuery);
    const rawUrl = match[0];
    const url = safeHttpUrl(rawUrl);
    if (url) {
      const anchor = document.createElement("a");
      const youtubeLink = isYoutubeUrl(url);
      const linkWrap = document.createElement("span");
      linkWrap.className = youtubeLink ? "message-link-run youtube-link-run" : "message-link-run";
      anchor.className = youtubeLink ? "irc-link youtube-link" : "irc-link";
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.textContent = youtubeLink ? displayUrlLabel(url) : rawUrl;
      anchor.title = rawUrl;
      if (youtubeLink) anchor.setAttribute("aria-label", "Open YouTube popout");
      anchor.addEventListener("click", (event) => {
        if (youtubeLink && handleYoutubeLinkClick(event, url)) return;
        event.preventDefault();
        if (window.__TAURI__?.opener?.open) window.__TAURI__.opener.open(url);
        else window.open(url, "_blank", "noopener");
      });
      linkWrap.appendChild(anchor);
      if (youtubeLink) {
        const popout = document.createElement("button");
        popout.type = "button";
        popout.className = "youtube-popout-chip";
        popout.textContent = "▶";
        popout.title = "Open YouTube popout";
        popout.setAttribute("aria-label", "Open YouTube popout");
        popout.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openYoutubePopout(url);
        });
        linkWrap.appendChild(popout);
      }
      parent.appendChild(linkWrap);
      if (state.config?.rich_previews !== false && isPreviewableImage(url)) appendLinkPreview(parent, url);
    } else {
      appendHighlightedText(parent, rawUrl, searchQuery);
    }
    cursor = match.index + rawUrl.length;
  }
  if (cursor < text.length) appendHighlightedText(parent, text.slice(cursor), searchQuery);
}

function applyIrcStyle(el, style) {
  if (style.bold) el.style.fontWeight = "700";
  if (style.italic) el.style.fontStyle = "italic";
  if (style.underline) el.style.textDecoration = "underline";
  if (style.fg) el.style.color = style.fg;
  if (style.bg) el.style.backgroundColor = style.bg;
}

function appendStyledRun(parent, text, style, searchQuery) {
  if (!text) return;
  const hasStyle = style.bold || style.italic || style.underline || style.fg || style.bg;
  const target = hasStyle ? document.createElement("span") : parent;
  if (hasStyle) applyIrcStyle(target, style);
  appendLinkedText(target, text, searchQuery);
  if (hasStyle) parent.appendChild(target);
}

export function appendFormattedContent(parent, raw = "", { searchQuery = "" } = {}) {
  // IRC formatting is parsed into DOM nodes instead of injected HTML. That
  // preserves bold/color/link previews while keeping network-controlled text
  // out of executable markup and inline handlers.
  parent.replaceChildren();
  const text = String(raw || "");
  const style = { bold: false, italic: false, underline: false, fg: "", bg: "" };
  let buffer = "";

  const flush = () => {
    appendStyledRun(parent, buffer, style, searchQuery);
    buffer = "";
  };

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x02) {
      flush();
      style.bold = !style.bold;
    } else if (code === 0x1D) {
      flush();
      style.italic = !style.italic;
    } else if (code === 0x1F) {
      flush();
      style.underline = !style.underline;
    } else if (code === 0x0F) {
      flush();
      style.bold = false;
      style.italic = false;
      style.underline = false;
      style.fg = "";
      style.bg = "";
    } else if (code === 0x03) {
      flush();
      let fg = "";
      let bg = "";
      while (i + 1 < text.length && /\d/.test(text[i + 1]) && fg.length < 2) fg += text[++i];
      if (text[i + 1] === ",") {
        i++;
        while (i + 1 < text.length && /\d/.test(text[i + 1]) && bg.length < 2) bg += text[++i];
      }
      style.fg = fg ? MIRC_COLORS[parseInt(fg, 10) % 16] || "" : "";
      style.bg = bg ? MIRC_COLORS[parseInt(bg, 10) % 16] || "" : "";
    } else {
      buffer += text[i];
    }
  }
  flush();
}

export function formattedContentElement(className, raw, options) {
  const el = document.createElement("div");
  el.className = className;
  appendFormattedContent(el, raw, options);
  return el;
}
