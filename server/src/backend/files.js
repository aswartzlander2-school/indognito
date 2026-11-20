// File explorer API over the user's workspace directory (the same folder the terminal uses).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, send, readJson, str } from '../lib/http.js';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
};
const TEXT = /^(txt|md|json|js|mjs|ts|py|sh|c|h|cpp|go|rs|java|rb|php|css|html|xml|yml|yaml|toml|ini|cfg|conf|log|csv|sql|env|gitignore)$/i;

async function realInside(root, p) {
  const rroot = await fsp.realpath(root);
  let probe = p;
  for (;;) {
    try { const r = await fsp.realpath(probe); return r === rroot || r.startsWith(rroot + path.sep); }
    catch { const up = path.dirname(probe); if (up === probe) return false; probe = up; }
  }
}

export async function resolve(root, rel) {
  if (typeof rel !== 'string') rel = '/';
  if (rel.includes('\0')) throw new HttpError(400, 'Invalid path');
  const norm = path.posix.normalize('/' + rel.replace(/\\/g, '/'));
  const abs = path.join(root, ...norm.split('/').filter(Boolean));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'Path is outside your workspace');
  if (!(await realInside(root, abs))) throw new HttpError(403, 'Path leaves your workspace through a link');
  return { abs, rel: norm };
}

function modeString(st) {
  const m = st.mode, t = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const r = (b, c) => (m & b ? c : '-');
  return t + r(256, 'r') + r(128, 'w') + r(64, 'x') + r(32, 'r') + r(16, 'w') + r(8, 'x') + r(4, 'r') + r(2, 'w') + r(1, 'x');
}

function validName(n) {
  n = str(n, 'Name', { min: 1, max: 255 });
  if (n === '.' || n === '..' || /[/\\\0]/.test(n)) throw new HttpError(400, 'Names cannot contain slashes or be "." or ".."');
  return n;
}

export function registerFileRoutes(router, { workspaces, needUser, getLimits, auditFn }) {
  const ctx = async (req, q) => {
    const user = needUser(req);
    const root = workspaces.ensure(user);
    return { user, root, ...(await resolve(root, q)) };
  };
  const quota = async (user, extra = 0) => {
    const lim = getLimits(user.id).storage_mb * 1024 * 1024;
    const used = await workspaces.usage(user.id, 0);
    if (used + extra > lim) throw new HttpError(507, `Storage limit reached (${(used / 1048576).toFixed(1)} MB of ${(lim / 1048576).toFixed(0)} MB used).`);
    return { used, lim };
  };

  router.get('/api/files/list', async (req, res, { query }) => {
    const { abs, rel, user } = await ctx(req, query.get('path') || '/');
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new HttpError(404, 'Folder not found');
    if (!st.isDirectory()) throw new HttpError(400, 'Not a folder');
    const entries = [];
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      try {
        const s = await fsp.lstat(path.join(abs, e.name));
        entries.push({ name: e.name, type: s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file', size: s.size, mtime: s.mtimeMs, mode: modeString(s), perm: (s.mode & 0o777).toString(8) });
      } catch { /* vanished */ }
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    const used = await workspaces.usage(user.id);
    send(res, 200, { path: rel, entries, usage: { used, max: getLimits(user.id).storage_mb * 1048576 } });
  });

  router.post('/api/files/mkdir', async (req, res) => {
    const b = await readJson(req);
    const { abs, rel, user } = await ctx(req, path.posix.join(b.path || '/', validName(b.name)));
    await quota(user, 4096);
    await fsp.mkdir(abs).catch((e) => { throw new HttpError(e.code === 'EEXIST' ? 409 : 400, e.code === 'EEXIST' ? 'Something with that name already exists' : e.message); });
    workspaces.invalidate(user.id); send(res, 200, { ok: true, path: rel });
  });

  router.post('/api/files/create', async (req, res) => {
    const b = await readJson(req, 2 << 20);
    const content = typeof b.content === 'string' ? b.content : '';
    const { abs, rel, user } = await ctx(req, path.posix.join(b.path || '/', validName(b.name)));
    await quota(user, Buffer.byteLength(content));
    try { await fsp.writeFile(abs, content, { flag: b.overwrite ? 'w' : 'wx' }); }
    catch (e) { throw new HttpError(e.code === 'EEXIST' ? 409 : 400, e.code === 'EEXIST' ? 'A file with that name already exists' : e.message); }
    workspaces.invalidate(user.id); send(res, 200, { ok: true, path: rel });
  });

  router.put('/api/files/upload', async (req, res, { query }) => {
    const { abs, user } = await ctx(req, query.get('path'));
    const len = Number(req.headers['content-length'] || 0);
    const { used, lim } = await quota(user, len);
    const tmp = abs + `.gnito-upload-${process.pid}-${Date.now()}`;
    let written = 0;
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    try {
      await pipeline(req, async function* (src) {
        for await (const chunk of src) {
          written += chunk.length;
          if (used + written > lim) throw new HttpError(507, 'Upload would exceed your storage limit');
          yield chunk;
        }
      }, out);
      await fsp.rename(tmp, abs);
    } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    workspaces.invalidate(user.id); send(res, 200, { ok: true, size: written });
  });

  router.post('/api/files/delete', async (req, res) => {
    const b = await readJson(req);
    const { abs, rel, user, root } = await ctx(req, b.path);
    if (abs === root) throw new HttpError(400, 'You cannot delete your workspace root');
    await fsp.rm(abs, { recursive: true, force: true });
    workspaces.invalidate(user.id); auditFn(user, 'files.delete', rel, null, req);
    send(res, 200, { ok: true });
  });

  router.post('/api/files/rename', async (req, res) => {
    const b = await readJson(req);
    const from = await ctx(req, b.path);
    const to = await ctx(req, path.posix.join(path.posix.dirname(from.rel), validName(b.name)));
    if (from.abs === from.root) throw new HttpError(400, 'You cannot rename your workspace root');
    if (fs.existsSync(to.abs)) throw new HttpError(409, 'Something with that name already exists');
    await fsp.rename(from.abs, to.abs);
    send(res, 200, { ok: true, path: to.rel });
  });

  router.post('/api/files/chmod', async (req, res) => {
    const b = await readJson(req);
    if (process.platform === 'win32') throw new HttpError(400, 'Permissions are managed by Windows on this host');
    if (!/^[0-7]{3}$/.test(String(b.mode))) throw new HttpError(400, 'Mode must be three octal digits, like 644');
    const { abs } = await ctx(req, b.path);
    await fsp.chmod(abs, parseInt(b.mode, 8));
    send(res, 200, { ok: true });
  });

  const serve = (disposition) => async (req, res, { query }) => {
    const { abs, rel } = await ctx(req, query.get('path'));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, 'File not found');
    const name = path.posix.basename(rel);
    const ext = name.split('.').pop().toLowerCase();
    if (disposition === 'inline' && query.get('as') === 'text') {
      if (st.size > 1 << 20) throw new HttpError(413, 'File is too large to preview (1 MB max)');
      const buf = await fsp.readFile(abs);
      const binary = buf.subarray(0, 8000).includes(0);
      return send(res, 200, { kind: binary ? 'binary' : 'text', content: binary ? '' : buf.toString('utf8'), size: st.size });
    }
    const type = disposition === 'inline' ? MIME[ext] || (TEXT.test(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream') : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type, 'content-length': st.size, 'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'private, no-store',
    });
    await pipeline(fs.createReadStream(abs), res);
  };
  router.get('/api/files/download', serve('attachment'));
  router.get('/api/files/preview', serve('inline'));
}

// VM-backed File Explorer: when the terminal runtime is a MicroVM-Playground microVM, the File
// Explorer operates on that same per-user VM (over the server's SFTP bridge) instead of the host
// workspace — so files and the terminal share the isolated VM disk and the host is never touched.
// MicroVM-Playground's file API exposes only list/read/write/download, so folder/upload/rename/
// delete/permission operations are not available here (do those from the terminal in the VM).
export function registerMachineFileRoutes(router, { machines, needUser }) {
  const notSupported = (op) => { throw new HttpError(501, `${op} is not available for microVM files — use the terminal (it is the same machine).`); };

  router.get('/api/files/list', async (req, res, { query }) => {
    const user = needUser(req);
    const path = query.get('path') || '/';
    const r = await machines.list(user, path);
    const entries = (r.entries || []).map((e) => ({
      name: e.name, type: e.directory ? 'dir' : e.symlink ? 'link' : 'file',
      size: e.size || 0, mtime: 0, mode: '', perm: '',
    })).sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    send(res, 200, { path: r.path || path, entries, usage: { used: 0, max: 0 }, machine: true });
  });

  router.get('/api/files/preview', async (req, res, { query }) => {
    const user = needUser(req);
    const path = query.get('path');
    if (query.get('as') === 'text') {
      try { const r = await machines.read(user, path); send(res, 200, { kind: 'text', content: r.content || '', size: (r.content || '').length }); }
      catch (e) { if (/not utf-8/i.test(e.message)) return send(res, 200, { kind: 'binary', content: '', size: 0 }); throw new HttpError(400, e.message); }
      return;
    }
    const buf = await machines.download(user, path);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.split('/').pop() || 'file')}`, 'cache-control': 'private, no-store' });
    res.end(buf);
  });

  router.get('/api/files/download', async (req, res, { query }) => {
    const user = needUser(req);
    const path = query.get('path');
    const buf = await machines.download(user, path);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop() || 'file')}`, 'cache-control': 'private, no-store' });
    res.end(buf);
  });

  router.post('/api/files/create', async (req, res) => {
    const user = needUser(req);
    const b = await readJson(req, 2 << 20);
    const name = str(b.name, 'Name', { min: 1, max: 255 });
    const path = (b.path === '/' ? '' : b.path || '') + '/' + name;
    await machines.write(user, path.replace(/\/+/g, '/'), typeof b.content === 'string' ? b.content : '');
    send(res, 200, { ok: true, path });
  });

  // Browser → machine: save a downloaded file into the user's VM so it appears in the terminal/files.
  router.post('/api/machine/save', async (req, res) => {
    const user = needUser(req);
    const b = await readJson(req, 8 << 20);
    const path = str(b.path, 'Path', { min: 1, max: 4096 });
    await machines.write(user, path, typeof b.content === 'string' ? b.content : '');
    send(res, 200, { ok: true });
  });

  router.post('/api/files/mkdir', () => notSupported('Creating folders'));
  router.put('/api/files/upload', () => notSupported('Uploading'));
  router.post('/api/files/delete', () => notSupported('Deleting'));
  router.post('/api/files/rename', () => notSupported('Renaming'));
  router.post('/api/files/chmod', () => notSupported('Changing permissions'));
}
