const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CHANNELS, validateConfigSet } = require('../shared/ipc');

let mainWindow;
let autoUpdateTimer = null;
let hasDownloadedUpdate = false;
let rendererServer = null;
let rendererServerUrl = null;

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

function getRendererDistPath() {
  return path.join(__dirname, '../../renderer/dist');
}

function resolveStaticFilePath(rootDir, requestPath) {
  const safeRelative = requestPath.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootDir, safeRelative);
  const normalizedRoot = `${path.resolve(rootDir)}${path.sep}`;
  if (absolutePath !== path.resolve(rootDir) && !absolutePath.startsWith(normalizedRoot)) {
    return null;
  }
  return absolutePath;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const byExt = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8'
  };
  return byExt[ext] || 'application/octet-stream';
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

async function ensureRendererServer() {
  if (rendererServer && rendererServerUrl) return rendererServerUrl;

  const rootDir = getRendererDistPath();
  if (!fs.existsSync(path.join(rootDir, 'index.html'))) {
    throw new Error(`renderer/dist/index.html não encontrado em: ${rootDir}`);
  }

  rendererServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(reqUrl.pathname || '/');
    if (pathname === '/') pathname = '/index.html';

    let targetPath = resolveStaticFilePath(rootDir, pathname);
    if (!targetPath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
      if (stat && stat.isDirectory()) {
        targetPath = path.join(targetPath, 'index.html');
      }
    } catch {
      // fallback SPA abaixo
    }

    let body = readFileOrNull(targetPath);
    if (!body) {
      body = readFileOrNull(path.join(rootDir, 'index.html'));
      targetPath = path.join(rootDir, 'index.html');
      if (!body) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html não encontrado');
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': getContentType(targetPath),
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    rendererServer.once('error', reject);
    rendererServer.listen(0, '127.0.0.1', () => {
      const address = rendererServer.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (!port) {
        reject(new Error('Falha ao descobrir porta do servidor local do renderer.'));
        return;
      }
      rendererServerUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  return rendererServerUrl;
}

async function resolveRendererEntry() {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  // Override opcional para apontar para URL remota (apenas quando necessário).
  if (process.env.ONEV2_APP_URL) return process.env.ONEV2_APP_URL;
  return ensureRendererServer();
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

function installWindowsCustomTitlebar(windowRef) {
  if (process.platform !== 'win32') return;

  const script = `
(() => {
  if (window.__desktopWindowsTitlebarInstalled) return;
  window.__desktopWindowsTitlebarInstalled = true;

  const BAR_HEIGHT = 44;
  const SIDEBAR_SELECTORS = ['[data-app-sidebar]', '.app-sidebar', '.sidebar'];
  const HEADER_SELECTORS = ['[data-app-header]', '.app-header', '.header', 'header'];

  const getFirstVisible = (selectors, minHeight = 30) => {
    for (const selector of selectors) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height >= minHeight) return el;
      }
    }
    return null;
  };

  const getColor = (el, fallback) => {
    if (!el) return fallback;
    const c = window.getComputedStyle(el).backgroundColor;
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return fallback;
    return c;
  };

  const style = document.createElement('style');
  style.id = 'desktop-win-titlebar-style';
  style.textContent = \`
    #desktop-win-titlebar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${BAR_HEIGHT}px;
      z-index: 2147483646;
      display: flex;
      align-items: stretch;
      user-select: none;
      -webkit-user-select: none;
    }
    #desktop-win-titlebar .bar-drag {
      flex: 1;
      display: flex;
      align-items: center;
      padding: 0 14px;
      gap: 10px;
      -webkit-app-region: drag;
      font: 600 13px/1.2 "Segoe UI", sans-serif;
      color: rgba(17, 24, 39, 0.88);
      letter-spacing: 0.2px;
      backdrop-filter: saturate(1.15) blur(8px);
    }
    #desktop-win-titlebar .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #2563eb;
      box-shadow: 0 0 0 5px rgba(37, 99, 235, 0.15);
      flex: 0 0 auto;
    }
    #desktop-win-titlebar .brand-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 340px;
    }
    #desktop-win-titlebar .window-controls {
      display: flex;
      align-items: center;
      -webkit-app-region: no-drag;
      margin-left: auto;
      border-left: 1px solid rgba(100, 116, 139, 0.12);
    }
    #desktop-win-titlebar .window-btn {
      width: 48px;
      height: ${BAR_HEIGHT}px;
      border: 0;
      background: transparent;
      color: #334155;
      cursor: pointer;
      display: grid;
      place-items: center;
      font-size: 13px;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    #desktop-win-titlebar .window-btn:hover {
      background: rgba(15, 23, 42, 0.08);
      color: #111827;
    }
    #desktop-win-titlebar .window-btn.close:hover {
      background: #e11d48;
      color: #fff;
    }
    #desktop-win-titlebar .window-btn svg {
      width: 11px;
      height: 11px;
      display: block;
    }
  \`;
  document.documentElement.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'desktop-win-titlebar';
  bar.innerHTML = \`
    <div class="bar-drag">
      <span class="brand-dot" aria-hidden="true"></span>
      <span class="brand-text">oneV2 seeLL Desktop</span>
    </div>
    <div class="window-controls">
      <button class="window-btn min" title="Minimizar" aria-label="Minimizar">
        <svg viewBox="0 0 10 10" fill="none"><path d="M1 5.5h8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="window-btn max" title="Maximizar" aria-label="Maximizar">
        <svg viewBox="0 0 10 10" fill="none"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1.1"/></svg>
      </button>
      <button class="window-btn close" title="Fechar" aria-label="Fechar">
        <svg viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  \`;
  document.documentElement.appendChild(bar);

  const minBtn = bar.querySelector('.window-btn.min');
  const maxBtn = bar.querySelector('.window-btn.max');
  const closeBtn = bar.querySelector('.window-btn.close');
  const dragArea = bar.querySelector('.bar-drag');

  const safeCall = async (fn) => {
    try { return await fn(); } catch { return null; }
  };

  minBtn?.addEventListener('click', () => safeCall(() => window.desktop?.minimize?.()));
  closeBtn?.addEventListener('click', () => safeCall(() => window.desktop?.close?.()));
  maxBtn?.addEventListener('click', () => safeCall(() => window.desktop?.toggleMaximize?.()));
  dragArea?.addEventListener('dblclick', () => safeCall(() => window.desktop?.toggleMaximize?.()));

  const setMaximizedVisual = (isMaximized) => {
    if (!maxBtn) return;
    maxBtn.innerHTML = isMaximized
      ? '<svg viewBox="0 0 10 10" fill="none"><rect x="1.5" y="2.5" width="6" height="6" stroke="currentColor" stroke-width="1.1"/><path d="M3.5 1.5h5v5" stroke="currentColor" stroke-width="1.1"/></svg>'
      : '<svg viewBox="0 0 10 10" fill="none"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1.1"/></svg>';
  };

  if (window.desktop?.onWindowState) {
    window.desktop.onWindowState((payload) => setMaximizedVisual(!!payload?.isMaximized));
  }
  safeCall(() => window.desktop?.isMaximized?.()).then((res) => setMaximizedVisual(!!res?.isMaximized));

  const syncLayout = () => {
    const header = getFirstVisible(HEADER_SELECTORS, 24);
    const sidebar = getFirstVisible(SIDEBAR_SELECTORS, 40);
    const sidebarColor = getColor(sidebar, '#1f232a');
    const headerColor = getColor(header, '#f8fafc');
    const sidebarWidth = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().width)) : 0;
    bar.style.background = \`linear-gradient(to right, \${sidebarColor} 0px, \${sidebarColor} \${sidebarWidth}px, \${headerColor} \${sidebarWidth}px, \${headerColor} 100%)\`;

    if (header) {
      if (!header.dataset.desktopWinBaseTop) {
        header.dataset.desktopWinBaseTop = String(Number.parseFloat(window.getComputedStyle(header).top || '0') || 0);
      }
      const baseTop = Number.parseFloat(header.dataset.desktopWinBaseTop || '0') || 0;
      header.style.setProperty('top', (baseTop + BAR_HEIGHT) + 'px', 'important');
    }

    if (sidebar) {
      if (!sidebar.dataset.desktopWinBaseTop) {
        sidebar.dataset.desktopWinBaseTop = String(Number.parseFloat(window.getComputedStyle(sidebar).top || '0') || 0);
      }
      const baseTop = Number.parseFloat(sidebar.dataset.desktopWinBaseTop || '0') || 0;
      sidebar.style.setProperty('top', (baseTop + BAR_HEIGHT) + 'px', 'important');
      sidebar.style.setProperty('height', \`calc(100vh - \${baseTop + BAR_HEIGHT}px)\`, 'important');
    }

    if (header && header.nextElementSibling instanceof HTMLElement) {
      const content = header.nextElementSibling;
      if (!content.dataset.desktopWinBasePaddingTop) {
        content.dataset.desktopWinBasePaddingTop = String(Number.parseFloat(window.getComputedStyle(content).paddingTop || '0') || 0);
      }
      const basePad = Number.parseFloat(content.dataset.desktopWinBasePaddingTop || '0') || 0;
      content.style.setProperty('padding-top', (basePad + BAR_HEIGHT) + 'px', 'important');
    }
  };

  let raf = null;
  const refresh = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      syncLayout();
    });
  };

  refresh();
  window.addEventListener('resize', refresh, { passive: true });
  document.addEventListener('transitionrun', refresh, true);
  document.addEventListener('transitionend', refresh, true);
  const mo = new MutationObserver(refresh);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
})();
`;

  const inject = () => {
    if (windowRef.isDestroyed()) return;
    windowRef.webContents.executeJavaScript(script).catch(() => {});
  };

  windowRef.webContents.on('dom-ready', inject);
  windowRef.webContents.on('did-finish-load', inject);
}

function installElectronUpdateUiBridge(windowRef) {
  const script = `
(() => {
  if (window.__desktopUpdateUiBridgeInstalled) return;
  window.__desktopUpdateUiBridgeInstalled = true;
  if (!window.desktop) return;

  let lastUpdateState = 'idle';
  let lastUpdateMessage = 'Pronto';

  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .replace(/\\s+/g, ' ')
      .trim();

  const showBubble = (message, type = 'info') => {
    const bubble = document.createElement('div');
    bubble.style.position = 'fixed';
    bubble.style.right = '16px';
    bubble.style.bottom = '16px';
    bubble.style.zIndex = '2147483647';
    bubble.style.padding = '10px 12px';
    bubble.style.borderRadius = '10px';
    bubble.style.font = '600 12px/1.35 "Segoe UI", sans-serif';
    bubble.style.color = '#fff';
    bubble.style.maxWidth = '340px';
    bubble.style.boxShadow = '0 10px 24px rgba(0,0,0,0.25)';
    bubble.style.background =
      type === 'error' ? '#b91c1c' :
      type === 'success' ? '#047857' :
      type === 'warn' ? '#b45309' : '#1d4ed8';
    bubble.textContent = message;
    document.body.appendChild(bubble);
    setTimeout(() => bubble.remove(), 3500);
  };

  const applyUpdateStateVisual = (button, state) => {
    if (!button) return;
    const dot = button.querySelector('.desktop-update-dot');
    if (!dot) return;
    let color = '#60a5fa';
    if (state === 'available' || state === 'checking') color = '#f59e0b';
    if (state === 'downloaded') color = '#10b981';
    if (state === 'error') color = '#ef4444';
    if (state === 'not-available') color = '#94a3b8';
    dot.style.background = color;
  };

  const onUpdateButtonClick = async () => {
    if (lastUpdateState === 'downloaded') {
      const res = await window.desktop.installUpdate();
      if (res?.ok) {
        showBubble('Instalando atualização e reiniciando...', 'success');
      } else {
        showBubble('Não foi possível instalar agora.', 'error');
      }
      return;
    }

    showBubble('Verificando atualização...', 'info');
    const result = await window.desktop.checkForUpdates();
    if (result?.skipped) {
      showBubble('Atualização disponível apenas no app instalado.', 'warn');
      return;
    }
    if (!result?.ok) {
      showBubble('Falha ao verificar atualização.', 'error');
    }
  };

  const patchPwaButton = () => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const target = candidates.find((el) => {
      if (el.dataset.desktopUpdatePatched === '1') return false;
      const txt = normalize(el.textContent);
      return txt.includes('pwa') || txt.includes('instalar app') || txt.includes('criar pwa');
    });
    if (!target) return null;

    target.dataset.desktopUpdatePatched = '1';
    target.setAttribute('title', 'Atualizações do desktop');
    target.setAttribute('aria-label', 'Atualizações do desktop');
    target.innerHTML = '<span class="desktop-update-dot" style="display:inline-block;width:8px;height:8px;border-radius:999px;background:#60a5fa;margin-right:8px;vertical-align:middle;"></span><span>Atualização</span>';
    target.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onUpdateButtonClick();
    }, true);
    applyUpdateStateVisual(target, lastUpdateState);
    return target;
  };

  let patchedButton = patchPwaButton();
  const retryPatch = () => {
    if (!patchedButton || !document.contains(patchedButton)) {
      patchedButton = patchPwaButton();
    }
  };

  const unlisten = window.desktop.onUpdateStatus((payload) => {
    lastUpdateState = String(payload?.state || 'idle');
    lastUpdateMessage = String(payload?.message || '');
    if (patchedButton) {
      applyUpdateStateVisual(patchedButton, lastUpdateState);
      patchedButton.setAttribute('title', lastUpdateMessage || 'Atualizações do desktop');
      if (lastUpdateState === 'downloaded') {
        const label = patchedButton.querySelector('span:last-child');
        if (label) label.textContent = 'Instalar Agora';
      } else {
        const label = patchedButton.querySelector('span:last-child');
        if (label) label.textContent = 'Atualização';
      }
    }
  });

  const mo = new MutationObserver(() => retryPatch());
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('beforeunload', () => {
    try { unlisten?.(); } catch {}
    mo.disconnect();
  });

  retryPatch();
})();
`;

  const inject = () => {
    if (windowRef.isDestroyed()) return;
    windowRef.webContents.executeJavaScript(script).catch(() => {});
  };

  windowRef.webContents.on('dom-ready', inject);
  windowRef.webContents.on('did-finish-load', inject);
}

async function createWindow() {
  const isMac = process.platform === 'darwin';
  let rendererEntryForNav = '';
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
    if (!rendererEntryForNav.startsWith('http')) return;
    const allowedOrigin = new URL(rendererEntryForNav).origin;
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

  const entry = await resolveRendererEntry();
  rendererEntryForNav = entry;
  if (entry.startsWith('http')) {
    mainWindow.loadURL(entry);
  } else {
    mainWindow.loadFile(entry);
  }

  installMacUnifiedTitlebar(mainWindow);
  installWindowsCustomTitlebar(mainWindow);
  installElectronUpdateUiBridge(mainWindow);
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

app.whenReady().then(async () => {
  await createWindow();
  registerIpc();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => {});
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (rendererServer) {
    try {
      rendererServer.close();
    } catch {}
    rendererServer = null;
    rendererServerUrl = null;
  }
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
});
