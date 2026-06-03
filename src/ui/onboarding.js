import { state, PRESETS } from '../core/state.js';
import { saveAppConfig } from '../core/config-store.js';
import { sessionStore } from '../core/persistence.js';
import { invoke } from '../core/tauri.js';
import { ui } from './ui-engine.js';
import { renderSidebar, selectChannel, selectServer } from './sidebar.js';

const NETWORK_CHOICES = ['libera', 'oftc', 'snoonet', 'efnet'];

function selectedPreset() {
  const id = document.querySelector('#onboard-network')?.value || 'libera';
  return { id, preset: PRESETS[id] || PRESETS.libera };
}

function normalizedChannel() {
  const raw = document.querySelector('#onboard-channel')?.value.trim() || '#rumblr';
  return raw.startsWith('#') || raw.startsWith('&') ? raw : `#${raw}`;
}

function setOnboardingStatus(message, tone = 'idle') {
  const status = document.querySelector('#onboarding-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function populateOnboarding() {
  const network = document.querySelector('#onboard-network');
  if (network && !network.children.length) {
    NETWORK_CHOICES.forEach((id) => {
      const preset = PRESETS[id];
      if (!preset) return;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${preset.name} - ${preset.host}:${preset.port}`;
      network.appendChild(option);
    });
  }
  ui.val('#onboard-nick', state.config?.global_nickname || 'RumblrUser');
  ui.val('#onboard-alt-nick', state.config?.global_alt_nickname || `${ui.val('#onboard-nick') || 'RumblrUser'}_`);
  ui.val('#onboard-channel', state.config?.servers?.[0]?.autojoin?.[0] || '#rumblr');
}

async function testOnboardingConnection() {
  const { preset } = selectedPreset();
  setOnboardingStatus('Testing host, port, and TLS handshake...', 'idle');
  try {
    const result = await invoke('test_network_connection', {
      host: preset.host,
      port: Number(preset.port),
      useSsl: preset.ssl !== false,
    });
    setOnboardingStatus(result || 'Connection test succeeded.', 'ok');
  } catch (error) {
    setOnboardingStatus(String(error || 'Connection test failed.'), 'warn');
  }
}

// Onboarding intentionally writes a complete, normal config so first-run users land in the same path as returning users.
async function finishOnboarding({ connect = true } = {}) {
  const nick = ui.val('#onboard-nick').trim() || 'RumblrUser';
  const altNick = ui.val('#onboard-alt-nick').trim() || `${nick}_`;
  const { id, preset } = selectedPreset();
  const channel = normalizedChannel();
  const server = {
    id,
    name: preset.name,
    host: preset.host,
    port: Number(preset.port),
    use_ssl: preset.ssl !== false,
    autojoin: [channel],
  };

  const existing = Array.isArray(state.config?.servers) ? state.config.servers : [];
  const mergedServers = [server, ...existing.filter((item) => String(item.id) !== id)];
  state.config = {
    ...(state.config || {}),
    global_nickname: nick,
    global_alt_nickname: altNick,
    global_realname: state.config?.global_realname || 'Rumblr user',
    servers: mergedServers,
  };

  await saveAppConfig(state.config);
  state.activeServer = String(server.id);
  selectChannel(server.id, channel);
  renderSidebar();
  sessionStore.setOnboardingComplete(true);
  ui.hide('#onboarding-panel');
  setOnboardingStatus('Setup saved.', 'ok');
  if (connect) await selectServer(server.id);
}

function skipOnboarding() {
  sessionStore.setOnboardingComplete(true);
  ui.hide('#onboarding-panel');
}

export function maybeOpenOnboarding() {
  if (document.body.classList.contains('messages-window')) return;
  if (sessionStore.isOnboardingComplete()) return;
  populateOnboarding();
  ui.show('#onboarding-panel');
  document.querySelector('#onboard-nick')?.focus();
}

export function setupOnboarding() {
  document.querySelector('#onboard-test')?.addEventListener('click', testOnboardingConnection);
  document.querySelector('#onboard-start')?.addEventListener('click', () => finishOnboarding());
  document.querySelector('#onboard-skip')?.addEventListener('click', skipOnboarding);
  document.querySelector('#onboarding-skip-x')?.addEventListener('click', skipOnboarding);
  document.querySelector('#onboard-nick')?.addEventListener('input', () => {
    const nick = ui.val('#onboard-nick').trim() || 'RumblrUser';
    const alt = document.querySelector('#onboard-alt-nick');
    if (alt && !alt.dataset.touched) alt.value = `${nick}_`;
  });
  document.querySelector('#onboard-alt-nick')?.addEventListener('input', (event) => {
    event.currentTarget.dataset.touched = 'true';
  });
  document.querySelector('#onboard-network')?.addEventListener('change', () => {
    const { preset } = selectedPreset();
    ui.val('#onboard-channel', preset.autojoin?.[0] || '#rumblr');
    setOnboardingStatus('Network changed. Test it when you are ready.', 'idle');
  });
}
