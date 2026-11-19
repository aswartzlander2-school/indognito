// Loads the installation config written by the gnito installer.
// Path: $GNITO_CONFIG, or ./data/config.json for development.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..', '..', '..'); // install root (contains server/, web/, VERSION)
export const VERSION = (() => {
  try { return fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim(); } catch { return '0.0.0-dev'; }
})();

const DEFAULTS = {
  hostname: 'gnito',
  permissionMode: 'user',
  ports: { backend: 7710, frontend: 7711 },
  bind: { backend: '127.0.0.1', frontend: '0.0.0.0' },
  allocation: { ramMb: 3072, storageMb: 8192, cpuCores: 1, cpuPercent: 100 },
  runtime: { driver: 'auto', microvm: { url: '', password: '' } },
  tls: { mode: 'off', cert: '', key: '' },
  publicUrl: '',
};

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  const file = process.env.GNITO_CONFIG || path.join(APP_ROOT, 'data', 'config.json');
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = merge(DEFAULTS, raw);
  cfg.configFile = file;
  cfg.dataDir = path.resolve(raw.dataDir || process.env.GNITO_DATA || path.dirname(file));
  if (process.env.GNITO_BACKEND_PORT) cfg.ports.backend = Number(process.env.GNITO_BACKEND_PORT);
  if (process.env.GNITO_FRONTEND_PORT) cfg.ports.frontend = Number(process.env.GNITO_FRONTEND_PORT);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  // Shared secret between the frontend proxy and the backend (lets the backend trust X-Forwarded-For).
  const secretFile = path.join(cfg.dataDir, 'internal.key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  cfg.internalSecret = fs.readFileSync(secretFile, 'utf8').trim();
  cfg.platform = os.platform();
  return cfg;
}
