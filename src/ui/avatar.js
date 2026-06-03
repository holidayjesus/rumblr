import { state, norm } from '../core/state.js';

export function identiconUrl(seed) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed || "")}`;
}

export function selfNickCandidates(serverId = state.activeServer) {
  const server = state.config?.servers?.find(s => String(s.id) === String(serverId));
  return [
    "me",
    state.currentNicks?.[serverId],
    server?.nickname,
    state.config?.global_nickname,
  ].filter(Boolean).map(norm);
}

export function isSelfNick(serverId, username) {
  const clean = norm(username);
  return Boolean(clean && selfNickCandidates(serverId).includes(clean));
}

export function avatarUrlForNick(nick, serverId = state.activeServer) {
  const custom = state.config?.profile?.avatar_data_url;
  if (custom && isSelfNick(serverId, nick)) return custom;
  return identiconUrl(nick);
}

export function selfAvatarUrl(serverId = state.activeServer) {
  const nick = state.currentNicks?.[serverId] || state.config?.global_nickname || "Me";
  return state.config?.profile?.avatar_data_url || identiconUrl(nick);
}

export function syncProfileAvatarImages() {
  const myNick = state.config?.global_nickname || "Me";
  const avatar = selfAvatarUrl();
  document.querySelectorAll(".profile-img, .profile-img-mini, .messages-profile-avatar img").forEach((img) => {
    img.src = avatar;
  });
  document.querySelectorAll(".profile-name, .messages-profile-name").forEach((el) => {
    el.textContent = myNick;
  });
}
