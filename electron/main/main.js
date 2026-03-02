const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, shell, session, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CHANNELS, validateConfigSet } = require('../shared/ipc');

let mainWindow;
let autoUpdateTimer = null;
let hasDownloadedUpdate = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

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

function setHeader(headers, name, value) {
  const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase()) || name;
  headers[headerKey] = Array.isArray(value) ? value : [String(value)];
}

function installDesktopCorsBridge() {
  const rawOrigins = process.env.ONEV2_CORS_API_ORIGINS || 'https://api.seellbr.com';
  const origins = rawOrigins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const urls = origins.map((origin) => {
    try {
      const parsed = new URL(origin);
      return `${parsed.origin}/*`;
    } catch {
      return '';
    }
  }).filter(Boolean);

  if (!urls.length) return;

  const filter = { urls };
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const requestOrigin =
      details.requestHeaders?.Origin ||
      details.requestHeaders?.origin ||
      '';
    const initiator = String(details.initiator || '');

    let rendererOrigin = requestOrigin;
    if (initiator.startsWith('app://')) {
      rendererOrigin = initiator;
    }

    const isDesktopOrigin =
      rendererOrigin.startsWith('http://127.0.0.1:') ||
      rendererOrigin.startsWith('http://localhost:') ||
      rendererOrigin.startsWith('app://') ||
      rendererOrigin === 'null';

    if (!isDesktopOrigin) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = { ...(details.responseHeaders || {}) };
    setHeader(responseHeaders, 'Access-Control-Allow-Origin', rendererOrigin);
    setHeader(responseHeaders, 'Access-Control-Allow-Credentials', 'true');
    setHeader(responseHeaders, 'Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    setHeader(responseHeaders, 'Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    setHeader(responseHeaders, 'Vary', 'Origin');

    callback({ responseHeaders });
  });
}

function installAppProtocol() {
  const rootDir = getRendererDistPath();
  if (!fs.existsSync(path.join(rootDir, 'index.html'))) {
    throw new Error(`renderer/dist/index.html não encontrado em: ${rootDir}`);
  }

  protocol.handle('app', async (request) => {
    const reqUrl = new URL(request.url || 'app://local/index.html');
    let pathname = decodeURIComponent(reqUrl.pathname || '/');
    if (pathname === '/') pathname = '/index.html';

    let targetPath = resolveStaticFilePath(rootDir, pathname);
    if (!targetPath) {
      targetPath = path.join(rootDir, 'index.html');
    }

    try {
      const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
      if (stat && stat.isDirectory()) {
        targetPath = path.join(targetPath, 'index.html');
      }
    } catch {
      // fallback SPA abaixo
    }

    if (!fs.existsSync(targetPath)) {
      targetPath = path.join(rootDir, 'index.html');
    }

    if (!fs.existsSync(targetPath)) {
      return new Response('index.html não encontrado', { status: 500 });
    }

    const response = await net.fetch(pathToFileURL(targetPath).toString());
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-cache');
    headers.set('Content-Type', getContentType(targetPath));
    return new Response(response.body, { status: response.status, headers });
  });
}

async function resolveRendererEntry() {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  // Override opcional para apontar para URL remota (apenas quando necessário).
  if (process.env.ONEV2_APP_URL) return process.env.ONEV2_APP_URL;
  return 'app://local/index.html';
}

function installMacUnifiedTitlebar(windowRef) {
  if (process.platform !== 'darwin') return;

  const script = `
(() => {
  if (window.__desktopUnifiedTitlebarInstalled) return;
  window.__desktopUnifiedTitlebarInstalled = true;

  const STRIP_HEIGHT = 30;
  const LAYOUT_OFFSET = 22;
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
  strip.style.background = 'transparent';
  document.documentElement.appendChild(strip);

  const sidebarCap = document.createElement('div');
  sidebarCap.style.position = 'absolute';
  sidebarCap.style.left = '0';
  sidebarCap.style.top = '0';
  sidebarCap.style.height = '100%';
  sidebarCap.style.width = '0px';
  sidebarCap.style.pointerEvents = 'none';
  sidebarCap.style.background = '#1f232a';
  strip.appendChild(sidebarCap);

  const applyColorsAndWidths = () => {
    const header = document.querySelector('[data-app-header]') || findFirstVisible(HEADER_SELECTORS, 38);
    const sidebar = document.querySelector('[data-app-sidebar]') || findSidebar();
    const headerColor = getBackground(header, '#f3f4f6');
    strip.style.background = headerColor;
    const sidebarColor = getBackground(sidebar, '#1f232a');
    const sidebarWidth = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().width)) : 0;
    sidebarCap.style.width = sidebarWidth + 'px';
    sidebarCap.style.background = sidebarColor;

    if (header) {
      if (!header.dataset.desktopTitlebarBaseTop) {
        const topPx = Number.parseFloat(window.getComputedStyle(header).top || '0') || 0;
        header.dataset.desktopTitlebarBaseTop = String(topPx);
      }
      const baseTop = Number.parseFloat(header.dataset.desktopTitlebarBaseTop || '0') || 0;
      header.style.setProperty('top', (baseTop + LAYOUT_OFFSET) + 'px', 'important');
      header.style.setProperty('overflow', 'visible', 'important');
      if (header.firstElementChild instanceof HTMLElement) {
        header.firstElementChild.style.setProperty('overflow', 'visible', 'important');
      }
    }

    if (sidebar) {
      if (!sidebar.dataset.desktopTitlebarBaseTop) {
        const topPx = Number.parseFloat(window.getComputedStyle(sidebar).top || '0') || 0;
        sidebar.dataset.desktopTitlebarBaseTop = String(topPx);
      }
      const baseTop = Number.parseFloat(sidebar.dataset.desktopTitlebarBaseTop || '0') || 0;
      sidebar.style.setProperty('top', (baseTop + LAYOUT_OFFSET) + 'px', 'important');
      sidebar.style.setProperty('height', 'calc(100vh - ' + (baseTop + LAYOUT_OFFSET) + 'px)', 'important');
    }

    if (header && header.nextElementSibling instanceof HTMLElement) {
      const contentEl = header.nextElementSibling;
      if (!contentEl.dataset.desktopTitlebarBasePaddingTop) {
        const paddingTop = Number.parseFloat(window.getComputedStyle(contentEl).paddingTop || '0') || 0;
        contentEl.dataset.desktopTitlebarBasePaddingTop = String(paddingTop);
      }
      const basePaddingTop = Number.parseFloat(contentEl.dataset.desktopTitlebarBasePaddingTop || '0') || 0;
      contentEl.style.setProperty('padding-top', (basePaddingTop + LAYOUT_OFFSET) + 'px', 'important');
      contentEl.style.setProperty('min-height', 'calc(100vh - 64px - ' + LAYOUT_OFFSET + 'px)', 'important');
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
  const HEADER_LAYOUT_OFFSET = 36;
  const SIDEBAR_LAYOUT_OFFSET = 24;
  const CONTENT_LAYOUT_OFFSET = 36;
  const SIDEBAR_SELECTORS = ['[data-app-sidebar]', '.app-sidebar', '.sidebar', 'aside[class*="sidebar"]', 'nav[class*="sidebar"]'];
  const HEADER_SELECTORS = ['[data-app-header]', '.app-header', '.header', '.topbar', 'header[class*="header"]', 'header'];

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

  const bar = document.createElement('div');
  bar.id = 'desktop-win-titlebar';
  bar.style.position = 'fixed';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.right = '0';
  bar.style.height = BAR_HEIGHT + 'px';
  bar.style.zIndex = '2147483647';
  bar.style.pointerEvents = 'auto';
  bar.style.userSelect = 'none';
  bar.style.webkitUserSelect = 'none';
  bar.style.border = '0';
  bar.style.boxShadow = 'none';
  bar.style.display = 'flex';
  bar.style.alignItems = 'stretch';
  bar.style.justifyContent = 'space-between';
  bar.style.gap = '8px';

  const dragArea = document.createElement('div');
  dragArea.style.flex = '1';
  dragArea.style.webkitAppRegion = 'drag';
  dragArea.style.pointerEvents = 'auto';

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.alignItems = 'flex-start';
  controls.style.gap = '10px';
  controls.style.padding = '14px 14px 0 8px';
  controls.style.webkitAppRegion = 'no-drag';
  controls.style.pointerEvents = 'auto';

  const mkBtn = (type, bg, label, symbol) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.style.width = '16px';
    btn.style.height = '16px';
    btn.style.borderRadius = '999px';
    btn.style.border = '0';
    btn.style.padding = '0';
    btn.style.margin = '0';
    btn.style.cursor = 'pointer';
    btn.style.background = bg;
    btn.style.position = 'relative';
    btn.style.display = 'grid';
    btn.style.placeItems = 'center';
    btn.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.18)';
    btn.dataset.type = type;

    const icon = document.createElement('span');
    icon.textContent = symbol;
    icon.style.font = '700 11px/1 "Segoe UI", sans-serif';
    icon.style.color = 'rgba(0,0,0,0.62)';
    icon.style.opacity = '0';
    icon.style.transform = 'translateY(-1px)';
    icon.style.transition = 'opacity 120ms ease';
    btn.appendChild(icon);

    btn.addEventListener('mouseenter', () => { icon.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { icon.style.opacity = '0'; });
    return btn;
  };

  const closeBtn = mkBtn('close', '#ff5f57', 'Fechar', '×');
  const minBtn = mkBtn('min', '#febc2e', 'Minimizar', '−');
  const maxBtn = mkBtn('max', '#28c840', 'Maximizar', '+');

  controls.appendChild(minBtn);
  controls.appendChild(maxBtn);
  controls.appendChild(closeBtn);
  bar.appendChild(dragArea);
  bar.appendChild(controls);
  document.documentElement.appendChild(bar);

  const scrollFixStyle = document.createElement('style');
  scrollFixStyle.id = 'desktop-win-scroll-fix';
  scrollFixStyle.textContent =
    'html.desktop-win-layout-fix, body.desktop-win-layout-fix {' +
    'scrollbar-gutter: auto !important;' +
    'overflow-x: hidden !important;' +
    '}' +
    'html.desktop-win-layout-fix #root, html.desktop-win-layout-fix .content, html.desktop-win-layout-fix main, html.desktop-win-layout-fix [role="main"], html.desktop-win-layout-fix .pageContent, html.desktop-win-layout-fix [class*="pageContent"] {' +
    'scrollbar-gutter: auto !important;' +
    'padding-right: 0 !important;' +
    'margin-right: 0 !important;' +
    'overflow-x: hidden !important;' +
    '}' +
    'html.desktop-win-layout-fix *, body.desktop-win-layout-fix * {' +
    'scrollbar-gutter: auto !important;' +
    '}' +
    'html.desktop-win-layout-fix .pageContent, html.desktop-win-layout-fix [class*="pageContent"], html.desktop-win-layout-fix main, html.desktop-win-layout-fix [role="main"] {' +
    'overflow-x: hidden !important;' +
    '}' +
    'html.desktop-win-layout-fix * { overscroll-behavior: contain; }' +
    'html.desktop-win-layout-fix .desktop-win-scroll-target {' +
    'scrollbar-gutter: stable !important;' +
    'scrollbar-width: thin;' +
    'scrollbar-color: transparent transparent;' +
    '}' +
    'html.desktop-win-layout-fix .desktop-win-scroll-target::-webkit-scrollbar {' +
    'width: 8px; height: 8px;' +
    '}' +
    'html.desktop-win-layout-fix .desktop-win-scroll-target::-webkit-scrollbar-track {' +
    'background: transparent; margin: 2px;' +
    '}' +
    'html.desktop-win-layout-fix .desktop-win-scroll-target::-webkit-scrollbar-thumb {' +
    'background: transparent; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; min-height: 30px;' +
    '}' +
    'html.desktop-win-layout-fix.desktop-win-scroll-active .desktop-win-scroll-target::-webkit-scrollbar-thumb {' +
    'background: rgba(148, 163, 184, 0.62); border: 2px solid transparent; background-clip: padding-box;' +
    '}' +
    'html.desktop-win-layout-fix .desktop-win-scroll-target::-webkit-scrollbar-corner {' +
    'background: transparent;' +
    '}' +
    'html.desktop-win-layout-fix.desktop-win-scroll-active .desktop-win-scroll-target {' +
    'scrollbar-color: rgba(148, 163, 184, 0.62) transparent;' +
    '}';
  document.documentElement.appendChild(scrollFixStyle);

  let currentScrollHost = null;
  let clearScrollActiveTimer = null;
  const SCROLL_EDGE_ZONE = 14;
  const markScrollActive = () => {
    document.documentElement.classList.add('desktop-win-scroll-active');
    if (clearScrollActiveTimer) clearTimeout(clearScrollActiveTimer);
    clearScrollActiveTimer = setTimeout(() => {
      document.documentElement.classList.remove('desktop-win-scroll-active');
    }, 420);
  };

  const handlePointerMove = (event) => {
    if (!currentScrollHost) return;
    const rect = currentScrollHost.getBoundingClientRect();
    const pointerX = Number(event?.clientX ?? -1);
    const pointerY = Number(event?.clientY ?? -1);
    const inside =
      pointerX >= rect.left &&
      pointerX <= rect.right &&
      pointerY >= rect.top &&
      pointerY <= rect.bottom;
    if (!inside) return;

    const nearRightEdge = pointerX >= (rect.right - SCROLL_EDGE_ZONE);
    if (nearRightEdge) {
      markScrollActive();
      return;
    }

    if (clearScrollActiveTimer) clearTimeout(clearScrollActiveTimer);
    clearScrollActiveTimer = setTimeout(() => {
      document.documentElement.classList.remove('desktop-win-scroll-active');
    }, 120);
  };

  const handlePointerLeave = () => {
    if (clearScrollActiveTimer) clearTimeout(clearScrollActiveTimer);
    document.documentElement.classList.remove('desktop-win-scroll-active');
  };

  const bindScrollHost = (host) => {
    if (!(host instanceof HTMLElement)) return;
    if (currentScrollHost === host) return;
    if (currentScrollHost) {
      currentScrollHost.classList.remove('desktop-win-scroll-target');
      currentScrollHost.removeEventListener('scroll', markScrollActive, { passive: true });
      currentScrollHost.removeEventListener('wheel', markScrollActive, { passive: true });
      currentScrollHost.removeEventListener('mousemove', handlePointerMove);
      currentScrollHost.removeEventListener('mouseleave', handlePointerLeave);
      currentScrollHost.removeEventListener('touchmove', markScrollActive, { passive: true });
    }
    currentScrollHost = host;
    currentScrollHost.classList.add('desktop-win-scroll-target');
    currentScrollHost.addEventListener('scroll', markScrollActive, { passive: true });
    currentScrollHost.addEventListener('wheel', markScrollActive, { passive: true });
    currentScrollHost.addEventListener('mousemove', handlePointerMove);
    currentScrollHost.addEventListener('mouseleave', handlePointerLeave);
    currentScrollHost.addEventListener('touchmove', markScrollActive, { passive: true });
  };

  const pickScrollHost = (header) => {
    if (header && header.nextElementSibling instanceof HTMLElement) {
      const content = header.nextElementSibling;
      const deepCandidates = Array.from(content.querySelectorAll('.pageContent, [class*="pageContent"], main, [role="main"]'));
      const candidates = [content, ...deepCandidates];
      for (const el of candidates) {
        if (!(el instanceof HTMLElement)) continue;
        const canScroll = (el.scrollHeight - el.clientHeight) > 20;
        if (canScroll) return el;
      }
      return content;
    }
    return null;
  };

  const safeCall = async (fn) => {
    try { return await fn(); } catch { return null; }
  };
  minBtn.addEventListener('click', () => safeCall(() => window.desktop?.minimize?.()));
  closeBtn.addEventListener('click', () => safeCall(() => window.desktop?.close?.()));
  maxBtn.addEventListener('click', () => safeCall(() => window.desktop?.toggleMaximize?.()));
  dragArea.addEventListener('dblclick', () => safeCall(() => window.desktop?.toggleMaximize?.()));

  const updateMaxVisual = (isMaximized) => {
    const icon = maxBtn.firstElementChild;
    if (!icon) return;
    icon.textContent = isMaximized ? '❐' : '+';
  };
  if (window.desktop?.onWindowState) {
    window.desktop.onWindowState((payload) => updateMaxVisual(!!payload?.isMaximized));
  }
  safeCall(() => window.desktop?.isMaximized?.()).then((res) => updateMaxVisual(!!res?.isMaximized));

  const syncLayout = () => {
    const header = getFirstVisible(HEADER_SELECTORS, 24);
    const sidebar = getFirstVisible(SIDEBAR_SELECTORS, 40);
    const sidebarColor = getColor(sidebar, '#1f232a');
    const headerColor = getColor(header, '#f8fafc');
    const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
    const splitX = sidebarRect ? Math.max(0, Math.round(sidebarRect.right)) : 0;
    bar.style.background = \`linear-gradient(to right, \${sidebarColor} 0px, \${sidebarColor} \${splitX}px, \${headerColor} \${splitX}px, \${headerColor} 100%)\`;

    if (header) {
      if (!header.dataset.desktopWinBaseTop) {
        header.dataset.desktopWinBaseTop = String(Number.parseFloat(window.getComputedStyle(header).top || '0') || 0);
      }
      const baseTop = Number.parseFloat(header.dataset.desktopWinBaseTop || '0') || 0;
      header.style.setProperty('top', (baseTop + HEADER_LAYOUT_OFFSET) + 'px', 'important');
    }

    if (sidebar) {
      if (!sidebar.dataset.desktopWinBaseTop) {
        sidebar.dataset.desktopWinBaseTop = String(Number.parseFloat(window.getComputedStyle(sidebar).top || '0') || 0);
      }
      const baseTop = Number.parseFloat(sidebar.dataset.desktopWinBaseTop || '0') || 0;
      sidebar.style.setProperty('top', (baseTop + SIDEBAR_LAYOUT_OFFSET) + 'px', 'important');
      sidebar.style.setProperty('height', \`calc(100vh - \${baseTop + SIDEBAR_LAYOUT_OFFSET}px)\`, 'important');
      sidebar.style.setProperty('overflow', 'visible', 'important');
    }

    if (header && sidebar) {
      document.documentElement.classList.add('desktop-win-layout-fix');
      document.body?.classList.add('desktop-win-layout-fix');
    } else {
      document.documentElement.classList.remove('desktop-win-layout-fix');
      document.body?.classList.remove('desktop-win-layout-fix');
    }

    if (header && header.nextElementSibling instanceof HTMLElement) {
      const content = header.nextElementSibling;
      if (!content.dataset.desktopWinBasePaddingTop) {
        content.dataset.desktopWinBasePaddingTop = String(Number.parseFloat(window.getComputedStyle(content).paddingTop || '0') || 0);
      }
      const basePad = Number.parseFloat(content.dataset.desktopWinBasePaddingTop || '0') || 0;
      content.style.setProperty('padding-top', (basePad + CONTENT_LAYOUT_OFFSET) + 'px', 'important');
    }

    const scrollHost = pickScrollHost(header);
    bindScrollHost(scrollHost);
  };

  let raf = null;
  const refresh = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      syncLayout();
    });
  };

  const ro = new ResizeObserver(refresh);
  const observeLayoutTargets = () => {
    const header = getFirstVisible(HEADER_SELECTORS, 24);
    const sidebar = getFirstVisible(SIDEBAR_SELECTORS, 40);
    if (header) ro.observe(header);
    if (sidebar) ro.observe(sidebar);
  };

  let animTimer = null;
  const runFastSync = () => {
    if (animTimer) return;
    animTimer = setInterval(() => {
      syncLayout();
    }, 16);
  };
  const stopFastSync = () => {
    if (!animTimer) return;
    clearInterval(animTimer);
    animTimer = null;
    refresh();
  };

  refresh();
  observeLayoutTargets();
  window.addEventListener('resize', refresh, { passive: true });
  document.addEventListener('transitionrun', runFastSync, true);
  document.addEventListener('transitionstart', runFastSync, true);
  document.addEventListener('transitionend', stopFastSync, true);
  document.addEventListener('animationstart', runFastSync, true);
  document.addEventListener('animationend', stopFastSync, true);
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
  let downloadToastEl = null;

  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .replace(/\\s+/g, ' ')
      .trim();

  const showBubble = (message, type = 'info') => {
    const toastType = type === 'warn' ? 'warning' : (type || 'info');
    const toastTitle =
      toastType === 'success' ? 'Sucesso!' :
      toastType === 'error' ? 'Atenção!' :
      toastType === 'warning' ? 'Atenção!' : 'Informação';
    const toastIcon =
      toastType === 'success' ? 'fa-check-circle' :
      toastType === 'error' ? 'fa-times-circle' :
      toastType === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';

    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast ' + toastType;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML =
      '<div class="toast-icon"><i class="fas ' + toastIcon + '"></i></div>' +
      '<div class="toast-content">' +
      '<div class="toast-title">' + toastTitle + '</div>' +
      '<div class="toast-message"></div>' +
      '</div>' +
      '<button type="button" class="toast-close" aria-label="Fechar"><i class="fas fa-times"></i></button>';

    const messageEl = toast.querySelector('.toast-message');
    if (messageEl) messageEl.textContent = String(message || '');

    const close = () => {
      if (toast.classList.contains('removing')) return;
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    };

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn?.addEventListener('click', close);

    container.appendChild(toast);
    const toasts = Array.from(container.querySelectorAll('.toast'));
    if (toasts.length > 3) {
      const extra = toasts.length - 3;
      for (let i = 0; i < extra; i += 1) {
        const t = toasts[i];
        if (t && t !== toast) t.remove();
      }
    }
    setTimeout(close, 3600);
  };

  const closeDownloadToast = () => {
    if (!downloadToastEl) return;
    downloadToastEl.remove();
    downloadToastEl = null;
  };

  const upsertDownloadToast = (percent) => {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const safe = Math.max(0, Math.min(100, Number(percent || 0)));
    if (!downloadToastEl || !document.contains(downloadToastEl)) {
      downloadToastEl = document.createElement('div');
      downloadToastEl.className = 'toast info';
      downloadToastEl.setAttribute('role', 'alert');
      downloadToastEl.setAttribute('aria-live', 'polite');
      downloadToastEl.innerHTML =
        '<div class="toast-icon"><i class="fas fa-download"></i></div>' +
        '<div class="toast-content">' +
        '<div class="toast-title">Atualização em andamento</div>' +
        '<div class="toast-message">Baixando atualização...</div>' +
        '<div class="desktop-update-progress" style="margin-top:8px;height:6px;border-radius:999px;background:rgba(148,163,184,.25);overflow:hidden;">' +
        '<div class="desktop-update-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#10b981);transition:width .2s ease;"></div>' +
        '</div>' +
        '</div>' +
        '<button type="button" class="toast-close" aria-label="Fechar"><i class="fas fa-times"></i></button>';
      const closeBtn = downloadToastEl.querySelector('.toast-close');
      closeBtn?.addEventListener('click', closeDownloadToast);
      container.appendChild(downloadToastEl);
    }

    const msgEl = downloadToastEl.querySelector('.toast-message');
    if (msgEl) msgEl.textContent = 'Baixando atualização: ' + Math.round(safe) + '%';
    const barEl = downloadToastEl.querySelector('.desktop-update-progress-bar');
    if (barEl) barEl.style.width = Math.round(safe) + '%';
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

  const ensureVersionBadge = async () => {
    const existing = document.getElementById('desktop-electron-version');
    if (existing) return;
    const versionRes = await window.desktop?.getVersion?.();
    const version = String(versionRes?.version || 'unknown');
    const badge = document.createElement('div');
    badge.id = 'desktop-electron-version';
    badge.textContent = 'v.' + version;
    badge.style.position = 'fixed';
    badge.style.right = '8px';
    badge.style.bottom = '4px';
    badge.style.zIndex = '2147483645';
    badge.style.pointerEvents = 'none';
    badge.style.font = '600 9px/1 "Quicksand", "Segoe UI", sans-serif';
    badge.style.color = 'rgba(100, 116, 139, 0.76)';
    badge.style.background = 'rgba(255, 255, 255, 0.6)';
    badge.style.padding = '2px 5px';
    badge.style.borderRadius = '999px';
    badge.style.border = '1px solid rgba(148, 163, 184, 0.35)';
    badge.style.backdropFilter = 'blur(4px)';
    document.body.appendChild(badge);
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

  const patchElectronSettingsButton = () => {
    const pathInfo = normalize(window.location.pathname || '');
    const hashInfo = normalize(window.location.hash || '');
    const inUserConfigRoute = pathInfo.includes('userconfig') || hashInfo.includes('userconfig');
    if (!inUserConfigRoute) return null;

    const host =
      document.querySelector('.userconfig-page .header-actions') ||
      document.querySelector('.userconfig-page .card-header .header-actions') ||
      document.querySelector('.userconfig-page .card-header') ||
      null;
    if (!host) return null;

    host.dataset.desktopElectronUpdateHost = '1';

    const existing = host.querySelector('[data-desktop-electron-update-btn="1"]');
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.justifyContent = 'flex-end';
    wrapper.style.marginTop = '0';
    wrapper.style.marginLeft = '10px';
    wrapper.style.width = 'auto';

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.desktopElectronUpdateBtn = '1';
    button.style.display = 'inline-flex';
    button.style.alignItems = 'center';
    button.style.gap = '8px';
    button.style.padding = '10px 14px';
    button.style.border = '1px solid rgba(30, 64, 175, 0.22)';
    button.style.borderRadius = '12px';
    button.style.background = '#2563eb';
    button.style.color = '#fff';
    button.style.font = '700 13px/1 "Segoe UI", sans-serif';
    button.style.cursor = 'pointer';
    button.style.boxShadow = '0 8px 18px rgba(37, 99, 235, 0.24)';
    button.innerHTML = '<span class="desktop-update-dot" style="display:inline-block;width:8px;height:8px;border-radius:999px;background:#bfdbfe"></span><span>Verificar atualizações</span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onUpdateButtonClick();
    }, true);

    applyUpdateStateVisual(button, lastUpdateState);
    button.setAttribute('title', lastUpdateMessage || 'Verificar atualizações');

    wrapper.appendChild(button);
    host.appendChild(wrapper);
    return button;
  };

  let patchedButton = patchPwaButton();
  let patchedSettingsButton = patchElectronSettingsButton();
  const retryPatch = () => {
    if (!patchedButton || !document.contains(patchedButton)) {
      patchedButton = patchPwaButton();
    }
    if (!patchedSettingsButton || !document.contains(patchedSettingsButton)) {
      patchedSettingsButton = patchElectronSettingsButton();
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
    if (patchedSettingsButton) {
      applyUpdateStateVisual(patchedSettingsButton, lastUpdateState);
      patchedSettingsButton.setAttribute('title', lastUpdateMessage || 'Verificar atualizações');
      const label = patchedSettingsButton.querySelector('span:last-child');
      if (label) {
        label.textContent = lastUpdateState === 'downloaded'
          ? 'Instalar atualização'
          : 'Verificar atualizações';
      }
    }

    // Toasts claros no topo para status de atualização.
    if (!window.__desktopUpdateToastState) {
      window.__desktopUpdateToastState = { lastState: '' };
    }
    const toastState = window.__desktopUpdateToastState;
    const state = lastUpdateState;

    if (state === 'downloading') {
      const percent = Math.max(0, Math.min(100, Number(payload?.progress?.percent || 0)));
      upsertDownloadToast(percent);
      toastState.lastState = state;
      return;
    }

    closeDownloadToast();

    if (toastState.lastState === state) return;
    toastState.lastState = state;

    if (state === 'checking') showBubble('Verificando atualização do aplicativo...', 'info');
    if (state === 'available') showBubble('Nova versão encontrada. Download iniciado.', 'warn');
    if (state === 'not-available') showBubble('Aplicativo já está atualizado.', 'success');
    if (state === 'downloaded') showBubble('Atualização pronta. Clique para instalar e reiniciar.', 'success');
    if (state === 'error') showBubble(lastUpdateMessage || 'Falha ao atualizar o aplicativo.', 'error');
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
  ensureVersionBadge().catch(() => {});
})();
`;

  const inject = () => {
    if (windowRef.isDestroyed()) return;
    windowRef.webContents.executeJavaScript(script).catch(() => {});
  };

  windowRef.webContents.on('dom-ready', inject);
  windowRef.webContents.on('did-finish-load', inject);
}

function installDesktopInteractionGuards(windowRef) {
  const script = `
(() => {
  if (window.__desktopInteractionGuardsInstalled) return;
  window.__desktopInteractionGuardsInstalled = true;

  const isImageNode = (node) => {
    if (!(node instanceof Element)) return false;
    if (node instanceof HTMLImageElement) return true;
    return !!node.closest('img, [data-no-drag-image="1"]');
  };

  // Evita arrastar imagens/links com imagem (efeito "app", sem ghost drag).
  document.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (isImageNode(target)) {
      event.preventDefault();
      return;
    }
    const el = target instanceof Element ? target : null;
    const linkWithImage = el?.closest?.('a')?.querySelector?.('img');
    if (linkWithImage) {
      event.preventDefault();
    }
  }, true);

  // Bloqueia drag/drop de arquivos na janela para evitar navegação acidental.
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes?.('Files')) event.preventDefault();
  }, true);
  document.addEventListener('drop', (event) => {
    if (event.dataTransfer?.types?.includes?.('Files')) event.preventDefault();
  }, true);

  const markImagesNotDraggable = () => {
    document.querySelectorAll('img').forEach((img) => {
      img.setAttribute('draggable', 'false');
      img.style.userSelect = 'none';
      img.style.webkitUserDrag = 'none';
    });
  };

  markImagesNotDraggable();
  const mo = new MutationObserver(markImagesNotDraggable);
  mo.observe(document.documentElement, { childList: true, subtree: true });
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
  const isProduction = app.isPackaged;
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
      devTools: !isProduction,
      // Mantido alinhado ao app legado (prevenda2), evitando bloqueio CORS do app://local para API remota.
      webSecurity: false,
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

  if (isProduction) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      const ctrlOrCmd = !!(input.control || input.meta);
      const shift = !!input.shift;
      const alt = !!input.alt;
      const isF12 = key === 'f12';
      const isCtrlShiftI = ctrlOrCmd && shift && key === 'i';
      const isCtrlShiftJ = ctrlOrCmd && shift && key === 'j';
      const isCtrlShiftC = ctrlOrCmd && shift && key === 'c';
      const isCtrlU = ctrlOrCmd && key === 'u';
      const isMacInspector = input.meta && alt && key === 'i';
      if (isF12 || isCtrlShiftI || isCtrlShiftJ || isCtrlShiftC || isCtrlU || isMacInspector) {
        event.preventDefault();
      }
    });

    mainWindow.webContents.on('context-menu', (event) => {
      event.preventDefault();
    });

    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
  }

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
  if (entry.startsWith('http') || entry.startsWith('app://')) {
    mainWindow.loadURL(entry);
  } else {
    mainWindow.loadFile(entry);
  }

  installMacUnifiedTitlebar(mainWindow);
  installWindowsCustomTitlebar(mainWindow);
  installElectronUpdateUiBridge(mainWindow);
  installDesktopInteractionGuards(mainWindow);
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
      autoUpdater.quitAndInstall(true, true);
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
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

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

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3500);

  autoUpdateTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  installAppProtocol();
  installDesktopCorsBridge();
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
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
});
