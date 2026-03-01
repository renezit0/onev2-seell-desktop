const { contextBridge, ipcRenderer } = require('electron');
// Em preload sandboxed no Windows, require de módulos locais pode falhar.
// Mantemos os canais inline para garantir que window.desktop sempre suba.
const CHANNELS = Object.freeze({
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  APP_GET_VERSION: 'app:get-version',
  APP_CHECK_UPDATES: 'app:check-updates',
  APP_INSTALL_UPDATE: 'app:install-update',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  UPDATE_STATUS: 'update:status',
  WINDOW_STATE: 'window:state'
});

/**
 * @typedef {{
 *   minimize: () => Promise<{ok: boolean}>,
 *   toggleMaximize: () => Promise<{ok: boolean, isMaximized?: boolean}>,
 *   close: () => Promise<{ok: boolean}>,
 *   isMaximized: () => Promise<{isMaximized: boolean}>,
 *   getVersion: () => Promise<{version: string}>,
 *   checkForUpdates: () => Promise<{ok: boolean, skipped?: boolean, reason?: string, error?: string, updateInfo?: unknown}>,
 *   installUpdate: () => Promise<{ok: boolean, skipped?: boolean, reason?: string, error?: string}>,
 *   getConfig: () => Promise<Record<string, unknown>>,
 *   setConfig: (key: string, value: unknown) => Promise<{ok: boolean, error?: string, config?: Record<string, unknown>}>,
 *   onUpdateStatus: (listener: (payload: any) => void) => () => void,
 *   onWindowState: (listener: (payload: {isMaximized: boolean}) => void) => () => void,
 *   platform: string
 * }} DesktopAPI
 */

/** @type {DesktopAPI} */
const desktop = {
  minimize: () => ipcRenderer.invoke(CHANNELS.WINDOW_MINIMIZE),
  toggleMaximize: () => ipcRenderer.invoke(CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
  close: () => ipcRenderer.invoke(CHANNELS.WINDOW_CLOSE),
  isMaximized: () => ipcRenderer.invoke(CHANNELS.WINDOW_IS_MAXIMIZED),
  getVersion: () => ipcRenderer.invoke(CHANNELS.APP_GET_VERSION),
  checkForUpdates: () => ipcRenderer.invoke(CHANNELS.APP_CHECK_UPDATES),
  installUpdate: () => ipcRenderer.invoke(CHANNELS.APP_INSTALL_UPDATE),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  setConfig: (key, value) => ipcRenderer.invoke(CHANNELS.CONFIG_SET, { key, value }),
  onUpdateStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(CHANNELS.UPDATE_STATUS, handler);
    return () => ipcRenderer.removeListener(CHANNELS.UPDATE_STATUS, handler);
  },
  onWindowState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(CHANNELS.WINDOW_STATE, handler);
    return () => ipcRenderer.removeListener(CHANNELS.WINDOW_STATE, handler);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('desktop', desktop);
