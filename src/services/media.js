import { state } from '../core/state.js';
import { invoke } from '../core/tauri.js';
import { ui } from '../ui/ui-engine.js';
import { appendMessage, formatTimestamp } from '../ui/messages.js';
import { svgEl } from '../ui/dom.js';

// The sidebar media widget is intentionally compact. It presents only the
// media actions that are dependable in the small IRC sidebar: transport,
// timeline seeking, and sharing the current track into chat.
const FALLBACK_ART =
  "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=300&auto=format&fit=crop";

const mediaSelectors = {
  widget: "#media-sidebar-widget",
  title: "#media-title",
  artist: "#media-artist",
  album: "#media-album",
  progressBar: "#media-progress-bar",
  progressFill: "#media-progress-fill",
  currentTime: "#media-time-current",
  totalTime: "#media-time-total",
  playPause: "#btn-media-pp",
  visualizer: "#media-visualizer",
  art: "#media-art",
  artFrame: "#media-art-frame",
  shader: "#media-shader-visualizer",
};

let mediaArtFadeTimer = 0;
let mediaEventsBound = false;

function mediaNode(name) {
  return document.querySelector(mediaSelectors[name]);
}

function formatTime(s) {
  const seconds = Number.isFinite(s) ? Math.max(0, s) : 0;
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function normalizeMediaPayload(payload) {
  const parts = payload.split("||");
  if (parts.length >= 11) {
    const [source, artist, title, art, playState, pos, dur, album] = parts;
    return { source, artist, title, art, playState, pos, dur, album };
  }
  const [artist, title, art, playState, pos, dur] = parts;
  return { source: "Media", artist, title, art, playState, pos, dur, album: "" };
}

function mediaTransportIcon(isPlaying) {
  return svgEl("svg", {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true",
  }, [
    isPlaying
      ? svgEl("path", { d: "M8 5.5h3v13H8zM13 5.5h3v13h-3z" })
      : svgEl("path", { d: "M8 5.6v12.8L18 12z" }),
  ]);
}

function setMediaText(name, value = "") {
  const node = mediaNode(name);
  if (!node) return;
  // The sidebar deck now wraps metadata visibly, but title attributes preserve
  // full text for hover/assistive inspection when the sidebar is narrow.
  node.textContent = value;
  node.title = value;
}

function setMediaWidgetVisible(visible) {
  if (visible) ui.show(mediaSelectors.widget, "flex");
  else ui.hide(mediaSelectors.widget);
}

function updateProgress(percent, current, total) {
  const fill = mediaNode("progressFill");
  if (fill) fill.style.width = `${percent}%`;
  ui.set(mediaSelectors.currentTime, formatTime(current));
  ui.set(mediaSelectors.totalTime, formatTime(total));
}

function updateAlbumArt(art) {
  const artImg = mediaNode("art");
  if (!artImg) return;
  const newSrc = art && art !== "NONE" ? art : FALLBACK_ART;
  if (artImg.src === newSrc) return;

  if (mediaArtFadeTimer) clearTimeout(mediaArtFadeTimer);
  artImg.style.opacity = "0";
  mediaArtFadeTimer = setTimeout(() => {
    artImg.src = newSrc;
    artImg.style.opacity = "1";
    mediaArtFadeTimer = 0;
  }, 180);
}

const shaderState = {
  gl: null,
  program: null,
  buffer: null,
  raf: 0,
  startedAt: 0,
  seed: 0.35,
  progress: 0,
  isPlaying: false,
};

function hashTrackSeed(artist = "", title = "") {
  const text = `${artist}:${title}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initShaderVisualizer(canvas) {
  if (shaderState.gl || !canvas) return shaderState.gl;
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, powerPreference: "low-power" });
  if (!gl) return null;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_seed;
    uniform float u_progress;
    uniform float u_energy;

    mat2 rot(float a) {
      float s = sin(a);
      float c = cos(a);
      return mat2(c, -s, s, c);
    }

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
      vec2 p = uv * rot(u_seed * 6.2831 + u_time * 0.045);
      float r = length(p);
      float a = atan(p.y, p.x);
      float pulse = 0.50 + 0.50 * sin(u_time * 2.1 + u_progress * 10.0);
      float grit = noise(p * 42.0 + u_time * 0.18);
      float smoke = noise(p * 4.6 + vec2(u_time * 0.08, -u_time * 0.05));
      vec2 warped = p;
      warped += 0.18 * vec2(
        sin(p.y * 7.0 + u_time * 0.95 + smoke * 2.0),
        cos(p.x * 6.0 - u_time * 0.72 + grit * 1.4)
      );
      warped *= rot(smoke * 1.9 + u_time * 0.035);

      float wr = length(warped);
      float wa = atan(warped.y, warped.x);
      float rings = sin(21.0 * wr - u_time * (1.6 + u_energy * 0.65) + u_seed * 9.0);
      float spiral = sin(wa * 7.0 + wr * 13.0 - u_time * 1.22 + smoke * 4.0);
      float vein = sin((warped.x * warped.y) * 18.0 + wr * 8.0 - u_time * 0.8);
      float field = rings * 0.72 + spiral * 0.9 + vein * 0.45 + (grit - 0.5) * 0.7;

      float edge = smoothstep(0.28, 0.96, sin(field) * 0.5 + 0.5);
      float ember = smoothstep(0.68, 1.0, sin(field * 1.8 + u_time * 0.65) * 0.5 + 0.5);
      float acid = smoothstep(0.78, 1.0, sin(wa * 11.0 - wr * 12.0 + u_time * 1.7) * 0.5 + 0.5);
      vec3 base = vec3(0.015, 0.012, 0.018);
      vec3 bruise = vec3(0.18, 0.025, 0.18);
      vec3 oil = vec3(0.02, 0.20, 0.18);
      vec3 rust = vec3(0.72, 0.13, 0.035);
      vec3 venom = vec3(0.58, 0.95, 0.22);
      vec3 color = mix(base, bruise, smoke * 0.9);
      color = mix(color, oil, edge * (0.38 + pulse * 0.18));
      color += rust * ember * (0.28 + u_energy * 0.18);
      color += venom * acid * (0.12 + pulse * 0.16);

      float vignette = smoothstep(1.34, 0.12, r);
      float tunnel = smoothstep(0.085, 0.0, abs(sin(wa * 4.0 + u_time * 0.7) * wr));
      float scanline = 0.92 + 0.08 * sin(gl_FragCoord.y * 1.8 + u_time * 11.0);
      color *= vignette * scanline;
      color += tunnel * vec3(0.08, 0.32, 0.24) * (0.6 + pulse * 0.4);
      color -= grit * 0.055;
      color = max(color, vec3(0.0));
      gl_FragColor = vec4(color, 1.0);
    }
  `);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  shaderState.gl = gl;
  shaderState.program = program;
  shaderState.buffer = buffer;
  shaderState.startedAt = performance.now();
  return gl;
}

function renderShaderVisualizer() {
  const canvas = mediaNode("shader");
  const gl = shaderState.gl || initShaderVisualizer(canvas);
  if (!canvas || !gl) return;

  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  gl.viewport(0, 0, width, height);
  gl.useProgram(shaderState.program);
  const position = gl.getAttribLocation(shaderState.program, "a_position");
  gl.bindBuffer(gl.ARRAY_BUFFER, shaderState.buffer);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(gl.getUniformLocation(shaderState.program, "u_resolution"), width, height);
  gl.uniform1f(gl.getUniformLocation(shaderState.program, "u_time"), (performance.now() - shaderState.startedAt) / 1000);
  gl.uniform1f(gl.getUniformLocation(shaderState.program, "u_seed"), shaderState.seed);
  gl.uniform1f(gl.getUniformLocation(shaderState.program, "u_progress"), shaderState.progress);
  gl.uniform1f(gl.getUniformLocation(shaderState.program, "u_energy"), shaderState.isPlaying ? 1 : 0.18);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (shaderState.isPlaying) {
    shaderState.raf = requestAnimationFrame(renderShaderVisualizer);
  } else {
    shaderState.raf = 0;
  }
}

function requestMediaVisualizerFullscreen() {
  const frame = mediaNode("artFrame");
  if (!frame) return;
  const requestFullscreen = frame.requestFullscreen || frame.webkitRequestFullscreen;
  if (!requestFullscreen || document.fullscreenElement === frame || document.webkitFullscreenElement === frame) return;
  requestFullscreen.call(frame);
}

function syncShaderVisualizer({ artist, title, isPlaying, percent }) {
  const artFrame = mediaNode("artFrame");
  const canvas = mediaNode("shader");
  const enabled = state.config?.display?.media_shader_visualizer === true;
  const active = enabled && Boolean(canvas);
  if (artFrame) {
    artFrame.classList.toggle("shader-mode", active);
    artFrame.classList.toggle("is-playing", isPlaying);
  }
  shaderState.seed = hashTrackSeed(artist, title);
  shaderState.progress = Math.max(0, Math.min(1, percent / 100));
  shaderState.isPlaying = active && isPlaying;
  if (active && !shaderState.raf) {
    shaderState.raf = requestAnimationFrame(renderShaderVisualizer);
  }
  if (!active && shaderState.raf) {
    cancelAnimationFrame(shaderState.raf);
    shaderState.raf = 0;
  }
}

export async function updateMediaWidget() {
  try {
    const payload = await invoke("get_media_status");
    if (!payload) {
      setMediaWidgetVisible(false);
      return;
    }
    const media = normalizeMediaPayload(payload);
    if (!media.artist || !media.title || !media.playState) {
      setMediaWidgetVisible(false);
      return;
    }
    
    const { source, artist, title, art, playState, pos, dur, album } = media;
    const isPlaying = playState?.trim() === "playing";
    const current = parseFloat(pos);
    const total = parseFloat(dur);
    const percent = Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.min(100, Math.max(0, (current / total) * 100))
      : 0;

    state.mediaStatus = `${artist} - ${title}`;
    state.mediaDetails = { source, artist, title, album, current, total, isPlaying };
    setMediaText("title", title);
    setMediaText("artist", artist);
    setMediaText("album", album || "");

    updateProgress(percent, current, total);

    const ppBtn = mediaNode("playPause");
    if (ppBtn) {
      // Static icons are still built as SVG nodes so the media surface does
      // not normalize string markup as an update primitive.
      ppBtn.replaceChildren(mediaTransportIcon(isPlaying));
    }

    const viz = mediaNode("visualizer");
    if (viz) viz.classList.toggle("active", isPlaying);
    syncShaderVisualizer({ artist, title, isPlaying, percent });

    updateAlbumArt(art);

    setMediaWidgetVisible(true);
  } catch (e) {
    syncShaderVisualizer({ artist: "", title: "", isPlaying: false, percent: 0 });
    setMediaWidgetVisible(false);
  }
}

export async function shareMedia() {
  if (!state.mediaStatus) return;
  const details = state.mediaDetails;
  const albumText = details?.album ? ` (${details.album})` : "";
  const timeText = details?.total ? ` [${formatTime(details.current)} / ${formatTime(details.total)}]` : "";
  const msg = `Now Playing: ${state.mediaStatus}${albumText}${timeText}`;
  appendMessage({ username: 'Me', content: msg, timestamp: formatTimestamp(new Date()), channel: state.activeChannel, server_id: state.activeServer });
  await invoke("send_irc_message", { serverId: state.activeServer, channel: state.activeChannel, content: msg });
}

export async function mediaControl(action) {
  try {
    await invoke("media_control", { command: action });
    setTimeout(updateMediaWidget, 500);
  } catch (e) {}
}

export function seekMediaFromEvent(event) {
  const details = state.mediaDetails;
  if (!details?.total) return;
  const bar = event.currentTarget;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  mediaControl(`seek:${Math.round(details.total * ratio)}`);
}

function setupMediaWidgetEvents() {
  if (mediaEventsBound) return;
  mediaEventsBound = true;

  // Media owns its own delegated handlers. Keeping them here avoids duplicate
  // transport calls from shell-level button binding in main.js.
  document.body?.addEventListener('click', (e) => {
    if (e.target.closest(mediaSelectors.artFrame)) {
      requestMediaVisualizerFullscreen();
      return;
    }

    const btn = e.target.closest(`${mediaSelectors.widget} .tactical-btn`);
    if (!btn) return;

    if (btn.id === 'btn-media-share') shareMedia();
    if (btn.id === 'btn-media-prev') mediaControl('prev');
    if (btn.id === 'btn-media-pp') mediaControl('playpause');
    if (btn.id === 'btn-media-next') mediaControl('next');
  });

  mediaNode("progressBar")?.addEventListener('click', seekMediaFromEvent);
  window?.addEventListener?.("refresh-media-widget", () => updateMediaWidget());
  document.addEventListener?.("fullscreenchange", () => requestAnimationFrame(renderShaderVisualizer));
  document.addEventListener?.("webkitfullscreenchange", () => requestAnimationFrame(renderShaderVisualizer));
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  setupMediaWidgetEvents();
}

// The visualizer is deliberately decorative and lightweight: deterministic
// enough to feel designed, but only animated while playback is active.
setInterval(() => {
  const viz = document.querySelector("#media-visualizer.active");
  if (!viz) return;
  viz.querySelectorAll(".viz-bar").forEach((bar, index) => {
    const phase = Date.now() / 170 + index * 0.85;
    const height = 4 + Math.round((Math.sin(phase) + 1) * 6 + ((index % 3) * 2));
    bar.style.height = `${height}px`;
  });
}, 140);
