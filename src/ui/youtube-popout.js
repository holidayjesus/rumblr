import { sessionStore } from '../core/persistence.js';
import { invoke } from '../core/tauri.js';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
let shell = null;
let iframe = null;
let title = null;
let externalButton = null;
let activeInfo = null;

function openExternal(url) {
  if (window.__TAURI__?.opener?.open) window.__TAURI__.opener.open(url);
  else window.open(url, '_blank', 'noopener');
}

function wantsExternalOpen(event) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1;
}

function videoIdFromPath(url, prefix) {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.indexOf(prefix);
  return index >= 0 ? parts[index + 1] : '';
}

function normalizeVideoId(value = '') {
  const id = String(value || '').trim();
  return VIDEO_ID_RE.test(id) ? id : '';
}

export function youtubeEmbedInfo(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';

    if (host === 'youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      id = url.searchParams.get('v') || videoIdFromPath(url, 'shorts') || videoIdFromPath(url, 'live') || videoIdFromPath(url, 'embed');
    }

    id = normalizeVideoId(id);
    if (!id) return null;

    return {
      id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1`,
    };
  } catch (_) {
    return null;
  }
}

export function isYoutubeUrl(rawUrl) {
  return Boolean(youtubeEmbedInfo(rawUrl));
}

function clampLayout(layout) {
  const margin = 14;
  const viewportWidth = Math.max(window.innerWidth || 900, 360);
  const viewportHeight = Math.max(window.innerHeight || 700, 360);
  const width = Math.min(Math.max(layout.width || 460, 340), viewportWidth - margin * 2);
  const height = Math.min(Math.max(layout.height || 306, 236), viewportHeight - margin * 2);
  const x = Math.min(Math.max(layout.x ?? viewportWidth - width - 28, margin), viewportWidth - width - margin);
  const y = Math.min(Math.max(layout.y ?? viewportHeight - height - 92, margin), viewportHeight - height - margin);
  return { x, y, width, height };
}

function applyLayout(layout, { save = true } = {}) {
  if (!shell) return;
  const next = clampLayout(layout);
  shell.style.left = `${next.x}px`;
  shell.style.top = `${next.y}px`;
  shell.style.width = `${next.width}px`;
  shell.style.height = `${next.height}px`;
  if (save) sessionStore.setYoutubePopoutLayout(next);
}

function currentLayout() {
  const rect = shell?.getBoundingClientRect?.();
  if (!rect) return sessionStore.getYoutubePopoutLayout();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function closeYoutubePopout() {
  if (!shell) return;
  shell.hidden = true;
  shell.classList.remove('active');
  if (iframe) iframe.src = 'about:blank';
  activeInfo = null;
}

function startDrag(event) {
  if (event.button !== 0 || event.target.closest('button')) return;
  event.preventDefault();
  const start = currentLayout();
  const startX = event.clientX;
  const startY = event.clientY;
  const target = event.currentTarget;
  target.setPointerCapture?.(event.pointerId);
  shell.classList.add('dragging');

  const move = (moveEvent) => {
    applyLayout({ ...start, x: start.x + moveEvent.clientX - startX, y: start.y + moveEvent.clientY - startY });
  };
  const done = () => {
    shell.classList.remove('dragging');
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', done);
    target.removeEventListener('pointercancel', done);
  };

  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', done);
  target.addEventListener('pointercancel', done);
}

function startResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const start = currentLayout();
  const startX = event.clientX;
  const startY = event.clientY;
  const target = event.currentTarget;
  target.setPointerCapture?.(event.pointerId);
  shell.classList.add('resizing');

  const move = (moveEvent) => {
    applyLayout({
      ...start,
      width: start.width + moveEvent.clientX - startX,
      height: start.height + moveEvent.clientY - startY,
    });
  };
  const done = () => {
    shell.classList.remove('resizing');
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', done);
    target.removeEventListener('pointercancel', done);
  };

  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', done);
  target.addEventListener('pointercancel', done);
}

function ensureYoutubePopout() {
  if (shell) return shell;

  shell = document.createElement('section');
  shell.className = 'youtube-popout';
  shell.hidden = true;
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', 'YouTube player');

  const header = document.createElement('div');
  header.className = 'youtube-popout-header';
  header.addEventListener('pointerdown', startDrag);

  const grip = document.createElement('span');
  grip.className = 'youtube-popout-grip';
  grip.setAttribute('aria-hidden', 'true');

  title = document.createElement('div');
  title.className = 'youtube-popout-title';
  title.textContent = 'YouTube';

  const actions = document.createElement('div');
  actions.className = 'youtube-popout-actions';

  externalButton = document.createElement('button');
  externalButton.type = 'button';
  externalButton.className = 'youtube-popout-action';
  externalButton.title = 'Open on YouTube';
  externalButton.setAttribute('aria-label', 'Open on YouTube');
  externalButton.textContent = '↗';
  externalButton.addEventListener('click', () => {
    if (activeInfo) openExternal(activeInfo.canonicalUrl);
  });

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'youtube-popout-action';
  closeButton.title = 'Close player';
  closeButton.setAttribute('aria-label', 'Close player');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', closeYoutubePopout);

  actions.append(externalButton, closeButton);
  header.append(grip, title, actions);

  const body = document.createElement('div');
  body.className = 'youtube-popout-body';
  iframe = document.createElement('iframe');
  iframe.title = 'YouTube video player';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  body.appendChild(iframe);

  const resize = document.createElement('button');
  resize.type = 'button';
  resize.className = 'youtube-popout-resize';
  resize.setAttribute('aria-label', 'Resize YouTube player');
  resize.addEventListener('pointerdown', startResize);

  shell.append(header, body, resize);
  document.body.appendChild(shell);
  window.addEventListener('resize', () => applyLayout(currentLayout(), { save: false }));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shell?.classList.contains('active')) closeYoutubePopout();
  });
  return shell;
}

function openInlineYoutubePopout(info) {
  if (!info) return false;
  ensureYoutubePopout();
  activeInfo = info;
  title.textContent = `YouTube · ${info.id}`;
  iframe.src = info.embedUrl;
  shell.hidden = false;
  shell.classList.add('active');
  // Persisting the player geometry lets the popout feel like a real tool, not a transient preview.
  applyLayout(sessionStore.getYoutubePopoutLayout(), { save: false });
  return true;
}

async function openNativeYoutubePlayer(info) {
  await invoke('open_youtube_player', { videoId: info.id });
}

export function openYoutubePopout(rawUrl) {
  const info = youtubeEmbedInfo(rawUrl);
  if (!info) return false;
  if (window.__RUMBLR_FORCE_INLINE_YOUTUBE__) return openInlineYoutubePopout(info);
  openNativeYoutubePlayer(info).catch((error) => {
    console.warn('[Rumblr] Native YouTube popout failed; using inline fallback.', error);
    openInlineYoutubePopout(info);
  });
  return true;
}


export function handleYoutubeLinkClick(event, rawUrl) {
  if (wantsExternalOpen(event)) return false;
  const info = youtubeEmbedInfo(rawUrl);
  if (!info) return false;
  event.preventDefault();
  event.stopPropagation();
  openYoutubePopout(info.canonicalUrl);
  return true;
}

export function setupYoutubePopoutLinks(root = document) {
  root.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    handleYoutubeLinkClick(event, anchor.href || anchor.getAttribute('href'));
  }, true);
}
