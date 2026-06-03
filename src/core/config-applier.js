import { state, THEMES } from './state.js';
import { sessionStore } from './persistence.js';

const supportedThemeIds = new Set(Object.keys(THEMES));

function resolveThemeId(themeId) {
  // Retired experimental theme IDs intentionally return to the default. Keeping
  // the resolver tiny makes the supported theme catalog match the picker.
  return supportedThemeIds.has(themeId) ? themeId : "carbon";
}

export function applyConfigToDom(themeOverride = "", { persist = true } = {}) {
  const cfg = state.config;
  if (!cfg) return;

  const storedTheme = sessionStore.getTheme("");
  const themeId = resolveThemeId(themeOverride || storedTheme || cfg.theme);
  cfg.theme = themeId;
  const theme = THEMES[themeId];
  document.body.setAttribute('data-theme', themeId);
  document.documentElement.setAttribute('data-theme', themeId);
  const themeFinish = themeId === "carbon" ? "standard" : "premium";
  document.body.setAttribute('data-theme-finish', themeFinish);
  document.documentElement.setAttribute('data-theme-finish', themeFinish);
  for (const [key, value] of Object.entries(theme.vars)) {
    document.documentElement.style.setProperty(key, value);
  }
  if (persist) sessionStore.setTheme(themeId);

  // Apply GPU Acceleration
  if (cfg.gpu_accel !== false) {
    document.body.classList.add('gpu-enabled');
  } else {
    document.body.classList.remove('gpu-enabled');
  }

  const display = cfg.display || {};
  document.body.classList.toggle('avatars-hidden', display.show_avatars === false);
  state.signalFilter = display.show_join_part === false;
}

export function applyTheme(themeId, options = {}) {
  if (!state.config) return;
  state.config.theme = resolveThemeId(themeId);
  applyConfigToDom(state.config.theme, options);
}
