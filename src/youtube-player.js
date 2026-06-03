const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const params = new URLSearchParams(window.location.search);
const videoId = String(params.get('videoId') || '').trim();
const statusPanel = document.querySelector('#player-status');
const statusTitle = statusPanel?.querySelector('strong');
const statusBody = statusPanel?.querySelector('span');
const watchButton = document.querySelector('#watch-now');

function watchUrl() {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&app=desktop`;
}

function setStatus(title, body, { showButton = true } = {}) {
  if (statusTitle) statusTitle.textContent = title;
  if (statusBody) statusBody.textContent = body;
  if (watchButton) watchButton.hidden = !showButton;
  if (statusPanel) statusPanel.hidden = false;
}

function hideStatus() {
  if (statusPanel) statusPanel.hidden = true;
}

async function tauriInvoke(command, args) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!invoke) throw new Error('Tauri invoke unavailable.');
  return invoke(command, args);
}

function openWatchPage() {
  window.location.replace(watchUrl());
}

async function promoteToWatchPage() {
  try {
    await tauriInvoke('show_youtube_watch_page', { videoId });
  } catch (_) {
    openWatchPage();
  }
}

watchButton?.addEventListener('click', openWatchPage);

if (!VIDEO_ID_RE.test(videoId)) {
  setStatus('Invalid YouTube link', 'Rumblr could not find a playable video id in that URL.', { showButton: false });
} else {
  window.onYouTubeIframeAPIReady = () => {
    try {
      new window.YT.Player('player', {
        width: '100%',
        height: '100%',
        videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady(event) {
            hideStatus();
            event.target.playVideo?.();
          },
          onError(event) {
            // YouTube Error 153 is the embed/referrer failure case. Only then do
            // we promote the popout to the normal native YouTube watch page.
            if (Number(event.data) === 153) {
              setStatus('Opening YouTube', "The embedded player needs YouTube's watch page for this video.");
              promoteToWatchPage();
              return;
            }
            setStatus('This video cannot play here', `YouTube returned error ${event.data}.`);
          },
        },
      });
    } catch (error) {
      setStatus('Player failed to start', String(error || 'Unknown YouTube player error.'));
    }
  };

  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.async = true;
  script.onerror = () => setStatus('YouTube did not load', 'The player API could not be reached.');
  document.head.appendChild(script);
}
