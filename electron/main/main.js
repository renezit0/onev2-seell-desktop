const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CHANNELS, validateConfigSet } = require('../shared/ipc');

let mainWindow;
let autoUpdateTimer = null;
let hasDownloadedUpdate = false;

if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

const DEFAULT_CONFIG = {
  theme: 'system'
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  const file = getConfigPath();
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...(parsed || {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(nextConfig) {
  const file = getConfigPath();
  const finalConfig = { ...DEFAULT_CONFIG, ...(nextConfig || {}) };
  fs.writeFileSync(file, JSON.stringify(finalConfig, null, 2), 'utf-8');
  return finalConfig;
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function getRendererEntry() {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  if (process.env.ONEV2_APP_URL) {
    return process.env.ONEV2_APP_URL;
  }
  if (app.isPackaged) {
    return 'https://onev2.seellbr.com';
  }
  return path.join(__dirname, '../../renderer/dist/index.html');
}

function installMacUnifiedTitlebar(windowRef) {
  if (process.platform !== 'darwin') return;

  const script = `
(() => {
  if (window.__desktopUnifiedTitlebarInstalled) return;
  window.__desktopUnifiedTitlebarInstalled = true;

  const STRIP_HEIGHT = 30;
  const SIDEBAR_SELECTORS = [
    '[data-app-sidebar]',
    '.app-sidebar',
    '.sidebar',
    'aside[class*="sidebar"]',
    'nav[class*="sidebar"]'
  ];
  const HEADER_SELECTORS = [
    '[data-app-header]',
    '.app-header',
    '.topbar',
    '.header',
    'header[class*="header"]',
    'header'
  ];

  const toRgba = (value) => {
    if (!value) return '';
    const color = String(value).trim().toLowerCase();
    if (
      !color ||
      color === 'transparent' ||
      color === 'rgba(0, 0, 0, 0)' ||
      color === 'initial' ||
      color === 'inherit'
    ) {
      return '';
    }
    return value;
  };

  const getBackground = (el, fallback) => {
    if (!el) return fallback;
    const computed = window.getComputedStyle(el);
    return (
      toRgba(computed.backgroundColor) ||
      toRgba(el.style.backgroundColor) ||
      fallback
    );
  };

  const findFirstVisible = (selectors, minHeight = 30) => {
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height >= minHeight) {
          return el;
        }
      }
    }
    return null;
  };

  const findSidebar = () => {
    const sidebar = findFirstVisible(SIDEBAR_SELECTORS, 40);
    if (!sidebar) return null;
    const rect = sidebar.getBoundingClientRect();
    if (rect.left > 60) return null;
    return sidebar;
  };

  const strip = document.createElement('div');
  strip.id = 'desktop-unified-titlebar';
  strip.style.position = 'fixed';
  strip.style.left = '0';
  strip.style.right = '0';
  strip.style.top = '0';
  strip.style.height = STRIP_HEIGHT + 'px';
  strip.style.zIndex = '2147483647';
  strip.style.pointerEvents = 'none';
  strip.style.WebkitAppRegion = 'drag';
  strip.style.display = 'block';
  strip.style.border = '0';
  strip.style.boxShadow = 'none';
  document.documentElement.appendChild(strip);

  const seamCover = document.createElement('div');
  seamCover.style.position = 'absolute';
  seamCover.style.top = '0';
  seamCover.style.height = '100%';
  seamCover.style.width = '1px';
  seamCover.style.left = '0px';
  seamCover.style.pointerEvents = 'none';
  seamCover.style.background = '#1f232a';
  strip.appendChild(seamCover);

  const seamTail = document.createElement('div');
  seamTail.style.position = 'absolute';
  seamTail.style.top = STRIP_HEIGHT + 'px';
  seamTail.style.height = '84px';
  seamTail.style.width = '2px';
  seamTail.style.left = '0px';
  seamTail.style.pointerEvents = 'none';
  seamTail.style.background = '#1f232a';
  strip.appendChild(seamTail);

  const applyColorsAndWidths = () => {
    const header = document.querySelector('[data-app-header]') || findFirstVisible(HEADER_SELECTORS, 38);
    const sidebar = document.querySelector('[data-app-sidebar]') || findSidebar();
    const headerColor = getBackground(header, '#f3f4f6');
    const sidebarColor = getBackground(sidebar, '#1f232a');
    const sidebarWidth = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().width)) : 0;
    const splitX = Math.max(0, sidebarWidth - 1);
    strip.style.background = 'linear-gradient(to right, ' +
      sidebarColor + ' 0px, ' +
      sidebarColor + ' ' + splitX + 'px, ' +
      headerColor + ' ' + splitX + 'px, ' +
      headerColor + ' 100%)';
    seamCover.style.left = splitX + 'px';
    seamCover.style.background = sidebarColor;
    seamTail.style.left = Math.max(0, splitX - 1) + 'px';
    seamTail.style.background = sidebarColor;

    if (header) {
      if (!header.dataset.desktopTitlebarBaseTop) {
        const topPx = Number.parseFloat(window.getComputedStyle(header).top || '0') || 0;
        header.dataset.desktopTitlebarBaseTop = String(topPx);
      }
      const baseTop = Number.parseFloat(header.dataset.desktopTitlebarBaseTop || '0') || 0;
      header.style.setProperty('top', (baseTop + STRIP_HEIGHT) + 'px', 'important');
    }

    if (sidebar) {
      if (!sidebar.dataset.desktopTitlebarBaseTop) {
        const topPx = Number.parseFloat(window.getComputedStyle(sidebar).top || '0') || 0;
        sidebar.dataset.desktopTitlebarBaseTop = String(topPx);
      }
      const baseTop = Number.parseFloat(sidebar.dataset.desktopTitlebarBaseTop || '0') || 0;
      sidebar.style.setProperty('top', (baseTop + STRIP_HEIGHT) + 'px', 'important');
      sidebar.style.setProperty('height', 'calc(100vh - ' + (baseTop + STRIP_HEIGHT) + 'px)', 'important');
    }

    if (header && header.nextElementSibling instanceof HTMLElement) {
      const contentEl = header.nextElementSibling;
      if (!contentEl.dataset.desktopTitlebarBasePaddingTop) {
        const paddingTop = Number.parseFloat(window.getComputedStyle(contentEl).paddingTop || '0') || 0;
        contentEl.dataset.desktopTitlebarBasePaddingTop = String(paddingTop);
      }
      const basePaddingTop = Number.parseFloat(contentEl.dataset.desktopTitlebarBasePaddingTop || '0') || 0;
      contentEl.style.setProperty('padding-top', (basePaddingTop + STRIP_HEIGHT) + 'px', 'important');
      contentEl.style.setProperty('min-height', 'calc(100vh - 64px - ' + STRIP_HEIGHT + 'px)', 'important');
    }
  };

  let raf = null;
  const scheduleRefresh = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = null;
      applyColorsAndWidths();
    });
  };

  const refresh = () => {
    scheduleRefresh();
  };

  refresh();
  window.addEventListener('resize', refresh, { passive: true });

  const ro = new ResizeObserver(refresh);
  const mo = new MutationObserver(() => refresh());

  const observeCandidates = () => {
    const header = findFirstVisible(HEADER_SELECTORS, 20);
    const sidebar = findSidebar();
    if (header) ro.observe(header);
    if (sidebar) ro.observe(sidebar);
  };

  observeCandidates();
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  });
  document.addEventListener('transitionrun', refresh, true);
  document.addEventListener('transitionend', refresh, true);
  document.addEventListener('animationstart', refresh, true);
  document.addEventListener('animationend', refresh, true);
  refresh();
})();
`;

  const inject = () => {
    if (windowRef.isDestroyed()) return;
    windowRef.webContents.executeJavaScript(script).catch(() => {});
  };

  windowRef.webContents.on('dom-ready', inject);
  windowRef.webContents.on('did-finish-load', inject);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 7, y: 8 } } : {}),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 3000);

  mainWindow.on('maximize', () => {
    sendToRenderer(CHANNELS.WINDOW_STATE, { isMaximized: true });
  });

  mainWindow.on('unmaximize', () => {
    sendToRenderer(CHANNELS.WINDOW_STATE, { isMaximized: false });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const entry = getRendererEntry();
    if (!entry.startsWith('http')) return;
    const allowedOrigin = new URL(entry).origin;
    if (!String(url || '').startsWith(allowedOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const html = `
      <html><body style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Falha ao carregar interface</h2>
      <p><b>Código:</b> ${String(errorCode)}</p>
      <p><b>Erro:</b> ${String(errorDescription || 'desconhecido')}</p>
      <p><b>URL:</b> ${String(validatedURL || '')}</p>
      </body></html>
    `;
    mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const html = `
      <html><body style="font-family: Arial, sans-serif; padding: 20px;">
      <h2>Render process finalizado</h2>
      <p><b>Motivo:</b> ${String(details?.reason || 'unknown')}</p>
      <p><b>Exit code:</b> ${String(details?.exitCode ?? '')}</p>
      </body></html>
    `;
    mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  });

  const entry = getRendererEntry();
  if (entry.startsWith('http')) {
    mainWindow.loadURL(entry);
  } else {
    mainWindow.loadFile(entry);
  }

  installMacUnifiedTitlebar(mainWindow);
}

function registerIpc() {
  ipcMain.handle(CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow?.minimize();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_MAXIMIZE, () => {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, isMaximized: mainWindow.isMaximized() };
  });

  ipcMain.handle(CHANNELS.WINDOW_CLOSE, () => {
    mainWindow?.close();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.WINDOW_IS_MAXIMIZED, () => {
    return { isMaximized: !!mainWindow?.isMaximized() };
  });

  ipcMain.handle(CHANNELS.APP_GET_VERSION, () => {
    return { version: app.getVersion() };
  });

  ipcMain.handle(CHANNELS.APP_CHECK_UPDATES, async () => {
    if (!app.isPackaged) {
      return { ok: false, skipped: true, reason: 'not-packaged' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, updateInfo: result?.updateInfo || null };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle(CHANNELS.APP_INSTALL_UPDATE, () => {
    if (!app.isPackaged) {
      return { ok: false, skipped: true, reason: 'not-packaged' };
    }
    if (!hasDownloadedUpdate) {
      return { ok: false, skipped: true, reason: 'update-not-downloaded' };
    }
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.CONFIG_GET, () => {
    return readConfig();
  });

  ipcMain.handle(CHANNELS.CONFIG_SET, (_event, payload) => {
    if (!validateConfigSet(payload)) {
      return { ok: false, error: 'invalid-payload' };
    }
    const current = readConfig();
    const next = { ...current, [payload.key]: payload.value };
    const saved = writeConfig(next);
    return { ok: true, config: saved };
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'checking',
      message: 'Verificando atualizações...'
    });
  });

  autoUpdater.on('update-available', (info) => {
    hasDownloadedUpdate = false;
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'available',
      message: 'Atualização disponível. Download iniciado.',
      info
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    hasDownloadedUpdate = false;
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'not-available',
      message: 'Aplicativo já está atualizado.',
      info
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'downloading',
      message: `Baixando atualização: ${Math.round(progress.percent || 0)}%`,
      progress
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    hasDownloadedUpdate = true;
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'downloaded',
      message: 'Atualização pronta. Reinicie o app ou instale agora.',
      info
    });
  });

  autoUpdater.on('error', (error) => {
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'error',
      message: String(error?.message || error)
    });
  });

  if (!app.isPackaged) {
    sendToRenderer(CHANNELS.UPDATE_STATUS, {
      state: 'idle',
      message: 'Auto-update desabilitado em modo desenvolvimento.'
    });
    return;
  }

  autoUpdater.checkForUpdates().catch(() => {});

  autoUpdateTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  registerIpc();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
});
