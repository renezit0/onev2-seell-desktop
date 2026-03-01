import { useEffect, useState } from 'react';

export default function App() {
  const isMac = window.desktop.platform === 'darwin';
  const [version, setVersion] = useState('-');
  const [isMaximized, setIsMaximized] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('Pronto');
  const [theme, setTheme] = useState('system');

  useEffect(() => {
    let offUpdate = () => {};
    let offWindow = () => {};

    (async () => {
      const v = await window.desktop.getVersion();
      setVersion(v.version);

      const current = await window.desktop.getConfig();
      if (current?.theme) setTheme(String(current.theme));

      const max = await window.desktop.isMaximized();
      setIsMaximized(!!max.isMaximized);
    })();

    offUpdate = window.desktop.onUpdateStatus((payload) => {
      setUpdateStatus(payload?.message || payload?.state || 'Sem status');
    });

    offWindow = window.desktop.onWindowState((payload) => {
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
    await window.desktop.setConfig('theme', next);
  }

  async function manualUpdateCheck() {
    const result = await window.desktop.checkForUpdates();
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
