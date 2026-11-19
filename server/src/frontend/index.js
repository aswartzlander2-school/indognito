// Indognito frontend server: serves the web UI and the browser-engine files, and reverse-proxies
// /api, /ws and /wisp to the backend (which listens on loopback by default).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { loadConfig, APP_ROOT, VERSION } from '../lib/config.js';

const cfg = loadConfig();
const WEB = path.join(APP_ROOT, 'web');
const NM = path.join(APP_ROOT, 'server', 'node_modules');

// URL prefix -> directory. Only these trees are served.
const MOUNTS = [
  ['/vendor/scramjet/', path.join(NM, '@mercuryworkshop/scramjet/dist')],
  ['/vendor/baremux/', path.join(NM, '@mercuryworkshop/bare-mux/dist')],
  ['/vendor/epoxy/', path.join(NM, '@mercuryworkshop/epoxy-transport/dist')],
  ['/vendor/xterm/', path.join(NM, '@xterm/xterm')],
  ['/vendor/xterm-fit/', path.join(NM, '@xterm/addon-fit')],
  ['/vendor/webauthn/', path.join(NM, '@simplewebauthn/browser/dist/bundle')],
  ['/fonts/bricolage/', path.join(NM, '@fontsource/bricolage-grotesque/files')],
  ['/fonts/inter/', path.join(NM, '@fontsource/inter/files')],
  ['/fonts/mono/', path.join(NM, '@fontsource/jetbrains-mono/files')],
  ['/', WEB],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'", // unsafe-eval: Scramjet's controller compiles its URL codec at runtime
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self' ws: wss:", "worker-src 'self' blob:",
  "frame-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const tlsOn = cfg.tls?.mode === 'files' && cfg.tls.cert && cfg.tls.key;

function baseHeaders(req) {
  const h = {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'SAMEORIGIN',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'x-indognito': `v${VERSION}`, // identifies this service openly to network security products
  };
  if (tlsOn || req.headers['x-forwarded-proto'] === 'https') h['strict-transport-security'] = 'max-age=31536000';
  return h;
}

function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length);
    if (prefix === '/' && (rel === '' || rel.endsWith('/'))) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) return false;
    let st; try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const ext = path.extname(file);
    const headers = { ...baseHeaders(req), 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    headers['cache-control'] = prefix === '/' ? 'no-cache' : 'public, max-age=86400';
    if (rel === 'sw.js') { headers['service-worker-allowed'] = '/'; headers['cache-control'] = 'no-cache'; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

function forwardHeaders(req) {
  const h = { ...req.headers };
  h['x-gnito-proxy'] = cfg.internalSecret;
  h['x-gnito-client-ip'] = cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
  h['x-forwarded-proto'] = tlsOn ? 'https' : (req.headers['x-forwarded-proto'] || 'http');
  h['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host;
  return h;
}

function proxyHttp(req, res) {
  const up = http.request({ host: '127.0.0.1', port: cfg.ports.backend, method: req.method, path: req.url, headers: forwardHeaders(req) }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, ...baseHeaders(req) });
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The Indognito backend is not responding. Run "gnito status" on the host.' }));
  });
  req.pipe(up);
}

function proxyUpgrade(req, socket, head) {
  const up = net.connect(cfg.ports.backend, '127.0.0.1', () => {
    const h = forwardHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const vv of [].concat(v)) raw += `${k}: ${vv}\r\n`;
    up.write(raw + '\r\n'); if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
}

const wellKnown = JSON.stringify({
  service: 'Indognito', version: VERSION, kind: 'self-hosted browser workspace',
  description: 'Remote browser isolation and workspace platform. Traffic is not disguised; see docs/NETWORK.md.',
  relay: { path: '/wisp/', protocol: 'Wisp over WebSocket' },
}, null, 2);

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/api/')) return proxyHttp(req, res);
  if (p === '/.well-known/indognito.json') { res.writeHead(200, { ...baseHeaders(req), 'content-type': 'application/json' }); return res.end(wellKnown); }
  if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (serveStatic(req, res, p)) return;
    // SPA fallback for app routes (never for asset-looking paths)
    if (!path.extname(p) && serveStatic(req, res, '/')) return;
  }
  res.writeHead(404, { ...baseHeaders(req), 'content-type': 'text/plain' });
  res.end('Not found');
};

const server = tlsOn
  ? https.createServer({ cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key), minVersion: 'TLSv1.2' }, handler)
  : http.createServer(handler);
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p.startsWith('/wisp/') || p.startsWith('/ws/')) return proxyUpgrade(req, socket, head);
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});
server.listen(cfg.ports.frontend, cfg.bind.frontend, () => {
  console.log(`[gnito] frontend v${VERSION} on ${tlsOn ? 'https' : 'http'}://${cfg.bind.frontend}:${cfg.ports.frontend} → backend 127.0.0.1:${cfg.ports.backend}`);
});
