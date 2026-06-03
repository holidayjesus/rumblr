let _invoke, _listen, _emit, _getCurrentWindow;

export const initTauri = () => {
  console.log("[SYSTEM] initTauri: Checking for __TAURI__...");
  if (window.__TAURI__) {
    console.log("[SYSTEM] __TAURI__ found. Mapping primitives...");
    _invoke = window.__TAURI__.core?.invoke || window.__TAURI__.invoke;
    _listen = window.__TAURI__.event?.listen || window.__TAURI__.listen;
    // Frontend windows use emit/listen for lightweight state handoffs, such as
    // asking the main chat window to hydrate the standalone Messages window.
    _emit = window.__TAURI__.event?.emit || window.__TAURI__.emit;
    _getCurrentWindow = window.__TAURI__.window?.getCurrentWindow || window.__TAURI__.getCurrentWindow;
    return true;
  }
  
  console.warn("[SYSTEM] __TAURI__ not found. Running in stub mode.");
  _invoke = async (cmd) => { console.log(`[STUB] invoke: ${cmd}`); return {}; };
  _listen = async (evt) => { console.log(`[STUB] listen: ${evt}`); return () => { }; };
  _emit = async (evt, payload) => { console.log(`[STUB] emit: ${evt}`, payload); return {}; };
  _getCurrentWindow = () => ({
    close: () => console.log("[STUB] window.close"),
    minimize: () => console.log("[STUB] window.minimize"),
    isMaximized: () => Promise.resolve(false),
    maximize: () => console.log("[STUB] window.maximize"),
    unmaximize: () => console.log("[STUB] window.unmaximize"),
    toggleMaximize: async function () {
      console.log("[STUB] window.toggleMaximize");
      if (await this.isMaximized()) this.unmaximize();
      else this.maximize();
    }
  });
  return false;
};

// Initialize defensively
try {
  initTauri();
} catch (e) {
  console.error("[SYSTEM] initTauri failed:", e);
}

export const invoke = (...args) => _invoke ? _invoke(...args) : Promise.resolve({});
export const listen = (...args) => _listen ? _listen(...args) : Promise.resolve(() => {});
export const emit = (...args) => _emit ? _emit(...args) : Promise.resolve({});
export const getCurrentWindow = () => _getCurrentWindow ? _getCurrentWindow() : { close: () => {}, minimize: () => {}, maximize: () => {} };
