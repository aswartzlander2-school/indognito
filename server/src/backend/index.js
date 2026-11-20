// Indognito backend: REST API, terminal websockets and the Wisp relay. Listens on the backend port
// (loopback by default); the frontend server proxies /api, /ws and /wisp to it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig, VERSION } from '../lib/config.js';
import { Router, HttpError, send } from '../lib/http.js';
import { openDb, Settings, seedRoles, seedApps, audit } from './db.js';
import { sessionUser } from './auth.js';
import { Workspaces } from './runtime/workspaces.js';
import { ProcSampler, hostStats } from './runtime/procstats.js';
import { Terminals } from './runtime/terminals.js';
import { Machines } from './runtime/machines.js';
import { BrowserQueue } from './browserq.js';
import { Initializer } from './init.js';
import { registerRoutes } from './api.js';

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
seedRoles(db);
const settings = new Settings(db);

// "gnito restart --reinit" drops this marker so initialization replays on next boot. Accounts,
// workspaces and limits are preserved; only the init state is cleared so the setup animation and
// the (idempotent) setup tasks run again.
const reinitMarker = path.join(cfg.dataDir, '.reinit');
if (fs.existsSync(reinitMarker)) {
  settings.delete('init.completedAt');
  try { fs.rmSync(reinitMarker); } catch { /* ignore */ }
  console.log('[gnito] re-initialization requested — replaying setup tasks (accounts preserved)');
}

if (settings.get('init.completedAt')) seedApps(db); // pick up new catalog defaults after upgrades
const workspaces = new Workspaces(cfg);
const sampler = new ProcSampler();
const machines = new Machines(cfg); // per-user isolated microVMs (only active when runtime.microvm.url is set)
const terminals = new Terminals({ cfg, workspaces, settings, sampler, machines });
const browserq = new BrowserQueue({ db, settings, cfg });
const ctx = { cfg, db, settings, workspaces, sampler, terminals, browserq, machines };
ctx.init = new Initializer(ctx);

const router = new Router();
registerRoutes(router, ctx);

function decorate(req) {
  const trusted = req.headers['x-gnito-proxy'] === cfg.internalSecret;
  req.viaFrontend = trusted;
  req.clientIp = (trusted && req.headers['x-gnito-client-ip']) || req.socket.remoteAddress;
  req.isHttps = trusted && req.headers['x-forwarded-proto'] === 'https';
  req.publicHost = (trusted && req.headers['x-forwarded-host']) || req.headers.host;
}

const server = http.createServer(async (req, res) => {
  decorate(req);
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/')) {
      // CSRF: require our custom header (cannot be sent cross-site without CORS) and a same-host Origin.
      if (req.headers['x-gnito'] !== '1') throw new HttpError(403, 'Missing request header');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.publicHost && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request refused');
    }
    const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    for (const h of m.handlers) await h(req, res, { params: m.params, query: url.searchParams });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Internal error' : e.message, ...(e.extra || {}) });
  }
});

const termWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  decorate(req);
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.publicHost && new URL(origin).host !== req.headers.host) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const user = sessionUser(db, req);
  let m;
  if ((m = /^\/wisp\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname))) return browserq.handleUpgrade(req, socket, head, user, m[1]);
  if ((m = /^\/ws\/terminal\/([A-Za-z0-9_-]+)$/.exec(url.pathname))) {
    const s = terminals.get(m[1]);
    if (!user || !s || s.userId !== user.id) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    return termWss.handleUpgrade(req, socket, head, (ws) => terminals.attach(s, ws));
  }
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

// Sample real usage every 3 s; enforce RAM limits where the kernel isn't doing it (no cgroup scope).
const strikes = new Map();
setInterval(async () => {
  await sampler.sample();
  ctx.host = hostStats();
  const probe = terminals.probe();
  const users = new Set(terminals.list().filter((s) => s.status === 'running').map((s) => s.userId));
  for (const uid of users) {
    const lim = ctx.getLimits(uid);
    const u = sampler.treeUsage(terminals.pidsFor(uid));
    if (probe.limits === 'cgroup') continue;
    if (u.rss > lim.ram_mb * 1048576) {
      const newest = terminals.list(uid).filter((s) => s.status === 'running').sort((a, b) => b.created - a.created)[0];
      if (newest) {
        terminals.terminate(newest.id, `Stopped: used ${(u.rss / 1048576).toFixed(0)} MB RAM, over your ${lim.ram_mb} MB limit.`);
        audit(db, null, 'limits.ram_exceeded', `user:${uid}`, { rss: u.rss, limit: lim.ram_mb });
      }
    }
    const k = strikes.get(uid) || 0;
    if (u.cpu > lim.cpu_pct) {
      strikes.set(uid, k + 1);
      if (k + 1 === 3) for (const pid of u.pids) { try { (await import('node:os')).setPriority(pid, 19); } catch { /* not ours */ } }
    } else strikes.set(uid, 0);
  }
}, 3000).unref();

server.listen(cfg.ports.backend, cfg.bind.backend, () => {
  console.log(`[gnito] backend v${VERSION} listening on http://${cfg.bind.backend}:${cfg.ports.backend} (driver: ${terminals.probe().selected})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const s of terminals.list()) terminals.terminate(s.id, 'Server shutting down.');
  setTimeout(() => process.exit(0), 300);
});
