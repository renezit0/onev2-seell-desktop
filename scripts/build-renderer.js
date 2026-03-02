#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const localRendererDist = path.join(root, 'renderer', 'dist');

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function isFrontendDir(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'));
}

const envPath = process.env.ONEV2_FRONTEND_PATH;
const candidates = [
  envPath,
  path.resolve(root, '..', 'onev2react', 'frontend'),
  path.resolve(root, '..', '..', 'onev2react', 'frontend')
].filter(Boolean);

const externalFrontend = candidates.find(isFrontendDir);

if (externalFrontend) {
  console.log(`[build-renderer] Usando frontend real em: ${externalFrontend}`);
  run('npm', ['ci', '--no-audit', '--no-fund'], externalFrontend);
  run('npm', ['run', 'build'], externalFrontend);
  const externalDist = path.join(externalFrontend, 'dist');
  if (!fs.existsSync(externalDist)) {
    console.error('[build-renderer] Dist do frontend real não encontrado:', externalDist);
    process.exit(1);
  }
  copyDir(externalDist, localRendererDist);
  console.log('[build-renderer] Dist do frontend real copiado para renderer/dist');
  process.exit(0);
}

console.log('[build-renderer] Frontend real não encontrado. Usando renderer base.');
run('npx', ['vite', 'build', '--config', 'renderer/vite.config.js'], root);
