# oneV2 seeLL

Base desktop do oneV2 seeLL com Electron + renderer React desacoplado, IPC seguro e auto-update.

## Rodar em desenvolvimento

```bash
npm install
npm run dev
```

## Build local

```bash
npm run build
```

## Empacotar Windows (NSIS)

```bash
npm run pack:win
```

## Release Windows (GitHub Releases + Auto-update)

```bash
npm run release:win
```

O comando gera os assets esperados em `release/`:
- `onev2-seell-desktop-SETUP.exe`
- `latest.yml`
- `*.blockmap`

No CI, o build usa o frontend real do repositório `onev2react` e empacota esse `dist` no desktop.
Fallback local: se o frontend real não for encontrado, usa o renderer base.

Fluxo em produção:
1. Usuário instala via `onev2-seell-desktop-SETUP.exe`.
2. Instalação padrão per-user em `%LocalAppData%\\Programs\\oneV2 seeLL`.
3. App consulta `latest.yml` na release mais recente.
4. Se houver nova versão, baixa o setup e aplica no reinício (ou via `quitAndInstall`).
5. O workflow faz upload desses arquivos para a release da tag `onev2-seell-v*`.
6. Novas releases atualizam clientes existentes automaticamente.

## Publicar release via tag

1. Ajuste `build.publish.owner` e `build.publish.repo` no `package.json`.
2. Configure `GH_TOKEN` nos secrets do GitHub.
3. Crie e envie uma tag:

```bash
git tag onev2-seell-v0.1.0
git push origin onev2-seell-v0.1.0
```

O workflow `release.yml` vai gerar/publicar a release no GitHub Releases.

## Config local

O app salva configuração em JSON em `app.getPath('userData')/config.json`.
