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

## Publicar release via tag

1. Ajuste `build.publish.owner` e `build.publish.repo` no `package.json`.
2. Configure `GH_TOKEN` nos secrets do GitHub.
3. Crie e envie uma tag:

```bash
git tag electron-v0.1.0
git push origin electron-v0.1.0
```

O workflow `release.yml` vai gerar/publicar a release no GitHub Releases.

## Config local

O app salva configuração em JSON em `app.getPath('userData')/config.json`.
