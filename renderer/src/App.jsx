import { useEffect, useState } from 'react';

export default function App() {
  const desktop = window.desktop ?? {
    platform: 'unknown',
    minimize: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    toggleMaximize: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    close: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    isMaximized: async () => ({ isMaximized: false }),
    getVersion: async () => ({ version: 'unknown' }),
    checkForUpdates: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    installUpdate: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    getConfig: async () => ({}),
    setConfig: async () => ({ ok: false, reason: 'desktop-unavailable' }),
    onUpdateStatus: () => () => {},
    onWindowState: () => () => {}
  };
  const isDesktopAvailable = !!window.desktop;
  const isMac = desktop.platform === 'darwin';
  const [version, setVersion] = useState('-');
  const [isMaximized, setIsMaximized] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('Pronto');
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    let offUpdate = () => {};
    let offWindow = () => {};

    (async () => {
      const v = await desktop.getVersion();
      setVersion(v.version);

      const current = await desktop.getConfig();
      if (current?.theme) setTheme(String(current.theme));

      const max = await desktop.isMaximized();
      setIsMaximized(!!max.isMaximized);
    })();

    offUpdate = desktop.onUpdateStatus((payload) => {
      setUpdateStatus(payload?.message || payload?.state || 'Sem status');
    });

    offWindow = desktop.onWindowState((payload) => {
      setIsMaximized(!!payload?.isMaximized);
    });

    return () => {
      offUpdate();
      offWindow();
    };
  }, []);

  async function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await desktop.setConfig('theme', next);
  }

  async function manualUpdateCheck() {
    const result = await desktop.checkForUpdates();
    if (result.skipped) {
      setUpdateStatus('Check manual ignorado em modo dev.');
      return;
    }
    if (!result.ok) {
      setUpdateStatus(`Falha: ${result.error || 'erro desconhecido'}`);
      return;
    }
    setUpdateStatus('Check manual disparado com sucesso.');
  }

  return (
    <div className="app">
      <header className={`titlebar ${isMac ? 'is-mac' : ''}`}>
        <div className="title">oneV2 seeLL</div>
        {isMac ? null : (
          <div className="window-actions">
            <button onClick={() => window.desktop.minimize()}>_</button>
            <button onClick={() => window.desktop.toggleMaximize()}>{isMaximized ? '❐' : '□'}</button>
            <button className="danger" onClick={() => window.desktop.close()}>×</button>
          </div>
        )}
      </header>

      <main className="content">
        <h1>Projeto base pronto</h1>
        {!isDesktopAvailable ? (
          <p style={{ color: '#fca5a5' }}>
            Falha ao carregar API desktop (preload). Verifique o build do Electron.
          </p>
        ) : null}
        <p>Versão app: {version}</p>
        <p>Status update: {updateStatus}</p>

        <div className="actions">
          <button onClick={manualUpdateCheck}>Checar atualização agora</button>
          <button onClick={toggleTheme}>Alternar tema ({theme})</button>
        </div>

        <pre>
{`window.desktop disponível com API segura:\n- minimize\n- toggleMaximize\n- close\n- isMaximized\n- getVersion\n- checkForUpdates\n- getConfig\n- setConfig\n- onUpdateStatus\n- onWindowState`}
        </pre>
      </main>
    </div>
  );
}
