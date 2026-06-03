export const state = {
  config: null,
  activeServer: null,
  activeChannel: '#general',
  topics: {},
  messages: {},
  typing: {},              // transient IRCv3 typing indicators, never persisted
  users: {},
  channelList: {},
  listeners: [],
  tempServers: [],
  editingNetIndex: -1,
  unreads: {},
  searchQuery: "",
  maxMessages: 500,
  netStatus: {},
  netDetails: {},
  spotifyStatus: "",
  history: [],
  historyIndex: -1,
  tempInput: "",
  scrollPositions: {},    // buffer scroll memory
  lastReadIndex: {},      // index of last read message per buffer
  messageRenderLimits: {}, // medium-buffer paging; huge buffers use viewport virtualization
  notificationRules: {
    mode: "dms",           // all | mentions | dms
    quietHours: false,
    quietStart: "22:00",
    quietEnd: "08:00",
    popupAlerts: true,
    mutedBuffers: {},
  },
  collapsedServers: {},   // sidebar collapse state per server
  mps: 0,                 // messages per second tracking
  msgCount: 0,
  mediaStatus: "",
  currentNicks: {},          // Current nickname per connected server
  presence: "online",
  awaySince: null,
  awayReplyCooldowns: {},
  channelListResults: [],   // Accumulator for /list
  isListing: false,         // Are we currently receiving a /list?
  channelListError: "",      // Last server-side /list refusal or timeout
  channelListStatusMessage: "", // Extra /list state shown in the browser empty view
  pendingUserList: {},      // Accumulator for RPL_NAMREPLY batches
  telemetryLogs: [],        // Store debug/system logs for (TELEMETRY) view
  aliases: {},              // User-defined command aliases
  pendingDccOffer: null,    // Incoming CTCP DCC SEND offer waiting for action
  activeDccTransferId: "",  // Active backend DCC transfer id for progress events
  activeDccSavePath: "",    // Completed transfer path for reveal/open actions
  signalFilter: true,      // Hide JOIN/PART/QUIT if true
  sessionStartTime: null,   // Set on boot
  totalMessagesProcessed: 0,
};

export const PRESETS = {
  libera: { name: 'Libera.Chat', host: 'irc.libera.chat', port: 6697, ssl: true, autojoin: ['#rumblr'] },
  snoonet: { name: 'Snoonet', host: 'irc.snoonet.org', port: 6697, ssl: true, autojoin: ['#snoonet'] },
  oftc: { name: 'OFTC', host: 'irc.oftc.net', port: 6697, ssl: true, autojoin: ['#oftc'] },
  efnet: { name: 'EFNet', host: 'irc.efnet.org', port: 6697, ssl: true, autojoin: ['#efnet'] },
  dalnet: { name: 'DALNet', host: 'irc.dal.net', port: 6697, ssl: true, autojoin: ['#general'] },
  quakenet: { name: 'QuakeNet', host: 'irc.quakenet.org', port: 6667, ssl: false, autojoin: ['#quakenet'] },
  undernet: { name: 'Undernet', host: 'irc.undernet.org', port: 6667, ssl: false, autojoin: ['#undernet'] },
};

export const MIRC_COLORS = ['#ccc', '#000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00', '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2'];

const premiumTheme = ({
  name,
  mood,
  bgApp,
  bgSidebar,
  surface,
  surfaceLight,
  primary,
  primaryGlow,
  accent,
  accentGlow,
  onPrimary,
  onSurface,
  muted,
  border,
  header,
  sidebar,
  main,
  right,
  card,
  input,
  selection,
  rail,
}) => ({
  name,
  mood,
  vars: {
    "--bg-app": bgApp,
    "--bg-sidebar": bgSidebar,
    "--surface": surface,
    "--surface-light": surfaceLight,
    "--primary": primary,
    "--primary-glow": primaryGlow,
    "--media-accent": accent,
    "--media-accent-glow": accentGlow,
    "--on-primary": onPrimary,
    "--on-surface": onSurface,
    "--on-surface-muted": muted,
    "--border": border,
    "--theme-header-panel": header,
    "--theme-sidebar-panel": sidebar,
    "--theme-main-panel": main,
    "--theme-right-panel": right,
    "--theme-card-panel": card,
    "--theme-input-panel": input,
    "--theme-selection": selection,
    "--theme-rail-line": rail,
  },
});

// Keep the visible theme catalog curated. Carbon stays the product baseline;
// the other entries are complete visual worlds that share the same surface API.
export const THEMES = {
  carbon: {
    name: "Rumblr Carbon",
    mood: "Default dark interface",
    vars: {
      "--bg-app": "#090a0b",
      "--bg-sidebar": "#111315",
      "--surface": "#191c1f",
      "--surface-light": "#252a2f",
      "--primary": "#d1d5db",
      "--primary-glow": "rgba(209, 213, 219, 0.16)",
      "--media-accent": "#d1d5db",
      "--media-accent-glow": "rgba(209, 213, 219, 0.16)",
      "--on-primary": "#050607",
      "--on-surface": "#f2f4f5",
      "--on-surface-muted": "#9ca3af",
      "--border": "rgba(209, 213, 219, 0.1)",
    },
  },
  aquaSocial: premiumTheme({
    name: "Aqua Social",
    mood: "Clean light social interface",
    bgApp: "#f5f8fb",
    bgSidebar: "#f7f9fb",
    surface: "#ffffff",
    surfaceLight: "#ffffff",
    primary: "#1d9bf0",
    primaryGlow: "rgba(29, 155, 240, 0.18)",
    accent: "#0a84ff",
    accentGlow: "rgba(10, 132, 255, 0.16)",
    onPrimary: "#ffffff",
    onSurface: "#0f1419",
    muted: "#536471",
    border: "rgba(15, 20, 25, 0.12)",
    header: "rgba(255, 255, 255, 0.82)",
    sidebar: "rgba(247, 249, 251, 0.9)",
    main: "#ffffff",
    right: "rgba(247, 249, 251, 0.9)",
    card: "#ffffff",
    input: "#f7f9fb",
    selection: "rgba(29, 155, 240, 0.18)",
    rail: "rgba(29, 155, 240, 0.24)",
  }),
  toxic: premiumTheme({
    name: "Toxic",
    mood: "Neon green and black. Competitive and alive.",
    bgApp: "#020604",
    bgSidebar: "#06110b",
    surface: "#07120d",
    surfaceLight: "#102319",
    primary: "#9af25a",
    primaryGlow: "rgba(154, 242, 90, 0.22)",
    accent: "#86f04a",
    accentGlow: "rgba(134, 240, 74, 0.2)",
    onPrimary: "#041006",
    onSurface: "#ecf7e7",
    muted: "#8ca58d",
    border: "rgba(145, 236, 85, 0.18)",
    header: "rgba(4, 10, 7, 0.9)",
    sidebar: "rgba(5, 15, 10, 0.92)",
    main: "#020604",
    right: "rgba(5, 14, 10, 0.94)",
    card: "rgba(8, 22, 14, 0.9)",
    input: "rgba(10, 24, 15, 0.88)",
    selection: "rgba(134, 240, 74, 0.22)",
    rail: "rgba(134, 240, 74, 0.34)",
  }),
  blackOps: premiumTheme({
    name: "Black Ops",
    mood: "Bold black and amber. Clean, iconic, tactical.",
    bgApp: "#020202",
    bgSidebar: "#080807",
    surface: "#0b0b0a",
    surfaceLight: "#171513",
    primary: "#ff8a1f",
    primaryGlow: "rgba(255, 123, 22, 0.18)",
    accent: "#ff7a1a",
    accentGlow: "rgba(255, 122, 26, 0.18)",
    onPrimary: "#0b0501",
    onSurface: "#f2eee8",
    muted: "#a69d93",
    border: "rgba(255, 138, 31, 0.16)",
    header: "rgba(7, 7, 6, 0.94)",
    sidebar: "rgba(9, 9, 8, 0.94)",
    main: "#030303",
    right: "rgba(8, 8, 7, 0.95)",
    card: "rgba(15, 14, 13, 0.92)",
    input: "rgba(17, 16, 15, 0.9)",
    selection: "rgba(255, 122, 26, 0.2)",
    rail: "rgba(255, 138, 31, 0.3)",
  }),
  toxicRed: premiumTheme({
    name: "Toxic Red",
    mood: "Dark, intense, relentless.",
    bgApp: "#030000",
    bgSidebar: "#0b0303",
    surface: "#110504",
    surfaceLight: "#24100e",
    primary: "#ff3028",
    primaryGlow: "rgba(255, 48, 40, 0.2)",
    accent: "#d9251d",
    accentGlow: "rgba(217, 37, 29, 0.2)",
    onPrimary: "#160201",
    onSurface: "#f6e8e3",
    muted: "#a98582",
    border: "rgba(255, 48, 40, 0.18)",
    header: "rgba(10, 3, 3, 0.94)",
    sidebar: "rgba(11, 3, 3, 0.94)",
    main: "#050101",
    right: "rgba(13, 4, 4, 0.95)",
    card: "rgba(22, 7, 6, 0.92)",
    input: "rgba(24, 8, 7, 0.9)",
    selection: "rgba(255, 48, 40, 0.22)",
    rail: "rgba(255, 48, 40, 0.32)",
  }),
  nightfall: premiumTheme({
    name: "Nightfall",
    mood: "Icy blue and navy. Calm before the rain.",
    bgApp: "#040913",
    bgSidebar: "#081320",
    surface: "#0b1728",
    surfaceLight: "#13263e",
    primary: "#9ccaff",
    primaryGlow: "rgba(117, 174, 245, 0.22)",
    accent: "#74aef5",
    accentGlow: "rgba(116, 174, 245, 0.2)",
    onPrimary: "#04101d",
    onSurface: "#edf6ff",
    muted: "#93a9c4",
    border: "rgba(122, 177, 238, 0.18)",
    header: "rgba(6, 13, 24, 0.9)",
    sidebar: "rgba(8, 19, 32, 0.92)",
    main: "#050b16",
    right: "rgba(8, 18, 30, 0.94)",
    card: "rgba(11, 24, 40, 0.9)",
    input: "rgba(12, 27, 45, 0.88)",
    selection: "rgba(116, 174, 245, 0.22)",
    rail: "rgba(116, 174, 245, 0.32)",
  }),
  stealth: premiumTheme({
    name: "Stealth",
    mood: "Dark gray and silver. Silent and focused.",
    bgApp: "#07090a",
    bgSidebar: "#101315",
    surface: "#15191c",
    surfaceLight: "#20262a",
    primary: "#c8d0d6",
    primaryGlow: "rgba(200, 208, 214, 0.16)",
    accent: "#b8c2ca",
    accentGlow: "rgba(184, 194, 202, 0.15)",
    onPrimary: "#050607",
    onSurface: "#f2f5f7",
    muted: "#9aa4ab",
    border: "rgba(190, 200, 210, 0.14)",
    header: "rgba(12, 14, 15, 0.92)",
    sidebar: "rgba(15, 18, 20, 0.94)",
    main: "#080a0b",
    right: "rgba(14, 17, 19, 0.94)",
    card: "rgba(20, 24, 27, 0.9)",
    input: "rgba(24, 29, 32, 0.88)",
    selection: "rgba(190, 200, 210, 0.2)",
    rail: "rgba(190, 200, 210, 0.24)",
  }),
  phosphorGlass: premiumTheme({
    name: "Phosphor Glass",
    mood: "90s futuristic translucency.",
    bgApp: "#03080a",
    bgSidebar: "rgba(7, 17, 22, 0.82)",
    surface: "#08151b",
    surfaceLight: "#102833",
    primary: "#9dfce5",
    primaryGlow: "rgba(112, 241, 222, 0.2)",
    accent: "#66d7ff",
    accentGlow: "rgba(102, 215, 255, 0.2)",
    onPrimary: "#031016",
    onSurface: "#eefcff",
    muted: "#8fb6bf",
    border: "rgba(126, 229, 255, 0.18)",
    header: "rgba(5, 13, 17, 0.72)",
    sidebar: "rgba(7, 18, 23, 0.7)",
    main: "rgba(3, 8, 10, 0.88)",
    right: "rgba(6, 16, 21, 0.72)",
    card: "rgba(9, 23, 30, 0.62)",
    input: "rgba(10, 25, 32, 0.68)",
    selection: "rgba(102, 215, 255, 0.22)",
    rail: "rgba(126, 229, 255, 0.3)",
  }),
};

export const hierarchy = { '~': 0, '&': 1, '@': 2, '%': 3, '+': 4, '': 5 };

export function discoverBuffer(serverId, rawName) {
  if (!rawName || !state.config || !state.config.servers) return;
  const nBuffer = norm(rawName);
  if (nBuffer.startsWith('*') || nBuffer === 'system' || nBuffer === '(list)' || nBuffer === '(logs)') return;
  if (!(rawName.startsWith("#") || rawName.startsWith("&"))) return;
  
  const activeSrvId = String(serverId);
  const server = state.config.servers.find(s => String(s.id) === activeSrvId);
  if (server) {
    if (!server.autojoin) server.autojoin = [];
    if (!server.autojoin.find(b => norm(b) === nBuffer)) {
      server.autojoin.push(rawName);
      // Discovery is the moment a channel becomes part of the workspace, so
      // persist the runtime session immediately instead of waiting for traffic.
      window.dispatchEvent(new CustomEvent("buffers-changed"));
      window.dispatchEvent(new CustomEvent("refresh-sidebar"));
    }
  }
}


export const norm = (c) => (c || "").toLowerCase().trim();

export const parseUser = (raw) => {
  if (!raw) return { status: "", nick: "" };
  const match = raw.match(/^([@+&%~]*)(.*)$/);
  return { status: match ? (match[1] || "") : "", nick: match ? match[2] : raw };
};
